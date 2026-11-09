"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { probeAppPort, findHealthyAppPort } = require("./server-discovery.js");

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

test("all 21 dead ports start probing without waiting for earlier requests", async () => {
  const pending = [];
  const candidates = Array.from({ length: 21 }, (_, i) => 3000 + i);
  const result = findHealthyAppPort(candidates, { probe: (port) => new Promise(resolve => pending.push({ port, resolve })) });
  assert.deepEqual(pending.map(p => p.port), candidates);
  pending.forEach(p => p.resolve(false));
  assert.equal(await result, 0);
});

test("saved-port priority survives out-of-order completion and duplicate ports", async () => {
  const pending = [];
  const result = findHealthyAppPort([3005, 3000, 3005, 0, -1, 70000], { probe: (port) => new Promise(resolve => pending.push({ port, resolve })) });
  assert.deepEqual(pending.map(p => p.port), [3005, 3000]);
  pending[1].resolve(true);
  pending[0].resolve(true);
  assert.equal(await result, 3005);
});

test("a real unauthenticated app response is healthy but a different local server is not", async (t) => {
  const good = await fixture(t, (req, res) => {
    assert.equal(req.url, "/api/auth/me");
    res.end(JSON.stringify({ ok: true, user: null }));
  });
  const unrelated = await fixture(t, (_req, res) => res.end("Local unrelated server"));
  assert.equal(await findHealthyAppPort([unrelated, good]), good);
});

test("hanging responses, including incomplete bodies, have an absolute deadline", async (t) => {
  const port = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{"ok":'); });
  const started = Date.now();
  assert.equal(await probeAppPort(port, 80), false);
  assert(Date.now() - started < 1500, "a partial body must not hold startup open");
});

test("failed probes do not hide a healthy neighboring app", async (t) => {
  const unavailable = await fixture(t, (_req, res) => { res.statusCode = 503; res.end("starting"); });
  const app = await fixture(t, (_req, res) => res.end('{"ok":true,"user":null}'));
  assert.equal(await findHealthyAppPort([unavailable, app]), app);
});
