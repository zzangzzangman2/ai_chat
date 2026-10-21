const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { createInactivityWatchdog, readDoneOnlyChatResponse } = require("../../../../../dos-client/dos-chat.js");
const mod = { exports: {} };
Function("module", "exports", ts.transpileModule(fs.readFileSync(path.join(__dirname, "progressResponse.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(mod, mod.exports);
const { createProgressResponse } = mod.exports;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("preparation pings prevent inactivity expiry until the existing stream supplies the saved done body", async () => {
  const watchdog = createInactivityWatchdog(undefined, 120);
  const encoder = new TextEncoder();
  let calls = 0;
  const phases = [];
  try {
    const response = createProgressResponse(watchdog.signal, async () => {
      calls++;
      await delay(300); // Longer than the scaled inactivity timeout.
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "done", assistant: { id: "saved", content: "완료" } }) + "\n"));
          controller.close();
        },
      }), { headers: { "content-type": "application/x-ndjson" } });
    }, 15);
    assert.equal(calls, 0, "preparation must start after the initial response can flush");
    const done = await readDoneOnlyChatResponse(response, {
      onActivity: () => watchdog.touch(),
      onEvent: (event) => { if (event.type === "ping") phases.push(event.phase); },
    });
    assert.equal(done.assistant.id, "saved");
    assert.equal(calls, 1);
    assert.ok(phases.filter((phase) => phase === "preparing").length >= 2);
    assert.equal(watchdog.didTimeout(), false);
  } finally { watchdog.stop(); }
});

test("preparation errors remain errors without a fake successful completion or retry", async () => {
  let calls = 0;
  const response = createProgressResponse(new AbortController().signal, async () => {
    calls++;
    return Response.json({ error: "chat missing" }, { status: 404 });
  });
  await assert.rejects(readDoneOnlyChatResponse(response), /chat missing/);
  assert.equal(calls, 1);
  const failure = createProgressResponse(new AbortController().signal, async () => { throw new Error("preparation failed"); });
  await assert.rejects(readDoneOnlyChatResponse(failure), /preparation failed/);
});

test("reader cancellation during preparation aborts work and cancels any late response", async () => {
  let complete;
  let signal;
  let lateCanceled = false;
  const response = createProgressResponse(new AbortController().signal, (value) => {
    signal = value;
    return new Promise((resolve) => { complete = resolve; });
  });
  const reader = response.body.getReader();
  await reader.read();
  await new Promise(setImmediate);
  await reader.cancel("manual cancel");
  assert.equal(signal.aborted, true);
  complete(new Response(new ReadableStream({ cancel() { lateCanceled = true; } })));
  await new Promise(setImmediate);
  assert.equal(lateCanceled, true);
});

test("parent abort during generation cancels the upstream reader", async () => {
  const parent = new AbortController();
  let canceled = false;
  const response = createProgressResponse(parent.signal, async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  }), { headers: { "content-type": "application/x-ndjson" } }));
  const reader = response.body.getReader();
  await reader.read();
  await new Promise(setImmediate);
  parent.abort("Ctrl+C");
  assert.equal((await reader.read()).done, true);
  assert.equal(canceled, true);
});

test("a genuinely silent generation still times out instead of being hidden by preparation pings", async () => {
  const watchdog = createInactivityWatchdog(undefined, 50);
  let canceled = false;
  try {
    const response = createProgressResponse(watchdog.signal, async () => new Response(new ReadableStream({
      cancel() { canceled = true; },
    }), { headers: { "content-type": "application/x-ndjson" } }), 10);
    await assert.rejects(readDoneOnlyChatResponse(response, { onActivity: () => watchdog.touch() }), /완료되기 전에 연결이 끊겼습니다/);
    assert.equal(watchdog.didTimeout(), true);
    assert.equal(canceled, true);
  } finally { watchdog.stop(); }
});

test("an already canceled request never starts preparation", async () => {
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  const response = createProgressResponse(parent.signal, async () => { calls++; return Response.json({}); });
  assert.equal(await response.text(), "");
  assert.equal(calls, 0);
});
