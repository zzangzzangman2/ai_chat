import { assessTurnCompletion } from "../../../../../lib/turn_completion_guard";

export type StreamRunOneResult = {
  raw: string;
  usage: any;
  finishReason: string;
};

export type StreamRunOne = (userPrompt: string, tag: string) => Promise<StreamRunOneResult>;

export type RunStreamMainGenerationParams = {
  proDoneOnly: boolean;
  runOneBuffered: StreamRunOne;
  runOneStream: StreamRunOne;
  mergeUsage: (base: any, add: any) => any;
  makeContinueUser: (combined: string, reasons?: readonly string[]) => string;
  endsWithCompleteFence: (text: string) => boolean;
  userPrompt: string;
  maxContinues: number;
};

export type RunStreamMainGenerationResult = {
  usedBufferedTransport: boolean;
  combinedRaw: string;
  combinedUsage: any;
  finishReason: string;
  continuationCount: number;
};

export type RunOptionalShortContinueParams = {
  allowSecondCalls: boolean;
  oneShot: boolean;
  disallowG3ProContinue: boolean;
  promptMinForGuide: number;
  promptMaxChars: number;
  maxOutputTokensForCall: number;
  raw: string;
  combinedUsage: any;
  makeContinueUser: (combined: string, reasons?: readonly string[]) => string;
  generateText: (args: { system: string; user: string; opts: any }) => Promise<any>;
  systemForContinuation: string;
  opts: any;
  mergeUsage: (base: any, add: any) => any;
  safeEnqueue: (obj: any) => boolean;
  stripEndMarker: (s: string) => string;
  stripStandaloneSeparatorLines: (s: string) => string;
  stripUrlsAndMediaMarkdown: (s: string) => string;
  streamDebug: boolean;
  streamTag: string;
  currentUserText?: string;
  allowBoundedRecovery?: boolean;
};

export type RunOptionalShortContinueResult = {
  raw: string;
  combinedUsage: any;
  replaced: boolean;
  reasons: string[];
};

export type RunBufferedOneParams = {
  streamDebug: boolean;
  streamTag: string;
  tag: string;
  systemMain: string;
  userPrompt: string;
  opts: any;
  maxOutputTokensForCall: number;
  metaRequired: string;
  statusRequired: string;
  /** 거부 응답 자동 리롤 회차. buildModelCallOpts로 그대로 전달된다. */
  rerollAttempt?: number;
  generateText: (args: { system: string; user: string; opts: any }) => Promise<any>;
  onEmptyRaw?: (tag: string) => void;
};

export type BuildModelCallOptsParams = {
  baseOpts: any;
  maxOutputTokensForCall: number;
  metaRequired: string;
  statusRequired: string;
  mode: "buffered" | "stream";
  /**
   * (2026-08-16) 거부/차단 응답 자동 리롤 회차(0 = 최초 호출).
   * 리롤에서는 샘플링 폭을 넓힌다. 형식 준수를 위해 temperature를 0.15까지 낮춰둔
   * 상태로 그대로 다시 굴리면 직전과 거의 같은 토큰이 나와서, 같은 거부가 반복된다.
   */
  rerollAttempt?: number;
};

/** 리롤 회차에 따라 샘플링을 넓힌다. 형식 준수보다 "다른 결과"가 우선인 상황이다. */
function widenSamplingForReroll(base: { temperature: number; topP: number; topK: number }, attempt: number) {
  if (attempt <= 0) return base;
  const step = Math.min(4, Math.max(1, Math.floor(attempt)));
  return {
    temperature: Math.min(1.1, base.temperature + 0.2 * step),
    topP: Math.min(0.98, base.topP + 0.04 * step),
    topK: Math.min(64, base.topK + 8 * step),
  };
}

export function buildModelCallOpts(params: BuildModelCallOptsParams): any {
  const refusalFallbackEnabled = String(process.env.AI_REFUSAL_FALLBACK || "0").trim() === "1";
  const required = params.metaRequired === "YES" || params.statusRequired === "YES";
  const attempt = Math.max(0, Math.floor(Number(params.rerollAttempt) || 0));
  const baseCompliance =
    params.mode === "buffered"
      ? {
          // (compliance) 상태창이 필수인 경우, 샘플링을 보수적으로 조정해 형식 준수 확률을 높인다.
          // - Gemini 3 Pro는 기본 샘플링이 비교적 자유로워서, 본문만 쓰고 끝나는 케이스가 발생할 수 있다.
          // - temperature/topP를 낮추면 형식/템플릿 준수율이 체감상 크게 개선된다.
          temperature: 0.18,
          topP: 0.82,
          topK: 32,
        }
      : {
          // Lower randomness improves hard-format compliance (meta/status fenced block).
          temperature: 0.15,
          topP: 0.8,
          topK: 32,
        };
  const compliance = widenSamplingForReroll(baseCompliance, attempt);

  return {
    ...params.baseOpts,
    // 리롤 중에는 상태창 필수 여부와 무관하게 샘플링을 넓혀야 결과가 달라진다.
    ...(required || attempt > 0 ? compliance : {}),
    maxOutputTokens: params.maxOutputTokensForCall,
    maxOutputTokensRequested: params.baseOpts?.maxOutputTokens,
    // In streaming/DONE-only chat, a refusal fallback can add another slow model call
    // before the client receives `done`, which looks like a stalled output.
    disableRefusalFallback: params.baseOpts?.disableRefusalFallback ?? !refusalFallbackEnabled,
  };
}

export async function runBufferedOne(params: RunBufferedOneParams): Promise<StreamRunOneResult> {
  if (params.streamDebug) console.debug(`${params.streamTag} gen.start (${params.tag}) [buffered]`);

  const r: any = await params.generateText({
    system: params.systemMain,
    user: params.userPrompt,
    opts: buildModelCallOpts({
      baseOpts: params.opts,
      maxOutputTokensForCall: params.maxOutputTokensForCall,
      metaRequired: params.metaRequired,
      statusRequired: params.statusRequired,
      mode: "buffered",
      rerollAttempt: params.rerollAttempt,
    }),
  });

  const raw = String(r?.text || ""); // streaming: keep raw identical to emitted deltas
  if (!raw.trim() && params.onEmptyRaw) params.onEmptyRaw(params.tag);

  const usage: any = (r as any)?.usage ?? null;
  const finishReason = String(
    (usage && (usage.finishReason || usage.native_finish_reason || (usage as any).nativeFinishReason)) || ""
  ).toUpperCase();
  if (params.streamDebug) console.debug(`${params.streamTag} gen.done (${params.tag}) [buffered] finishReason=${finishReason}`);
  return { raw, usage, finishReason };
}

export async function runStreamMainGeneration(
  params: RunStreamMainGenerationParams
): Promise<RunStreamMainGenerationResult> {
  const runOne: StreamRunOne = async (...args) => {
    if (params.proDoneOnly) return await params.runOneBuffered(...args);
    return await params.runOneStream(...args);
  };

  let usedBufferedTransport = params.proDoneOnly;
  let combinedRaw = "";
  let combinedUsage: any = null;
  let finishReason = "";
  let continuationCount = 0;

  // 1) initial generation
  {
    const r0 = await runOne(params.userPrompt, "main");
    combinedRaw += r0.raw;
    combinedUsage = params.mergeUsage(combinedUsage, r0.usage);
    finishReason = r0.finishReason;
  }

  // 2) auto-continue up to N times if MAX_TOKENS
  for (let i = 0; i < params.maxContinues; i++) {
    if (finishReason !== "MAX_TOKENS") break;
    // If the model already produced a complete fenced meta block at the end, do not auto-continue.
    // Continuing from here often causes "text after status/info fence" artifacts.
    if (params.endsWithCompleteFence(combinedRaw)) {
      finishReason = "STOP";
      break;
    }
    const contUser = params.makeContinueUser(combinedRaw);
    const r = await runOne(contUser, `cont${i + 1}`);
    combinedRaw += r.raw;
    combinedUsage = params.mergeUsage(combinedUsage, r.usage);
    finishReason = r.finishReason;
    continuationCount += 1;
  }

  // Preserve final finishReason in usage for logging/UI.
  try {
    if (combinedUsage) combinedUsage.finishReason = finishReason || combinedUsage.finishReason;
  } catch {
    // ignore
  }

  if (params.proDoneOnly) usedBufferedTransport = true;

  return {
    usedBufferedTransport,
    combinedRaw,
    combinedUsage,
    finishReason,
    continuationCount,
  };
}

export async function runOptionalShortContinue(
  params: RunOptionalShortContinueParams
): Promise<RunOptionalShortContinueResult> {
  let raw = params.raw;
  let combinedUsage = params.combinedUsage;
  let replaced = false;
  let reasons: string[] = [];

  try {
    const strlenLocal = (s: string) => Array.from(String(s || "")).length;
    const stripAllFenceBlocks = (s: string) =>
      String(s || "")
        .replace(/```[^\n]*\n[\s\S]*?\n```/g, " ")
        .replace(/```[^\n]*\n[\s\S]*$/g, " ")
        .replace(/```/g, " ");
    const narrativeForLen = (s: string) =>
      params.stripUrlsAndMediaMarkdown(stripAllFenceBlocks(params.stripEndMarker(String(s || ""))));
    const assessment = assessTurnCompletion({
      text: raw,
      currentUserText: params.currentUserText,
      minNarrativeChars: params.promptMinForGuide,
      finishReason: combinedUsage?.finishReason,
    });
    const curLenNarr = strlenLocal(narrativeForLen(assessment.body).trim());
    // When we reserve a meta tail budget, the *narrative* minimum should not exceed the narrative budget.
    // (Otherwise the server might try to "continue" to reach a min length that the prompt will later forbid.)
    const gap = params.promptMinForGuide - curLenNarr;

    // Only when we have *some* content but are clearly under target.
    const legacyShortContinue =
      params.allowSecondCalls &&
      process.env.CHAT_ENABLE_SHORT_CONTINUE === "1" &&
      !params.oneShot &&
      !params.disallowG3ProContinue;
    // A normal STOP is authoritative. Do not spend a second request merely
    // because prose is shorter than the prompt target or a plural-response
    // heuristic thinks another line would be useful. Recovery is reserved for
    // objective provider failure: empty output or a MAX_TOKENS truncation.
    const hardRecovery = assessment.reasons.some(
      (reason) => reason === "EMPTY_BODY" || reason === "MAX_TOKENS"
    );
    const boundedRecovery = Boolean(
      !params.oneShot && params.allowBoundedRecovery && hardRecovery
    );
    if (
      (legacyShortContinue || boundedRecovery) &&
      (curLenNarr > 0 || boundedRecovery) &&
      (gap > 50 || assessment.reasons.some((reason) => reason !== "SHORT_BODY")) &&
      (boundedRecovery || strlenLocal(raw) < params.promptMaxChars)
    ) {
      reasons = assessment.reasons;
      const maxTok = Math.min(2048, Math.max(384, Math.floor(gap * 3)));
      const contUser = params.makeContinueUser(assessment.body, assessment.reasons);
      const more = await params.generateText({
        system: params.systemForContinuation,
        user: contUser,
        opts: {
          ...params.opts,
          maxReasoningTokens: Math.min(384, Math.max(0, Number(params.opts?.maxReasoningTokens) || 0)),
          maxOutputTokens: Math.min(params.maxOutputTokensForCall, maxTok),
        } as any,
      });

      const addAssessment = assessTurnCompletion({
        text: params.stripEndMarker(String((more as any)?.text || "")),
        minNarrativeChars: 0,
      });
      let add = params.stripStandaloneSeparatorLines(stripAllFenceBlocks(addAssessment.body));
      // Recovery must never expand a turn beyond the same total display budget
      // used by the first call.
      const remaining = Math.max(
        0,
        Math.floor(params.promptMaxChars - strlenLocal(raw) - 1)
      );
      if (remaining > 0 && add) {
        if (strlenLocal(add) > remaining) {
          add = Array.from(add).slice(0, remaining).join("");
        }
        if (add.trim()) {
          const panels = assessment.panels.length ? `\n\n${assessment.panels[0].fence}` : "";
          raw = `${assessment.body.trimEnd()}\n${add.trimStart()}${panels}`.trim();
          combinedUsage = params.mergeUsage(combinedUsage, (more as any)?.usage ?? null);
          replaced = true;
        }
      }
    }
  } catch (e) {
    if (params.streamDebug) console.debug(`${params.streamTag} short-continue skipped`, e);
  }

  return { raw, combinedUsage, replaced, reasons };
}
