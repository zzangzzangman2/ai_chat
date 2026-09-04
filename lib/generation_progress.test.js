const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { generationProgressAfterEvent, refusalRerollNotice } = require("./generation_progress.js");

test("retry status follows actual attempt counts, not keep-alive or failed requests", () => {
  assert.equal(generationProgressAfterEvent("", { type: "ping" }), "");
  assert.equal(generationProgressAfterEvent("", { type: "error", error: "HTTP 429" }), "");
  let progress = generationProgressAfterEvent("", { type: "retry", attempt: 1, maxAttempts: 5 });
  assert.equal(progress, "응답 생성 실패 · 재시도 중… (1/5)");
  progress = generationProgressAfterEvent(progress, { type: "retry", attempt: 2, maxAttempts: 5 });
  assert.equal(progress, "응답 생성 실패 · 재시도 중… (2/5)");
  assert.equal(generationProgressAfterEvent(progress, { type: "ping" }), progress);
  assert.equal(generationProgressAfterEvent(progress, { type: "replace", text: "" }), progress);
});

test("completion, failure, and resumed story output clear retry status", () => {
  const progress = generationProgressAfterEvent("", { type: "retry", attempt: 1, maxAttempts: 5 });
  for (const event of [
    { type: "done" }, { type: "error" },
    { type: "delta", text: "본문" }, { type: "replace", text: "최종 본문" },
  ]) assert.equal(generationProgressAfterEvent(progress, event), "");
});

test("malformed progress cannot invent retry counts or inject terminal text", () => {
  for (const event of [
    { type: "retry" }, { type: "retry", attempt: 0, maxAttempts: 5 },
    { type: "retry", attempt: 6, maxAttempts: 5 },
    { type: "retry", attempt: 1.5, maxAttempts: 5 },
    { type: "retry", attempt: "\x1b[2J", maxAttempts: 5 },
  ]) assert.equal(generationProgressAfterEvent("", event), "");
});

test("server reports progress immediately before its existing retry, out of band", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/api/chat/send/route.ts"), "utf8");
  const notification = source.match(/try\s*\{\s*safeEnqueue\(\{ type: "replace", text: "" \}\);[\s\S]*?generation = await runMainGeneration\(\);/);
  assert.ok(notification, "notification must precede the existing generation call");
  const events = [];
  let calls = 0;
  const run = new Function("safeEnqueue", "runMainGeneration", "refusalRerollAttempt", "maxRerolls",
    `return (async () => { let generation; ${notification[0]} return generation; })();`);
  const result = await run((event) => events.push(event), async () => {
    assert.deepEqual(events, [
      { type: "replace", text: "" },
      { type: "retry", attempt: 2, maxAttempts: 5 },
    ]);
    calls += 1;
    return "existing generation";
  }, 2, 5);
  assert.equal(result, "existing generation");
  assert.equal(calls, 1);
  assert.equal(events.some((event) => event.type === "delta"), false);
});

test("web send and regeneration handle notices separately and reset on cancellation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/components/ChatArea.tsx"), "utf8");
  assert.equal((source.match(/generationProgressAfterEvent\(current, obj\)/g) || []).length, 2);
  assert.match(source, /const bumpSendSeq = useCallback\(\(\) => \{\s*setGenerationProgress\(""\)/);
  assert.match(source, /busy && generationProgress &&/);
  assert.match(source, /role="status" aria-live="polite"/);
});

// (2026-09-04) 버퍼드 응답은 retry 이벤트를 못 받는다. 서버가 최종 응답에 실어 보낸
// 회차를 클라이언트가 한 줄로 알려야 "재시도를 안 한다"로 보이지 않는다.
test("리롤이 없었으면 아무것도 알리지 않는다", () => {
  assert.equal(refusalRerollNotice(null), "");
  assert.equal(refusalRerollNotice({}), "");
  assert.equal(refusalRerollNotice({ refusalRerolls: 0 }), "");
  assert.equal(refusalRerollNotice({ refusalRerolls: -1 }), "");
  assert.equal(refusalRerollNotice({ refusalRerolls: "많이" }), "");
  assert.equal(refusalRerollNotice({ refusalRerolls: 1.5 }), "");
});

test("리롤 후 성공하면 회차만 알린다", () => {
  const msg = refusalRerollNotice({ refusalRerolls: 2, refusalBlocked: false });
  assert.match(msg, /2회/);
  assert.doesNotMatch(msg, /저장되지 않습니다/);
});

test("리롤을 다 쓰고도 거부면 저장하지 않았다는 것까지 알린다", () => {
  const msg = refusalRerollNotice({ refusalRerolls: 5, refusalBlocked: true });
  assert.match(msg, /5회/);
  assert.match(msg, /저장되지 않습니다/);
});
