import { buildStreamLoopConfig, findCleanBoundaryForStream, hasUnclosedFence } from "./streamCut";

export type ConsumeMainStreamDeltasParams = {
  stream: AsyncIterable<any>;
  bodyMaxChars: number;
  modelName: string;
  metaMaxChars: number;
  authorWantsMetaPanel: boolean;
  metaRequired: string;
  metaFenceTemplateHint: string;
  metaLabelHint: string;
  streamDebug: boolean;
  streamTag: string;
  tag: string;
  safeEnqueue: (obj: any) => boolean;
  isMetaFenceClosed: (text: string) => boolean;
  onMaybeStartMetaOverlap?: (args: { raw: string; metaStarted: boolean; capReached: boolean }) => void;
};

export type ConsumeMainStreamDeltasResult = {
  raw: string;
  hadDelta: boolean;
};

export async function consumeMainStreamDeltas(
  params: ConsumeMainStreamDeltasParams
): Promise<ConsumeMainStreamDeltasResult> {
  const loopCfg = buildStreamLoopConfig({
    bodyMaxChars: params.bodyMaxChars,
    modelName: params.modelName,
    metaMaxChars: params.metaMaxChars,
    authorWantsMetaPanel: params.authorWantsMetaPanel,
    metaRequired: String(params.metaRequired || ""),
    metaFenceTemplateHint: String(params.metaFenceTemplateHint || ""),
    metaLabelHint: String(params.metaLabelHint || ""),
  });
  const bodyCapChars = loopCfg.bodyCapChars;
  const fenceReserve = loopCfg.fenceReserve;
  const capForText = loopCfg.capForText;
  const isG3Pro = loopCfg.isG3Pro;
  const cleanWindow = loopCfg.cleanWindow;
  const metaFenceMaxChars = loopCfg.metaFenceMaxChars;
  const metaScanGraceChars = loopCfg.metaScanGraceChars;
  const allowMetaAfterCap = loopCfg.allowMetaAfterCap;
  const metaOpenRe = loopCfg.metaOpenRe;

  let raw = "";
  let hadDelta = false;
  let lastEmitAt = Date.now();
  let stoppedEarly = false;

  let capReached = false;
  let metaStarted = false;
  let metaStartIdx = -1;
  let metaEmitted = 0;
  let pendingAfterCap = "";

  for await (const delta of params.stream) {
    const d = String(delta ?? "");
    if (!d) continue;

    // NOTE: 이전 버전은 STATUS fenced block이 닫히는 순간 스트리밍을 중단(EARLY STOP)했지만,
    // gemini-3-pro 계열에서 본문이 짧게 끊기는 원인이 되었다.
    // STATUS/meta 출력은 후처리(맨 마지막 정리) 단계에서 처리하므로 여기서는 중단하지 않는다.
    let out = d;
    let scanRemainder = "";

    // If we're already inside a meta fenced block, allow it to stream through (bounded).
    if (metaStarted) {
      const remainingMeta = Math.max(0, metaFenceMaxChars - metaEmitted);
      if (remainingMeta <= 0) {
        stoppedEarly = true;
        break;
      }
      if (out.length > remainingMeta) {
        out = out.slice(0, remainingMeta);
        stoppedEarly = true;
      }
    } else if (capForText > 0) {
      if (capReached) {
        scanRemainder = out;
        out = "";
      } else {
        const remaining = capForText - raw.length;
        if (remaining <= 0) {
          capReached = true;
          scanRemainder = out;
          out = "";
        } else if (out.length > remaining) {
          capReached = true;
          const original = out;
          const initial = original.slice(0, remaining);
          const candidate = raw + initial;
          const minPos = Math.max(raw.length, capForText - cleanWindow);
          const cutIdx = findCleanBoundaryForStream(candidate, minPos, isG3Pro);
          const consumed = cutIdx >= raw.length && cutIdx <= candidate.length ? cutIdx - raw.length : initial.length;
          out = original.slice(0, consumed);
          scanRemainder = original.slice(consumed);

          // If we cut inside an unclosed fence, close it within reserved budget.
          if (fenceReserve > 0) {
            let cand2 = raw + out;
            if (hasUnclosedFence(cand2)) {
              cand2 = cand2.slice(0, capForText).trimEnd();
              cand2 = (cand2.trimEnd() + "\n```").trimEnd();
              out = cand2.slice(raw.length);
            }
          }
        }
      }
    }

    // Emit body/meta chunk (if any)
    if (out) {
      const combined = raw + out;
      raw = combined;
      const now = Date.now();
      const gap = now - lastEmitAt;
      lastEmitAt = now;

      hadDelta = true;
      if (params.streamDebug) console.debug(`${params.streamTag} delta recv (${params.tag}) (gap=${gap}ms len=${out.length})`);
      params.safeEnqueue({ type: "delta", text: out });
    }

    // Track meta fence start if it appears in the emitted stream
    if (!metaStarted && metaOpenRe && metaOpenRe.test(raw)) {
      metaStarted = true;
      const idx = raw.search(metaOpenRe);
      metaStartIdx = Math.max(0, idx);
      metaEmitted = Math.max(0, raw.length - metaStartIdx);
    }

    // If body cap reached, keep scanning the non-emitted tail for a meta fence start.
    if (!metaStarted && capReached && allowMetaAfterCap && metaOpenRe) {
      if (scanRemainder) pendingAfterCap += scanRemainder;
      if (pendingAfterCap.length > metaScanGraceChars) {
        pendingAfterCap = pendingAfterCap.slice(-metaScanGraceChars);
      }

      const openAt = pendingAfterCap.search(metaOpenRe);
      if (openAt >= 0) {
        const metaChunkFull = pendingAfterCap.slice(openAt);
        pendingAfterCap = "";
        metaStarted = true;

        const rawBeforeLen = raw.length;
        let metaChunk = metaChunkFull;
        if (metaChunk.length > metaFenceMaxChars) {
          metaChunk = metaChunk.slice(0, metaFenceMaxChars);
          stoppedEarly = true;
        }

        raw = raw + metaChunk;
        const localFence = metaChunk.indexOf("```");
        metaStartIdx = rawBeforeLen + (localFence >= 0 ? localFence : 0);
        metaEmitted = Math.max(0, raw.length - metaStartIdx);
        lastEmitAt = Date.now();
        hadDelta = true;

        if (params.streamDebug) console.debug(`${params.streamTag} meta passthru (${params.tag}) (len=${metaChunk.length})`);
        params.safeEnqueue({ type: "delta", text: metaChunk });

        const metaSub = raw.slice(Math.max(0, metaStartIdx));
        if (params.isMetaFenceClosed(metaSub)) {
          stoppedEarly = true;
          break;
        }
      } else if (pendingAfterCap.length >= metaScanGraceChars) {
        // No meta found within a large tail buffer.
        // - If meta is REQUIRED, keep scanning until the model ends (but cap memory).
        // - If meta is optional, stop to avoid runaway.
        if (params.metaRequired === "YES") {
          pendingAfterCap = pendingAfterCap.slice(-metaScanGraceChars);
        } else {
          stoppedEarly = true;
          break;
        }
      }
    }

    // If we are emitting meta, update counters and stop once it is fully closed.
    if (metaStarted) {
      metaEmitted = Math.max(0, raw.length - metaStartIdx);
      const metaSub = raw.slice(Math.max(0, metaStartIdx));
      if (params.isMetaFenceClosed(metaSub)) {
        stoppedEarly = true;
        break;
      }
    }

    if (params.onMaybeStartMetaOverlap) {
      params.onMaybeStartMetaOverlap({ raw, metaStarted, capReached });
    }

    if (stoppedEarly) break;
  }

  // If the model ended naturally but left a fenced meta/status block open, close it (within *body* budget).
  if (!stoppedEarly && fenceReserve > 0 && hasUnclosedFence(raw) && raw.length + 4 <= bodyCapChars) {
    raw = (raw.trimEnd() + "\n```").trimEnd();
    hadDelta = true;
    params.safeEnqueue({ type: "delta", text: "\n```" });
  }

  return { raw, hadDelta };
}
