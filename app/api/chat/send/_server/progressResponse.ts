/** Keep the DOS connection active during preparation as well as generation.
 * This wraps the existing response; it does not start or retry model calls.
 */
export function createProgressResponse(
  requestSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<Response>,
  heartbeatMs = 15_000
) {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let close = () => {};
  const cleanup = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    requestSignal.removeEventListener("abort", onAbort);
  };
  const cancel = (reason?: unknown) => {
    abort.abort(reason);
    void reader?.cancel(reason).catch(() => {});
    cleanup();
  };
  const onAbort = () => {
    cancel(requestSignal.reason);
    close();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      const enqueue = (chunk: Uint8Array) => {
        if (!closed) controller.enqueue(chunk);
      };
      const event = (value: unknown) => enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      if (requestSignal.aborted) {
        onAbort();
        return;
      }
      requestSignal.addEventListener("abort", onAbort, { once: true });
      event({ type: "ping", phase: "preparing", t: Date.now() });
      timer = setInterval(() => event({ type: "ping", phase: "preparing", t: Date.now() }), heartbeatMs);
      // Let the response headers and initial signal flush before synchronous
      // prompt preparation. Timers alone cannot run while the event loop is busy.
      setImmediate(async () => {
        try {
          if (abort.signal.aborted) return;
          const response = await run(abort.signal);
          if (abort.signal.aborted) {
            await response.body?.cancel();
            return;
          }
          if (response.headers.get("content-type")?.includes("application/x-ndjson") && response.body) {
            // The existing generation stream owns keepalives from here on.
            if (timer) clearInterval(timer);
            timer = undefined;
            reader = response.body.getReader();
            while (!abort.signal.aborted) {
              const next = await reader.read();
              if (next.done) break;
              enqueue(next.value);
            }
          } else {
            const payload = await response.json();
            event(response.ok
              ? { ...payload, type: "done" }
              : { type: "error", error: payload.error || `HTTP ${response.status}`, detail: payload.detail, status: response.status });
          }
        } catch (error) {
          if (!abort.signal.aborted) event({ type: "error", error: error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다." });
        } finally {
          reader?.releaseLock();
          close();
        }
      });
    },
    cancel(reason) {
      closed = true;
      cancel(reason);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
