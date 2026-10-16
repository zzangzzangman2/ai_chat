"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function fixture(apiJson) {
  const source = fs.readFileSync(path.join(__dirname, "dos-chat.js"), "utf8");
  const body = source.slice(source.indexOf("async function deleteRecent(arg)"), source.indexOf("function isAbortLike(error)"));
  const state = { chatId: "chat", pendingCharacterRefreshes: new Map([["chat:a1", {}], ["other:a1", {}]]) };
  const events = [];
  const run = Function("state", "dbAll", "apiJson", "pauseBackgroundMaintenance", "resumeBackgroundMaintenance", "showHistory", "console", `${body}; return deleteRecent;`)(
    state, () => [{ id: "a1", role: "assistant" }, { id: "u1", role: "user" }], apiJson,
    options => events.push(["pause", options]), () => events.push(["resume"]),
    async () => events.push(["history"]), { log: text => events.push(["log", text]) }
  );
  return { run, state, events };
}

test("DOS undo deletes each pair once, cancels its queued memory, and reports actual deleted count", async () => {
  const calls = [];
  const f = fixture(async (...args) => { calls.push(args); return { ok: true, deleted: ["a1", "u1"] }; });
  await f.run("1");
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /messageId=a1$/);
  assert.equal(f.state.pendingCharacterRefreshes.has("chat:a1"), false);
  assert.equal(f.state.pendingCharacterRefreshes.has("other:a1"), true);
  assert.deepEqual(f.events[0], ["pause", { abortRunning: true }]);
  assert.match(f.events.find(e => e[0] === "log")[1], /1쌍 \(2개 메시지\)/);
  assert.equal(f.events.at(-1)[0], "resume");
});

test("DOS undo propagates cleanup failure without printing deletion success", async () => {
  const f = fixture(async () => { throw new Error("cleanup failed"); });
  await assert.rejects(f.run("1"), /cleanup failed/);
  assert.equal(f.events.some(e => e[0] === "log"), false);
  assert.equal(f.state.pendingCharacterRefreshes.has("chat:a1"), true);
  assert.equal(f.events.at(-1)[0], "resume");
});
