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
  makeContinueUser: (combined: string) => string;
  endsWithCompleteFence: (text: string) => boolean;
  userPrompt: string;
  maxContinues: number;
};

export type RunStreamMainGenerationResult = {
  usedBufferedTransport: boolean;
  combinedRaw: string;
  combinedUsage: any;
  finishReason: string;
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
  makeContinueUser: (combined: string) => string;
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
};

export type RunOptionalShortContinueResult = {
  raw: string;
  combinedUsage: any;
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
  generateText: (args: { system: string; user: string; opts: any }) => Promise<any>;
  onEmptyRaw?: (tag: string) => void;
};

export type BuildModelCallOptsParams = {
  baseOpts: any;
  maxOutputTokensForCall: number;
  metaRequired: string;
  statusRequired: string;
  mode: "buffered" | "stream";
};

export function buildModelCallOpts(params: BuildModelCallOptsParams): any {
  const refusalFallbackEnabled = String(process.env.AI_REFUSAL_FALLBACK || "0").trim() === "1";
  const required = params.metaRequired === "YES" || params.statusRequired === "YES";
  const compliance =
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

  return {
    ...params.baseOpts,
    ...(required ? compliance : {}),
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
  };
}

export async function runOptionalShortContinue(
  params: RunOptionalShortContinueParams
): Promise<RunOptionalShortContinueResult> {
  let raw = params.raw;
  let combinedUsage = params.combinedUsage;

  try {
    const strlenLocal = (s: string) => Array.from(String(s || "")).length;
    const stripAllFenceBlocks = (s: string) =>
      String(s || "")
        .replace(/```[^\n]*\n[\s\S]*?\n```/g, " ")
        .replace(/```[^\n]*\n[\s\S]*$/g, " ")
        .replace(/```/g, " ");
    const narrativeForLen = (s: string) =>
      params.stripUrlsAndMediaMarkdown(stripAllFenceBlocks(params.stripEndMarker(String(s || ""))));
    const curLenNarr = strlenLocal(narrativeForLen(raw).trim());
    // When we reserve a meta tail budget, the *narrative* minimum should not exceed the narrative budget.
    // (Otherwise the server might try to "continue" to reach a min length that the prompt will later forbid.)
    const gap = params.promptMinForGuide - curLenNarr;

    // Only when we have *some* content but are clearly under target.
    if (
      params.allowSecondCalls &&
      process.env.CHAT_ENABLE_SHORT_CONTINUE === "1" &&
      !params.oneShot &&
      !params.disallowG3ProContinue &&
      curLenNarr > 0 &&
      gap > 50 &&
      strlenLocal(raw) < params.promptMaxChars
    ) {
      const maxTok = Math.min(2048, Math.max(384, Math.floor(gap * 3)));
      const contUser = params.makeContinueUser(raw);
      const more = await params.generateText({
        system: params.systemForContinuation,
        user: contUser,
        opts: { ...params.opts, maxOutputTokens: Math.min(params.maxOutputTokensForCall, maxTok) } as any,
      });

      let add = params.stripStandaloneSeparatorLines(params.stripEndMarker(String((more as any)?.text || "")));
      // Enforce the same max char headroom at append-time.
      const remaining = Math.max(0, Math.floor(params.promptMaxChars - strlenLocal(raw)));
      if (remaining > 0 && add) {
        if (strlenLocal(add) > remaining) {
          add = Array.from(add).slice(0, remaining).join("");
        }
        if (add.trim()) {
          raw = raw + add;
          combinedUsage = params.mergeUsage(combinedUsage, (more as any)?.usage ?? null);
          params.safeEnqueue({ type: "delta", text: add });
        }
      }
    }
  } catch (e) {
    if (params.streamDebug) console.debug(`${params.streamTag} short-continue skipped`, e);
  }

  return { raw, combinedUsage };
}
