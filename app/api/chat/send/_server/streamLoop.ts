import {
  buildStreamLoopConfig,
  findCleanBoundaryForStream,
  findFirstCompleteBoundaryAfter,
  hasUnclosedFence,
} from "./streamCut";

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
  const holdbackChars = loopCfg.holdbackChars;
  const bodyOverflowMaxChars = loopCfg.bodyOverflowMaxChars;

  let raw = "";
  let hadDelta = false;
  let lastEmitAt = Date.now();
  let stoppedEarly = false;

  // Text in raw[flushedLen..] is intentionally private. It can still be repaired
  // before the append-only delta stream exposes it to the client.
  let flushedLen = 0;
  const flushTo = (targetLen: number) => {
    const end = Math.min(Math.max(targetLen, flushedLen), raw.length);
    if (end <= flushedLen) return;
    const text = raw.slice(flushedLen, end);
    flushedLen = end;
    hadDelta = true;
    params.safeEnqueue({ type: "delta", text });
  };
  const flushWithHoldback = () => flushTo(raw.length - holdbackChars);
  const flushAll = () => flushTo(raw.length);

  let capReached = false;
  let metaStarted = false;
  let metaStartIdx = -1;
  let metaEmitted = 0;
  let pendingAfterCap = "";

  const finishBodyFromPending = (continuation: string) => {
    const addition = String(continuation || "").slice(0, bodyOverflowMaxChars);
    const combined = raw + addition;
    const completeAt = findFirstCompleteBoundaryAfter(
      combined,
      Math.max(0, capForText - 1),
      combined.length
    );

    if (completeAt >= capForText) {
      raw = combined.slice(0, completeAt);
      return;
    }

    // The provider itself jumped to meta without completing the sentence. Roll
    // back only inside the private holdback; sent deltas remain append-only.
    const fallbackAt = findCleanBoundaryForStream(
      combined,
      Math.max(flushedLen, capForText - cleanWindow),
      isG3Pro
    );
    if (fallbackAt >= flushedLen) {
      raw = combined.slice(0, fallbackAt);
      return;
    }

    // If no retractable boundary exists, preserving generated continuation is
    // less destructive than the old hard cut at exactly bodyMaxChars.
    raw = combined;
  };

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
          const crossingPrefixStart = Math.max(flushedLen, raw.length - 64);
          const crossingCandidate = raw.slice(crossingPrefixStart) + original;
          const crossingOpenAt = crossingCandidate.search(metaOpenRe);

          if (crossingOpenAt >= 0) {
            const absoluteOpenAt = crossingPrefixStart + crossingOpenAt;
            if (absoluteOpenAt < raw.length) {
              // The opening fence itself straddles raw and this provider delta.
              scanRemainder = crossingCandidate.slice(crossingOpenAt);
              raw = raw.slice(0, absoluteOpenAt);
              out = "";
            } else {
              const fenceAtInDelta = absoluteOpenAt - raw.length;
              if (fenceAtInDelta <= remaining) {
                out = original.slice(0, fenceAtInDelta);
                scanRemainder = original.slice(fenceAtInDelta);
              } else {
                out = original.slice(0, remaining);
                scanRemainder = original.slice(remaining);
              }
            }
          } else {
            out = original.slice(0, remaining);
            scanRemainder = original.slice(remaining);
          }
        }
      }
    }

    // Emit body/meta chunk (if any)
    if (out) {
      raw = raw + out;
      const now = Date.now();
      const gap = now - lastEmitAt;
      lastEmitAt = now;

      if (params.streamDebug) console.debug(`${params.streamTag} delta recv (${params.tag}) (gap=${gap}ms len=${out.length})`);
      flushWithHoldback();
    }

    // Track meta fence start if it appears in the emitted stream
    if (!metaStarted && metaOpenRe && metaOpenRe.test(raw)) {
      const idx = raw.search(metaOpenRe);
      if (idx >= flushedLen) {
        const metaChunk = raw.slice(idx);
        raw = raw.slice(0, idx);
        finishBodyFromPending("");
        const bodyEnd = raw.length;
        raw = raw + metaChunk;
        const localFence = metaChunk.indexOf("```");
        metaStartIdx = bodyEnd + (localFence >= 0 ? localFence : 0);
      } else {
        metaStartIdx = Math.max(0, idx);
      }
      metaStarted = true;
      metaEmitted = Math.max(0, raw.length - metaStartIdx);
    }

    // If body cap reached, keep scanning the non-emitted tail for a meta fence start.
    if (!metaStarted && capReached && allowMetaAfterCap && metaOpenRe) {
      if (scanRemainder) pendingAfterCap += scanRemainder;

      // Include a small private suffix from raw so a fence split exactly at the
      // body cap (for example raw="\n``" + pending="`INFO") is still detected.
      const scanPrefixStart = Math.max(flushedLen, raw.length - 64);
      const metaCandidate = raw.slice(scanPrefixStart) + pendingAfterCap;
      const openAt = metaCandidate.search(metaOpenRe);
      if (openAt >= 0) {
        raw = raw.slice(0, scanPrefixStart) + metaCandidate.slice(0, openAt);
        const metaChunkFull = metaCandidate.slice(openAt);
        pendingAfterCap = "";
        metaStarted = true;

        finishBodyFromPending("");
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

        if (params.streamDebug) console.debug(`${params.streamTag} meta passthru (${params.tag}) (len=${metaChunk.length})`);
        flushWithHoldback();

        const metaSub = raw.slice(Math.max(0, metaStartIdx));
        if (params.isMetaFenceClosed(metaSub)) {
          stoppedEarly = true;
          break;
        }
      } else if (pendingAfterCap.length >= metaScanGraceChars) {
        // No meta found within a large tail buffer.
        // - If meta is REQUIRED, keep scanning until the model ends. The pending
        //   body is needed to complete the sentence before the eventual fence.
        // - If meta is optional, stop to avoid runaway.
        if (params.metaRequired !== "YES") {
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

  // No meta fence arrived. Still use the generated tail to finish the sentence
  // instead of exposing a bodyMaxChars hard cut.
  if (!metaStarted && capReached && pendingAfterCap) {
    finishBodyFromPending(pendingAfterCap);
    pendingAfterCap = "";
  }

  // If the model ended naturally but left a fenced meta/status block open, close it (within *body* budget).
  if (!stoppedEarly && fenceReserve > 0 && hasUnclosedFence(raw) && raw.length + 4 <= bodyCapChars) {
    const kept = raw.slice(0, flushedLen);
    const tail = raw.slice(flushedLen).replace(/[ \t\r\n]+$/, "");
    raw = kept + tail;
    raw = raw + (raw.endsWith("\n") ? "```" : "\n```");
  }

  flushAll();

  return { raw, hadDelta };
}
