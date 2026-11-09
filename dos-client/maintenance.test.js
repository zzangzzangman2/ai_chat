"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { createMaintenanceTransport } = require("./maintenance-transport.js");
const { maintenanceRetryDetails } = require("./maintenance-result.js");
const source = fs.readFileSync(path.join(__dirname, "dos-chat.js"), "utf8");
const ast = ts.createSourceFile("dos-chat.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionSource(name) {
  return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
}
function jobFixture(payload, jsonError = false, status = 200) {
  const job = { chatId: "chat", mode: "all" };
  const state = { maintenancePaused: false, maintenanceGeneration: 1, pendingMemoryRefreshes: new Map([["chat", job]]), pendingCharacterRefreshes: new Map() };
  const notices = [];
  const run = Function("state", "maintenanceTransport", "updateMaintenanceTiming", "isAbortLike", "reportMaintenanceFailure", "reportMaintenanceSuccess", "maintenanceRetryDetails",
    functionSource("runBackgroundMaintenanceJob") + "\nreturn runBackgroundMaintenanceJob;"
  )(state, { request: async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (jsonError) throw new Error("truncated"); return payload; } }) }, () => {}, () => false,
    (kind, reason, label) => notices.push({ kind, reason, label }), () => {}, maintenanceRetryDetails);
  return { state, job, notices, run: () => run("memory", "chat", job, 1) };
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

test("graph throttling reports the saved summary separately and applies bounded backoff", async () => {
  const payload = { ok: true, skipped: true, morePending: true, reason: "pending_graph_retry",
    summarizedEndTurn: 747, boundaryEndTurn: 747, structuredGraphParsed: false,
    structuredGraphFailure: { code: "rate_limited", retryAfterMs: 60_000 } };
  const f = jobFixture(payload);
  for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    assert.equal(await f.run(), "retry");
    assert.equal(f.job.retryDelayMs, delay);
    assert.equal(f.state.pendingMemoryRefreshes.size, 1);
  }
  assert.equal(f.notices[0].label, "인물·관계");
  assert.match(f.notices[0].reason, /747턴까지 저장됨/);
  assert.match(f.notices[0].reason, /429/);
});

test("timeouts remain distinct from quota errors and new summary progress resets retry delay", async () => {
  const result = maintenanceRetryDetails({ reason: "pending_graph_retry", summarizedEndTurn: 747,
    structuredGraphFailure: { code: "timeout", retryAfterMs: 30_000 } });
  assert.match(result.reason, /시간 초과/);
  assert.doesNotMatch(result.reason, /429/);
  const f = jobFixture({ ok: true, morePending: true, refreshed: true });
  f.job.attempts = 3; f.job.retryDelayMs = 240_000;
  assert.equal(await f.run(), "more");
  assert.equal(f.job.retryDelayMs, 0);
  assert.equal(f.job.attempts, 0);
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

test("authorization and provider failures remain queued and are visible", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const f = jobFixture({ ok: false }, false, status);
    assert.equal(await f.run(), "retry");
    assert.equal(f.state.pendingMemoryRefreshes.get("chat"), f.job);
    assert.match(f.notices[0].reason, new RegExp(String(status)));
  }
});

function transportFixture() {
  let clock = 0;
  const available = new Set(["http://chat", "http://worker"]);
  const calls = [];
  const routes = [];
  const transport = createMaintenanceTransport({
    primaryBase: "http://chat", maintenanceBase: "http://worker",
    now: () => clock,
    onRouteChange: base => routes.push(base),
    fetchImpl: async (url, options) => {
      const base = new URL(url).origin;
      calls.push({ url, method: options?.method || "GET" });
      options?.signal?.throwIfAborted();
      if (!available.has(base)) throw new Error("connection refused");
      return { ok: true, status: 200, json: async () => url.endsWith("/api/auth/me")
        ? { ok: true, user: { email: "test@example.invalid" } }
        : { ok: true, morePending: false } };
    },
  });
  return { transport, available, calls, routes, advance: () => { clock += 31_000; } };
}

test("chat-only startup routes memory and character refreshes to the working server", async () => {
  const f = transportFixture();
  f.available.delete("http://worker");
  assert.equal(await f.transport.select(), "http://chat");
  for (const path of ["/api/chat/memory/refresh", "/api/chat/characters/refresh"]) {
    await f.transport.request(path, { method: "POST" });
    assert.equal(f.calls.at(-1).url, "http://chat" + path);
  }
  assert.deepEqual(f.routes, ["http://chat"]);
});

test("rechecks the worker and automatically returns to it after recovery", async () => {
  const f = transportFixture();
  f.available.delete("http://worker");
  await f.transport.select();
  f.available.add("http://worker");
  f.advance();
  assert.equal(await f.transport.select(), "http://worker");
  assert.deepEqual(f.routes, ["http://chat", "http://worker"]);
});

test("failed POST is not immediately replayed; the next queued attempt reselects a server", async () => {
  const f = transportFixture();
  await f.transport.select();
  f.available.delete("http://worker");
  await assert.rejects(f.transport.request("/api/chat/memory/refresh", { method: "POST" }));
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  await f.transport.request("/api/chat/memory/refresh", { method: "POST" });
  assert.equal(f.calls.at(-1).url, "http://chat/api/chat/memory/refresh");
});

test("both unavailable is reported once and recovery is discovered without restarting DOS", async () => {
  const f = transportFixture();
  f.available.clear();
  await assert.rejects(f.transport.select(), /memory_server_unavailable/);
  await assert.rejects(f.transport.select(), /memory_server_unavailable/);
  assert.deepEqual(f.routes, [null]);
  f.available.add("http://chat");
  assert.equal(await f.transport.select(), "http://chat");
});

test("a successful HTTP response without app authentication is not a healthy worker", async () => {
  const f = createMaintenanceTransport({ primaryBase: "http://chat", maintenanceBase: "http://worker",
    fetchImpl: async url => ({ ok: true, json: async () => url.startsWith("http://worker")
      ? { ok: true, user: null } : { ok: true, user: { email: "test@example.invalid" } } }),
  });
  assert.equal(await f.select(), "http://chat");
});

test("user cancellation prevents probing or replaying maintenance requests", async () => {
  const f = transportFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.transport.request("/api/chat/memory/refresh", { method: "POST", signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.calls.length, 0);
});

test("a hung health probe times out and uses the chat server", async () => {
  const transport = createMaintenanceTransport({ primaryBase: "http://chat", maintenanceBase: "http://worker", probeTimeoutMs: 25,
    fetchImpl: async (url, { signal }) => {
      if (url.startsWith("http://worker")) return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { ok: true, json: async () => ({ ok: true, user: { email: "test@example.invalid" } }) };
    },
  });
  const keepAlive = setInterval(() => {}, 100);
  try { assert.equal(await transport.select(), "http://chat"); }
  finally { clearInterval(keepAlive); }
});

function manualRefreshFixture(payload, networkError = null) {
  const queued = [], printed = [];
  const refresh = Function("state", "maintenanceTransport", "queueBackgroundMaintenance", "console", "isAbortLike",
    functionSource("refreshMemory") + "\nreturn refreshMemory;"
  )({ chatId: "chat" }, { request: async () => {
    if (networkError) throw networkError;
    return { ok: true, status: 200, json: async () => payload };
  } }, job => queued.push(job), { log: message => printed.push(message) }, error => error.name === "AbortError");
  return { refresh, queued, printed };
}

test("manual refresh reports incomplete work truthfully and queues the remaining blocks", async () => {
  const f = manualRefreshFixture({ ok: true, summarizedEndTurn: 687, boundaryEndTurn: 732, morePending: true });
  await f.refresh();
  assert.equal(f.queued.length, 1);
  assert.match(f.printed.at(-1), /687\/732/);
  assert.doesNotMatch(f.printed.at(-1), /완료/);
});

test("manual network failure retains work, while intentional cancellation does not enqueue it", async () => {
  const f = manualRefreshFixture(null, new Error("connection refused"));
  await assert.rejects(f.refresh());
  assert.equal(f.queued.length, 1);
  const cancelled = manualRefreshFixture(null, new DOMException("cancelled", "AbortError"));
  await assert.rejects(cancelled.refresh());
  assert.equal(cancelled.queued.length, 0);
});
