/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTs(file, requireModule = require, globals = {}) {
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), js)(
    requireModule, loaded, loaded.exports, ...Object.values(globals)
  );
  return loaded.exports;
}

const novel = loadTs("lib/novel_export.ts");
const models = loadTs("lib/models.ts");
const cryptoHelpers = loadTs("lib/crypto.ts");
const stores = loadTs("lib/novel_export_store.ts", (id) => id === "@/lib/novel_export" ? novel : id === "@/lib/crypto" ? cryptoHelpers : require(id));
const temporaryRoots = [];
test.after(() => {
  for (const root of temporaryRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("arca-novel-route-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const rows = [1, 2].flatMap((turn) => [
  { id: `${turn}-user`, role: "user", content: `행동 ${turn} ${"가".repeat(14000)}` },
  { id: `${turn}-assistant`, role: "assistant", content: `반응 ${turn} ${"나".repeat(14000)}` },
]);

function manuscript(index) {
  return {
    text: JSON.stringify({
      novelTitle: index === 1 ? "유리문 너머의 낮" : "",
      title: `문을 연 사람 ${index}`,
      introduction: index === 1 ? "낯선 손님이 닫힌 문을 두드린다." : "",
      body: `원고 ${index}. ${"방문 앞에서 잠시 발걸음을 멈추었다. ".repeat(25)}`,
      characters: index === 1
        ? [{ name: "지은", introduction: "문을 연 사람." }]
        : [{ name: "지은", introduction: "결말의 인물." }, { name: "민수", introduction: "찾아온 손님." }],
    }),
    usage: { finishReason: "STOP" },
  };
}

function harness(generate, options = {}) {
  const requests = [];
  const pdfInputs = [];
  const timers = new Map();
  let now = 1000000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-novel-route-"));
  temporaryRoots.push(root);
  const store = options.store || stores.createNovelExportStore(root, { encode: (text) => text, decode: (text) => text });
  const sourceRows = options.rows || rows;
  class FakeDate extends Date { static now() { return now; } }
  const { POST, GET } = loadTs("app/api/chat/novel/export/route.ts", (id) => {
    if (id === "@/lib/db") return { db: { prepare: () => ({ get: () => options.missingChat ? undefined : ({ id: "chat" }), all: () => sourceRows }) } };
    if (id === "@/lib/auth") return { getSessionUser: async () => options.unauthorized ? null : ({ email: options.owner || "test@example.invalid", nickname: "테스트" }) };
    if (id === "@/lib/crypto") return { decryptIfPossible: (text) => text };
    if (id === "@/lib/models") return models;
    if (id === "@/lib/novel_export") return novel;
    if (id === "@/lib/novel_export_store") return { ...stores, novelExportStore: store };
    if (id === "@/lib/novel_pdf") return { buildNovelPdf: async (input) => { pdfInputs.push(structuredClone(input)); return options.buildPdf ? options.buildPdf(input) : Buffer.from("test pdf"); } };
    if (id === "@/lib/ai") return {
      isRefusalText: (text) => text === "거절 응답",
      generateText: async (params) => {
        requests.push(params);
        return generate ? generate(params, requests.length) : manuscript(Number(params.user.match(/중 (\d+)장/)[1]));
      },
    };
    throw new Error(`Unexpected dependency: ${id}`);
  }, {
    Date: FakeDate,
    globalThis: options.runtime || {},
    setInterval: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer; },
    clearInterval: (timer) => timers.delete(timer),
  });
  const post = (signal, payload = {}, origin = "http://localhost") => POST(new Request(`${origin}/api/chat/novel/export`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: "chat", ...payload }), signal,
  }));
  const get = (params = {}, origin = "http://localhost") => GET(new Request(`${origin}/api/chat/novel/export?${new URLSearchParams({ chatId: "chat", ...params })}`));
  return { post, get, store, sourceRows, requests, pdfInputs, timers, tick: (elapsed) => {
    now += elapsed;
    for (const { callback } of timers.values()) callback();
  } };
}

const eventsFrom = async (response) => (await response.text()).trim().split("\n").filter(Boolean).map(JSON.parse);

test("uses Argon for all chapters, keeps a slow generation alive and assembles the whole book", async () => {
  let release;
  const h = harness((_, index) => index === 1 ? new Promise((resolve) => { release = resolve; }) : manuscript(index));
  const response = await h.post();
  assert.equal(response.status, 200);
  const result = eventsFrom(response);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 15000);
  h.tick(195000);
  assert.equal(h.requests[0].opts.signal.aborted, false);
  release(manuscript(1));
  const events = await result;
  assert.equal(h.requests.length, 2);
  for (const { opts } of h.requests) {
    assert.equal(opts.model, "gemini-4-argon");
    assert.equal(opts.timeoutMs, 0);
    assert.equal(opts.responseMimeType, "application/json");
    assert.equal(opts.responseJsonSchema, novel.NOVEL_CHAPTER_RESPONSE_SCHEMA);
  }
  assert.match(h.requests[1].user, /\["지은"\]/u);
  const heartbeat = events.find((event) => event.message?.includes("195초 경과"));
  assert.equal(heartbeat.percent, 5);
  assert.equal(heartbeat.current, 1);
  assert.equal(h.pdfInputs.length, 1);
  assert.equal(h.pdfInputs[0].introduction, "낯선 손님이 닫힌 문을 두드린다.");
  assert.deepEqual(h.pdfInputs[0].characters, [
    { name: "지은", introduction: "문을 연 사람." }, { name: "민수", introduction: "찾아온 손님." },
  ]);
  assert.equal(h.pdfInputs[0].chapters.length, 2);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).filename, "유리문 너머의 낮-웹소설.pdf");
  assert.equal(h.timers.size, 0);
});

test("reports generation failures once, clears the heartbeat and releases the export lock", async () => {
  const h = harness(() => { throw new Error("모델 응답 실패"); });
  const events = await eventsFrom(await h.post());
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).error, "모델 응답 실패");
  assert.equal(h.requests.length, 1);
  assert.equal(h.pdfInputs.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal((await h.post()).status, 200);
});

test("rejects truncated manuscripts without producing a partial PDF or retrying", async () => {
  const h = harness(() => ({ ...manuscript(1), usage: { finishReason: "MAX_TOKENS" } }));
  const events = await eventsFrom(await h.post());
  assert.match(events.at(-1).error, /출력 한도에서 잘려/u);
  assert.equal(h.requests.length, 1);
  assert.equal(h.pdfInputs.length, 0);
  assert.equal(h.timers.size, 0);
});

for (const mode of ["request abort", "stream cancel"]) {
  test(`${mode} aborts the model, stops heartbeats and allows a fresh export`, async () => {
    const h = harness(({ opts }, index) => index === 1
      ? new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      : manuscript(index));
    const abort = new AbortController();
    const response = await h.post(abort.signal);
    assert.equal((await h.post()).status, 409);
    if (mode === "request abort") {
      const finished = eventsFrom(response);
      abort.abort();
      const events = await finished;
      assert.equal(events.some((event) => event.type === "error" || event.type === "done"), false);
    } else {
      await response.body.cancel();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(h.requests[0].opts.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.pdfInputs.length, 0);
    const events = await eventsFrom(await h.post());
    assert.equal(events.at(-1).type, "done");
  });
}

test("an already-aborted request does not start model generation or a heartbeat", async () => {
  const h = harness();
  const abort = new AbortController();
  abort.abort();
  await eventsFrom(await h.post(abort.signal));
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.pdfInputs.length, 0);
});

test("pause saves completed chapters, downloads without AI, and resumes the original source after a restart", async () => {
  let secondStarted;
  const waiting = new Promise((resolve) => { secondStarted = resolve; });
  const runtime = {};
  const h = harness(({ opts }, index) => index === 1 ? manuscript(1) : new Promise((resolve, reject) => {
    secondStarted();
    opts.signal.addEventListener("abort", () => reject(new Error("paused")), { once: true });
  }), { runtime });
  const response = await h.post();
  const finished = eventsFrom(response);
  await waiting;
  const history = (await (await h.get()).json()).exports;
  assert.equal(history[0].completedChapters, 1);
  assert.equal(history[0].status, "running");
  const id = history[0].id;
  const reloadedRoute = harness(undefined, { store: h.store, runtime });
  assert.equal((await reloadedRoute.post(undefined, { action: "pause", exportId: id })).status, 200);
  assert.equal(reloadedRoute.requests.length, 0);
  assert.equal((await finished).at(-1).type, "paused");
  assert.equal(h.requests[1].opts.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  const record = h.store.load("test@example.invalid", "chat", id);
  assert.equal(record.status, "paused");
  assert.equal(record.chapters.length, 1);
  const downloaded = await h.get({ exportId: id, download: "1" });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "application/pdf");
  assert.equal(h.pdfInputs[0].chapters.length, 1);
  assert.equal(h.requests.length, 2);
  assert.match(decodeURIComponent(downloaded.headers.get("content-disposition")), /1-1장\.pdf/u);
  // A new process has no in-memory job. Later chat edits must not change this book.
  const restarted = harness(undefined, { store: h.store, rows: [{ role: "user", content: "나중에 추가된 새로운 대화" }] });
  const resumed = await eventsFrom(await restarted.post(undefined, { action: "resume", exportId: id }));
  assert.equal(restarted.requests.length, 1);
  assert.match(restarted.requests[0].user, /전체 2장 중 2장/u);
  assert.match(restarted.requests[0].user, /원고 1\./u);
  assert.match(restarted.requests[0].user, /행동 2/u);
  assert.doesNotMatch(restarted.requests[0].user, /나중에 추가된/u);
  assert.equal(resumed.at(-1).chapters, 2);
  assert.equal(restarted.pdfInputs[0].chapters[0].body, record.chapters[0].body);
  assert.equal(restarted.pdfInputs[0].chapters[1].index, 2);
  assert.equal(h.store.load("test@example.invalid", "chat", id).status, "completed");
  assert.equal((await restarted.post(undefined, { action: "resume", exportId: id })).status, 409);
  assert.equal(restarted.requests.length, 1);
});

test("pausing before the first completed chapter creates a resumable record but no empty PDF", async () => {
  const h = harness(({ opts }) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(new Error("paused")), { once: true });
  }));
  const finished = eventsFrom(await h.post());
  const id = (await (await h.get()).json()).exports[0].id;
  await h.post(undefined, { action: "pause", exportId: id });
  assert.equal((await finished).at(-1).completedChapters, 0);
  assert.equal((await h.get({ exportId: id, download: "1" })).status, 409);
  assert.equal(h.pdfInputs.length, 0);
  const restarted = harness(undefined, { store: h.store });
  assert.equal((await eventsFrom(await restarted.post(undefined, { action: "resume", exportId: id }))).at(-1).chapters, 2);
});

test("a later chapter failure preserves the earlier manuscript for download and resume", async () => {
  const h = harness((_, index) => { if (index === 2) throw new Error("provider unavailable"); return manuscript(1); });
  const events = await eventsFrom(await h.post());
  assert.equal(events.at(-1).type, "error");
  const entry = (await (await h.get()).json()).exports[0];
  assert.equal(entry.status, "failed");
  assert.equal(entry.completedChapters, 1);
  assert.equal((await h.get({ exportId: entry.id, download: "1" })).status, 200);
  const restarted = harness(undefined, { store: h.store });
  await eventsFrom(await restarted.post(undefined, { action: "resume", exportId: entry.id }));
  assert.equal(restarted.requests.length, 1);
});

test("a download finishing alongside generation cannot overwrite a newly completed chapter", async () => {
  let releaseChapter;
  let secondStarted;
  let releaseDownload;
  let pdfCount = 0;
  const waiting = new Promise((resolve) => { secondStarted = resolve; });
  const h = harness((_, index) => index === 1 ? manuscript(1) : new Promise((resolve) => { releaseChapter = resolve; secondStarted(); }), {
    buildPdf: () => ++pdfCount === 1 ? new Promise((resolve) => { releaseDownload = resolve; }) : Buffer.from("complete"),
  });
  const finished = eventsFrom(await h.post());
  await waiting;
  const id = (await (await h.get()).json()).exports[0].id;
  const download = h.get({ exportId: id, download: "1" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseChapter(manuscript(2));
  await finished;
  releaseDownload(Buffer.from("partial"));
  await download;
  const record = h.store.load("test@example.invalid", "chat", id);
  assert.equal(record.chapters.length, 2);
  assert.equal(record.status, "completed");
  assert.ok(record.lastDownloadedAt);
});

test("interrupted running records become paused after restart and a new export keeps earlier histories", async () => {
  const h = harness();
  await eventsFrom(await h.post());
  const record = h.store.list("test@example.invalid", "chat")[0];
  record.status = "running";
  record.chapters.pop();
  h.store.save(record);
  const restarted = harness(undefined, { store: h.store });
  assert.equal((await (await restarted.get()).json()).exports[0].status, "paused");
  await eventsFrom(await restarted.post());
  const history = (await (await restarted.get()).json()).exports;
  assert.equal(history.length, 2);
  assert.equal(history.find((item) => item.id === record.id).completedChapters, 1);
});

test("history and control routes keep local, session and chat ownership checks", async () => {
  const h = harness();
  await eventsFrom(await h.post());
  const id = (await (await h.get()).json()).exports[0].id;
  assert.equal((await h.get({}, "https://example.invalid")).status, 403);
  assert.equal((await h.post(undefined, { action: "pause", exportId: id }, "https://example.invalid")).status, 403);
  assert.equal((await harness(undefined, { unauthorized: true, store: h.store }).get()).status, 401);
  assert.equal((await harness(undefined, { missingChat: true, store: h.store }).get()).status, 404);
  const other = harness(undefined, { owner: "other@example.invalid", store: h.store });
  assert.equal((await other.get({ exportId: id, download: "1" })).status, 404);
  assert.equal((await other.post(undefined, { action: "resume", exportId: id })).status, 404);
  assert.equal((await other.post(undefined, { action: "pause", exportId: id })).status, 404);
});
