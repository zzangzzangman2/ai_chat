"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "dos-chat.js"), "utf8");
const ast = ts.createSourceFile("dos-chat.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionSource(name) {
  return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
}
function jobFixture(payload, jsonError = false) {
  const job = { chatId: "chat", mode: "all" };
  const state = { maintenancePaused: false, maintenanceGeneration: 1, pendingMemoryRefreshes: new Map([["chat", job]]), pendingCharacterRefreshes: new Map() };
  const run = Function("state", "fetch", "MAINTENANCE_API_BASE", "updateMaintenanceTiming", "isAbortLike",
    functionSource("runBackgroundMaintenanceJob") + "\nreturn runBackgroundMaintenanceJob;"
  )(state, async () => ({ ok: true, status: 200, json: async () => { if (jsonError) throw new Error("truncated"); return payload; } }), "unused", () => {}, () => false);
  return { state, job, run: () => run("memory", "chat", job, 1) };
}
test("HTTP 200 with malformed, empty, or unsuccessful payload preserves pending memory", async () => {
  for (const [payload, jsonError] of [[null, true], [null, false], [{}, false], [{ ok: false }, false]]) {
    const f = jobFixture(payload, jsonError);
    assert.equal(await f.run(), "retry");
    assert.equal(f.state.pendingMemoryRefreshes.get("chat"), f.job);
  }
});
test("provisional summaries and stale history back off while keeping their queue entry", async () => {
  for (const payload of [{ ok: true, morePending: true, retryNeeded: true }, { ok: true, skipped: true, morePending: true }]) {
    const f = jobFixture(payload);
    assert.equal(await f.run(), "retry");
    assert.equal(f.state.pendingMemoryRefreshes.size, 1);
  }
});
test("only confirmed completion removes the same queued job", async () => {
  const completed = jobFixture({ ok: true, morePending: false });
  assert.equal(await completed.run(), "done");
  assert.equal(completed.state.pendingMemoryRefreshes.size, 0);
  const replaced = jobFixture({ ok: true, morePending: false });
  const newJob = { chatId: "chat", mode: "all" };
  replaced.state.pendingMemoryRefreshes.set("chat", newJob);
  assert.equal(await replaced.run(), "done");
  assert.equal(replaced.state.pendingMemoryRefreshes.get("chat"), newJob);
});
function restoreFixture(turns, cursor, metas = [], prefix = []) {
  const messages = [...prefix, ...Array.from({ length: turns }, () => [{ role: "user" }, { role: "assistant" }]).flat()];
  const queued = [];
  const restore = Function("state", "dbAll", "dbGet", "queueBackgroundMaintenance",
    functionSource("restorePendingMemoryRefresh") + "\nreturn restorePendingMemoryRefresh;"
  )({ chatId: "chat" }, sql => sql.includes("FROM messages") ? messages : metas.map(meta => ({ meta: JSON.stringify(meta) })), () => ({ summarizedEndTurn: cursor }), job => queued.push(job));
  return { restore, queued };
}
test("reopening a chat restores completed but unsummarized turns without another send", () => {
  const f = restoreFixture(213, 207);
  assert.equal(f.restore(), true);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].memoryRefresh.mode, "all");
});
test("reopening also restores provisional summary and graph work behind the cursor", () => {
  for (const meta of [{ deterministicFallbackUsed: true }, { summaryRepairPending: true }, { structuredGraphPending: { startTurn: 1, endTurn: 12 } }]) {
    const f = restoreFixture(300, 300, [meta]);
    assert.equal(f.restore(), true);
  }
});
test("up-to-date chats and incomplete blocks do not enqueue needless API calls", () => {
  assert.equal(restoreFixture(3, 3).restore(), false);
  assert.equal(restoreFixture(2, 0, [], [{ role: "assistant" }]).restore(), false);
  assert.equal(restoreFixture(3, 3, [{ deterministicFallbackUsed: true, summaryRepairPending: false }]).restore(), false);
});
