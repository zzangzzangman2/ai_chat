"use strict";

// Both servers expose the same authenticated refresh API. Prefer the isolated
// worker, but never strand the queue when run-dos reuses a dev/chat-only server.
function createMaintenanceTransport({
  primaryBase,
  maintenanceBase,
  fetchImpl = fetch,
  now = Date.now,
  probeTimeoutMs = 2500,
  probeIntervalMs = 30_000,
  onRouteChange = () => {},
}) {
  let activeBase = null;
  let nextProbeAt = 0;
  let lastAnnounced;

  function announce(base) {
    activeBase = base;
    if (lastAnnounced !== base) {
      onRouteChange(base, lastAnnounced);
      lastAnnounced = base;
    }
  }

  async function healthy(base, signal) {
    try {
      const timeout = AbortSignal.timeout(probeTimeoutMs);
      const response = await fetchImpl(`${base}/api/auth/me`, {
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = await response.json();
      return response.ok && body?.ok === true && Boolean(body.user?.email);
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async function select({ signal, force = false } = {}) {
    signal?.throwIfAborted();
    if (!force && activeBase && now() < nextProbeAt) return activeBase;
    for (const base of new Set([maintenanceBase, primaryBase])) {
      if (await healthy(base, signal)) {
        nextProbeAt = now() + probeIntervalMs;
        announce(base);
        return base;
      }
    }
    nextProbeAt = 0;
    announce(null);
    throw new Error("memory_server_unavailable");
  }

  async function request(apiPath, options = {}) {
    const base = await select({ signal: options.signal });
    try {
      return await fetchImpl(`${base}${apiPath}`, options);
    } catch (error) {
      // Do not immediately replay a POST whose response may have been lost.
      // The durable queue retries after backoff and rechecks both endpoints.
      nextProbeAt = 0;
      throw error;
    }
  }

  return { select, request };
}

module.exports = { createMaintenanceTransport };
