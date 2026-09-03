import { GoogleGenAI } from "@google/genai";
import { createHash } from "crypto";
import {
  GEMINI_3_FLASH_MODEL,
  isGemini25ProModel,
  isGemini31ProModel,
  isCurrentGeminiFlashModel,
  isGemini3FlashModel,
  isGemini3Model,
  isGemini3ProModel,
  providerModelNameForGemini,
  stripProviderPrefix,
} from "@/lib/models";

// (디버그) 캐시 프리픽스 안정성 확인용: 시스템 프롬프트가 턴 간 바이트 동일하면 해시도 동일.
// CHAT_DEBUG=1 로그(gemini.req)에서 systemHash가 턴마다 같아야 implicit cache가 적중할 수 있다.
function promptHash12(s: string): string {
  try {
    return createHash("sha1").update(String(s || ""), "utf8").digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

function envFlag(name: string) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const useVertex = envFlag("GOOGLE_GENAI_USE_VERTEXAI") || envFlag("VERTEX_AI");
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
if (!useVertex && !apiKey) {
  throw new Error("GEMINI_API_KEY가 .env.local에 없습니다.");
}

function pickGenAIOptions() {
  if (!useVertex) {
    return { apiKey };
  }

  const project =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    process.env.VERTEX_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || "global";
  const vertexApiKey =
    process.env.VERTEX_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.API_KEY ||
    process.env.GEMINI_API_KEY;

  if (project) {
    return { vertexai: true, project, location };
  }
  if (vertexApiKey) {
    return { vertexai: true, apiKey: vertexApiKey };
  }

  throw new Error(
    "Vertex AI를 쓰려면 GOOGLE_CLOUD_PROJECT를 설정하고 gcloud ADC 로그인을 하거나 VERTEX_API_KEY/GOOGLE_API_KEY를 설정해야 합니다."
  );
}

export const genai = new GoogleGenAI(pickGenAIOptions());

// ---------------------------------------------------------------------------
// Gemini 3 Pro (preview) practical tuning
// - In this model family, "maxOutputTokens" is effectively the combined budget for
//   (reasoning/thoughts + actual answer tokens). If thoughts spike, the answer can be
//   cut mid-way with finishReason=MAX_TOKENS.
// - We keep a small rolling window of recent thoughtsTokenCount to auto-reserve
//   headroom without forcing multi-call "continue" chains.
//   (In-memory only; resets on process restart.)
// ---------------------------------------------------------------------------

const G3PRO_USAGE_WINDOW = 24;
const g3proThoughtsWindow: number[] = [];

function pushWindow(arr: number[], v: number, max = G3PRO_USAGE_WINDOW) {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  if (!n) return;
  arr.push(n);
  while (arr.length > max) arr.shift();
}

function percentile(arr: number[], p: number) {
  const a = Array.isArray(arr) ? arr.filter((x) => Number.isFinite(x as any)).map((x) => Number(x)) : [];
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  const w = idx - lo;
  return s[lo] * (1 - w) + s[hi] * w;
}

function observedHeadroomForGemini3Pro() {
  // Require a couple of samples before trusting the heuristic.
  if (g3proThoughtsWindow.length < 2) return 0;

  // Use a high percentile to protect against spikes, with a small multiplier + cushion.
  const p90 = percentile(g3proThoughtsWindow, 0.9);
  const headroom = Math.ceil(p90 * 1.15) + 320;

  // Keep it bounded to avoid encouraging runaway thinking (latency).
  return Math.min(4096, Math.max(1024, headroom));
}

function recordGemini3ProThoughts(model: string, reasoningTokens: number) {
  if (!isGemini3Pro(model)) return;
  pushWindow(g3proThoughtsWindow, reasoningTokens);
}

// ────────────────────────────────────────────────────────────────────
// 거부 응답 자동 감지 + fallback
// ────────────────────────────────────────────────────────────────────
//
// 일부 Gemini 모델(특히 3.x preview)은 RP/창작 컨텍스트에서도
// "죄송합니다. 해당 요청은 수행할 수 없습니다." 류의 거부 응답을 자주 반환한다.
// 이때 자동으로 gemini-2.5-pro로 한 번만 재시도하고 결과를 반환한다.
//
// false positive를 줄이기 위해:
//  - 본문이 짧고(<= 320자)
//  - 거부 패턴이 본문 앞쪽에 등장하며
//  - 거부 패턴 외 RP 콘텐츠가 거의 없는
//    경우에만 거부로 판정한다.
export const REFUSAL_FALLBACK_MODEL = "gemini-2.5-pro" as const;

const REFUSAL_PATTERNS: RegExp[] = [
  // 한국어 직접 거부
  /죄송합니다[\s\S]{0,40}(수행할\s*수\s*없습니다|도와드릴\s*수\s*없습니다|응답할\s*수\s*없습니다|처리할\s*수\s*없습니다|제공할\s*수\s*없습니다|답변(?:해|을\s*드릴)?\s*수\s*없습니다)/u,
  /해당\s*요청은?\s*수행할\s*수\s*없습니다/u,
  /해당\s*요청에는?\s*응답할\s*수\s*없습니다/u,
  /이\s*요청은?\s*도와드릴\s*수\s*없습니다/u,
  /(?:안전\s*정책|콘텐츠\s*정책|가이드라인)[\s\S]{0,60}(?:따라|위반|어긋|허용되지\s*않)/u,
  /민감한?\s*(?:내용|주제|요청)[\s\S]{0,40}(?:거절|거부|답변할\s*수\s*없)/u,
  // 영어 직접 거부
  /\bI\s+can(?:'|no)t\s+help\s+with\s+(?:that|this)/i,
  /\bI\s+(?:am|'m)\s+(?:not\s+able|unable)\s+to\s+(?:help|assist|continue|provide)/i,
  /\bI\s+can(?:'|no)t\s+(?:provide|continue|fulfill|comply)/i,
  /\bI\s+(?:must|need\s+to)\s+decline\b/i,
  /\b(?:Sorry|I'?m\s+sorry)[,.\s][\s\S]{0,40}\bcan(?:'|no)t\b/i,
];

export function isRefusalText(raw: string): boolean {
  const t = String(raw || "").trim();
  if (!t) return false;
  // 너무 긴 응답은 거부일 가능성이 낮다 (모델이 길게 답하면 보통 정상 응답).
  if (t.length > 320) return false;

  // 본문 앞쪽 200자 내에서 거부 패턴이 잡혀야 한다.
  const head = t.slice(0, 200);
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(head)) return true;
  }
  return false;
}

export type ChatGenOpts = {
  model: string;
  maxOutputTokens: number;
  maxReasoningTokens: number;
  // Optional stop sequences (up to 5). If provided, generation stops when any sequence is encountered.
  // NOTE: The stop sequence itself is not included in the response.
  stopSequences?: string[];

  // Optional sampling controls (used for stability tuning)
  temperature?: number;
  topP?: number;
  topK?: number;
  // Optional structured-output controls for extraction calls.
  responseMimeType?: "application/json" | "text/plain" | string;
  responseJsonSchema?: unknown;


  // When the caller specifies a "requested" max output, we keep it separately for logging/analytics.
  // (Some Gemini models treat outputBudget as totalGenerated = reasoning + candidates.)
  maxOutputTokensRequested?: number;

  // Thinking controls (Gemini Thinking / 3 Pro Preview)
  thinkingBudget?: number | null;
  thinkingLevel?: "low" | "medium" | "high" | null;
  // Optional per-call timeout override (ms). If omitted, model defaults are used.
  timeoutMs?: number;
  // Cancels local SDK/network consumption when the caller disconnects or leaves the chat.
  signal?: AbortSignal;

  // Forward-compat: allow additional provider-specific options without breaking TypeScript builds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function abortError(reason?: unknown): Error {
  const error = new Error(typeof reason === "string" && reason ? reason : "aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function linkedAbortController(signal?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => {
    try {
      controller.abort(signal?.reason);
    } catch {
      controller.abort();
    }
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => signal?.removeEventListener("abort", onAbort),
  };
}

function normalizeModelName(model: string) {
  return stripProviderPrefix(model);
}

function providerModelName(model: string) {
  return providerModelNameForGemini(model);
}

function isGemini3Pro(model: string) {
  return isGemini3ProModel(model);
}

function isGemini31Pro(model: string) {
  return isGemini31ProModel(model);
}

function isGemini3Flash(model: string) {
  return isGemini3FlashModel(model);
}

function isGemini3(model: string) {
  return isGemini3Model(model);
}

function isGemini25Pro(model: string) {
  return isGemini25ProModel(model);
}

type ThinkingConfigAny = { thinkingBudget?: number; thinkingLevel?: string };

function buildThinkingConfig(model: string, maxReasoningTokens: number, maxOutputTokensRequested: number): ThinkingConfigAny | null {
  const tRaw = Number(maxReasoningTokens) || 0;
  const t = Math.max(0, Math.floor(tRaw));
  // Gemini 3:
  // - SDK/API에서는 thinkingBudget(숫자)와 thinkingLevel(레벨) 중 **하나만** 설정 가능
  //   (둘 다 주면 400: "You can only set only one of thinking budget and thinking level.")
  //
  // Gemini 3 Pro stability policy:
  // - thinkingConfig를 아예 생략하면(=기본값) 모델이 hidden thinking에 토큰을 과하게 써서
  //   outputTokens가 극단적으로 짧아지거나(심하면 0) MAX_TOKENS로 끝나는 케이스가 있다.
  // - 따라서 (사용자가 추론 토큰을 0으로 두지 않은 한) 항상 thinkingBudget을 명시해
  //   thinking을 상한 내로 묶고, 가시 출력이 굶지 않게 한다.
  if (isGemini3Pro(model)) {
    // Gemini 3 / 3.1 Pro officially uses thinkingLevel, not numeric thinkingBudget.
    // Keep the UI numeric presets as stable local intent, then map them to levels.
    // IMPORTANT: set ONLY one of thinkingBudget / thinkingLevel.
    //
    // (보수적 매핑, 2026-05) thinkingLevel은 hard cap이 아니라 강도 힌트라서
    // "medium"으로 보내면 실제 reasoning이 2000~3500 토큰까지 쉽게 튀어오른다.
    // Gemini 3.1 Pro cannot disable thinking. Use supported levels only.
    //
    // (2026-08-11) LOW를 "low"가 아니라 "medium"으로 올린다.
    // low에서는 모델이 직전 턴과의 대조를 사실상 건너뛰어, 프롬프트에 있는 반복 방지
    // 규칙(이미 밝힌 신상 재나열 금지 등)이 지켜지지 않았다.
    // 동일 시나리오 A/B(5턴): low = 묻지 않은 신상 재서술 2/4턴, medium = 0/4턴.
    // 사용자가 "반복을 잡는 쪽"을 택해 품질을 기본값으로 삼는다. 대가는 첫 토큰 지연 증가.
    // 속도를 되찾고 싶으면 AI_G3PRO_LOW_LEVEL=low 로 예전 매핑으로 되돌릴 수 있다.
    const lowLevel =
      String(process.env.AI_G3PRO_LOW_LEVEL || "medium").trim().toLowerCase() === "low"
        ? "low"
        : "medium";
    if (t <= 0) {
      return { thinkingLevel: lowLevel };
    }
    const level = t >= 1280 ? "high" : t >= 640 ? "medium" : lowLevel;
    return { thinkingLevel: level };
  }
  if (isCurrentGeminiFlashModel(model)) {
    // Gemini 3.8 Flash supports low/medium/high only. Stored legacy IDs
    // normalize here too, so neither streaming nor summaries send minimal.
    return { thinkingLevel: t >= 1024 ? "high" : t >= 640 ? "medium" : "low" };
  }
  if (isGemini3Flash(model)) {
    // Gemini 3 Flash defaults to dynamic/high thinking if omitted.
    // For latency-sensitive chat, an explicit 0 means "minimal", not "unset".
    // (Gemini 3.x flash 공식 thinking_level enum: minimal / low / medium / high. default=high.)
    // 4단계 모두 활용해 사용자 단계 의미를 살린다.
    //  - LOW(0)     → "minimal" (fast chat path)
    //  - MID(640)   → "medium"  (moderate chain, 쿼리 복잡도 따라 0~수k. 단순 쿼리에선 0 가능)
    //  - HIGH(1024) → "high"    (full deliberation, slower)
    // 참고: HIGH가 모델 기본값이라, 명시 안 해도 자동 high.
    //       low/medium에서 reasoning=0 나오는 건 모델 자율 결정 (token guarantee 아님).
    if (!t) return { thinkingLevel: "minimal" };
    if (t >= 1024) return { thinkingLevel: "high" };
    if (t >= 640) return { thinkingLevel: "medium" };
    if (t >= 256) return { thinkingLevel: "low" };
    return { thinkingLevel: "minimal" };
  }

  if (!t) return null;

  // Gemini 2.5 Pro: thinkingLevel is not supported (400). Use numeric thinkingBudget instead.
  // Provider requires thinkingBudget in [128, 32768], plus the special value -1 = dynamic (auto).
  // Compromise policy: keep user-selected reasoning fixed, but cap with a global upper bound.
  // (No output-length-coupled cap)
  if (isGemini25Pro(model)) {
    const MIN_BUDGET = 128;

    // (예외) refusal fallback 등에서 reasoning을 "최대한 dynamic"으로 쓰고 싶을 때
    // 호출자가 maxReasoningTokens를 -1 (또는 음수) 로 보내면 thinkingBudget=-1(=auto)로 전송한다.
    // - Gemini 2.5 Pro는 thinkingBudget=-1 을 "dynamic thinking"으로 해석해 모델이 자율 결정.
    // - 기존 호출자들은 모두 양수만 사용하므로 회귀 없음.
    const tRaw = Number(maxReasoningTokens);
    if (Number.isFinite(tRaw) && tRaw < 0) {
      return { thinkingBudget: -1 };
    }

    if (t < MIN_BUDGET) return null;

    // Keep the parameter intentionally consumed for compatibility/telemetry parity.
    // (This branch no longer derives budget from requested output length.)
    const reqHint = Math.max(0, Math.floor(Number(maxOutputTokensRequested) || 0));
    void reqHint;

    const MAX_BUDGET_RAW = Number(process.env.G25PRO_MAX_THINKING_BUDGET ?? 2048);
    const MAX_BUDGET = Number.isFinite(MAX_BUDGET_RAW) && MAX_BUDGET_RAW > 0 ? Math.floor(MAX_BUDGET_RAW) : 2048;
    const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, t));

    return { thinkingBudget: budget };
  }

  return null;
}

function thinkingLevelHeadroom(level: string): number {
  const l = String(level || "").toLowerCase();
  if (l === "minimal") return 256;
  if (l === "low") return 512;
  if (l === "medium") return 768;
  if (l === "high") return 1024;
  return 0;
}

function estimatePromptTokensFromChars(totalChars: number): number {
  const c = Math.max(0, Math.floor(Number(totalChars) || 0));
  if (!c) return 0;
  // Heuristic: Gemini tokenization for Korean/JP can be denser than English.
  // Empirically ~1 token per 1.4~1.8 chars in our prompts; use 1.6 as a conservative midpoint.
  return Math.max(1, Math.ceil(c / 1.6));
}

function dynamicThinkingHeadroomForGemini3(thinkingLevel: string, estimatedPromptTokens: number): number {
  const level = String(thinkingLevel || "").toLowerCase();
  const pt = Math.max(0, Math.floor(Number(estimatedPromptTokens) || 0));
  if (!level || !pt) return 0;

  // Gemini 3 Pro/Flash는 thinking 토큰이 maxOutputTokens 예산을 잠식하는 경향이 있지만,
  // "헤드룸을 과하게" 잡으면(예: +4k) 한 번의 요청이 매우 느려지거나(>120s) 아예 hang처럼 보이는
  // 문제가 더 자주 발생한다.
  //
  // 목표:
  // - 빈 응답(0 outputTokens) 방지에 충분한 최소 헤드룸은 확보
  // - 대신 "한 방" 호출이 과도하게 커지지 않도록 상한을 낮게 유지

  // Prompt가 커질수록 reasoning spend가 늘어나는 경향이 있어 약하게 비례시키되,
  // 비율/바닥값을 보수적으로 낮춘다.
  // NOTE:
  // Gemini 3 Pro는 usageMetadata.thoughtsTokenCount(=reasoningTokens)가
  // thinkingConfig(thinkingBudget/level)보다 훨씬 크게 나오는 케이스가 있다.
  // 이때 maxOutputTokens 예산이 reasoning에 잠식되어 finishReason=MAX_TOKENS로
  // 본문이 중간에서 잘리는 문제가 자주 발생한다.
  //
  // 따라서 "hang 위험"을 늘리지 않는 선에서 headroom 추정치를 조금 더 공격적으로 잡는다.
  // (최종 상한은 computeEffectiveMaxOutputTokens에서 다시 캡됨)
  const ratio =
    level === "minimal" ? 0.08 :
    level === "low" ? 0.14 :
    level === "medium" ? 0.18 :
    level === "high" ? 0.22 :
    0.14;

  const floor =
    level === "minimal" ? 320 :
    level === "low" ? 768 :
    level === "medium" ? 1024 :
    level === "high" ? 1280 :
    768;

  const dyn = Math.max(floor, Math.round(pt * ratio));
  // Gemini 3.1 Pro can spend 5k+ thought tokens on a ~30k-token Korean
  // continuity prompt even at thinkingLevel=medium. A 2304 cap starves the
  // visible answer and produces MAX_TOKENS after only a few sentences. This
  // headroom does not force extra thinking; it only stops thoughts already
  // being generated from consuming the answer budget.
  const dynamicCapRaw = Number(process.env.GEMINI3_DYNAMIC_HEADROOM_CAP ?? 6144);
  const dynamicCap = Number.isFinite(dynamicCapRaw)
    ? Math.min(8192, Math.max(2304, Math.floor(dynamicCapRaw)))
    : 6144;
  return Math.min(dynamicCap, dyn);
}

function computeEffectiveMaxOutputTokens(
  model: string,
  requestedMaxOutputTokens: number,
  thinkingConfig: ThinkingConfigAny | null,
  system: string,
  user: string
) {
  const req = Math.max(0, Math.floor(Number(requestedMaxOutputTokens) || 0));
  const g3ProHeadroomCapRaw = Number(process.env.G3PRO_HEADROOM_CAP ?? 6144);
  const g3ProHeadroomCap = Number.isFinite(g3ProHeadroomCapRaw)
    ? Math.min(8192, Math.max(256, Math.floor(g3ProHeadroomCapRaw)))
    : 6144;

  const tb = thinkingConfig?.thinkingBudget ? Math.max(0, Math.floor(Number(thinkingConfig.thinkingBudget) || 0)) : 0;
  const tl = thinkingConfig?.thinkingLevel ? String(thinkingConfig.thinkingLevel) : "";
  const baseHeadroom = tb > 0 ? tb : tl ? thinkingLevelHeadroom(tl) : 0;
  let headroom = baseHeadroom;

  // Gemini 3: reserve *dynamic* headroom based on prompt size.
  // - Prevents long multi-call "continue:MAX_TOKENS" chains (each call can take 40~60s).
  // - Keeps visible output closer to the requested size, instead of being starved by reasoning.
  if (isGemini3(model)) {
    // Gemini 3는 thinkingLevel을 안 쓰고 thinkingBudget만 쓰는 경우가 있음(3 Pro).
    // 이때도 prompt 크기에 따른 최소 headroom은 잡아줘야 'MAX_TOKENS로 중간 잘림'을 줄일 수 있다.
    const levelForDyn = tl
      ? tl
      : tb >= 896
      ? "high"
      : tb >= 640
      ? "medium"
      : tb >= 256
      ? "low"
      : tb > 0
      ? "minimal"
      : "";

    if (levelForDyn) {
      const totalChars = Math.max(0, (system || "").length + (user || "").length);
      const estPromptTokens = estimatePromptTokensFromChars(totalChars);
      const dyn = dynamicThinkingHeadroomForGemini3(levelForDyn, estPromptTokens);
      headroom = Math.max(headroom, dyn);
    }
  }


  // Gemini 3 Pro: prevent "thoughts eat the whole budget" cutoffs without inflating latency too much.
// - thinkingBudget caps thoughts tokens (preferred)
// - headroom is a small safety buffer in case the provider overshoots or spikes on cold-start
if (isGemini3Pro(model)) {
  const thinkingOn = Boolean(tb > 0 || tl);
  if (thinkingOn) {
    // Observed thoughts headroom (rolling window) - helps on cold start and provider variance.
    const obs = observedHeadroomForGemini3Pro();
    if (obs > 0) headroom = Math.max(headroom, obs);

    // Small baseline headroom.
    // NOTE: Gemini 3 Pro sometimes overshoots thoughtsTokenCount beyond the requested thinkingBudget,
    // and because (thoughts + answer) share one maxOutputTokens budget, this can cut the visible
    // answer right before/inside the trailing STATUS fence.
    // We keep the baseline modest, but add an overshoot guard to avoid MAX_TOKENS truncation.
    const minHeadroomRaw = Number(process.env.G3PRO_MIN_HEADROOM ?? 256);
    const minHeadroom = Number.isFinite(minHeadroomRaw) ? Math.max(0, Math.floor(minHeadroomRaw)) : 256;

    // Overshoot guard: reserve extra room in case the provider exceeds thinkingBudget.
    // Default multiplier is tuned for stability (meta/status completion) rather than minimal latency.
    const mulRaw = Number(process.env.G3PRO_THOUGHTS_OVERSHOOT_MUL ?? 2.4);
    const mul = Number.isFinite(mulRaw) ? Math.min(4, Math.max(1.2, mulRaw)) : 2.4;
    const overshootGuard = tb > 0 ? Math.min(g3ProHeadroomCap, Math.max(0, Math.floor(tb * mul) + 256)) : 0;

    headroom = Math.max(headroom, minHeadroom, overshootGuard);

    // Hard cap to avoid runaway latency. (Final capping also happens below via headroomHardCap.)
    headroom = Math.min(headroom, g3ProHeadroomCap);
  }
}
  if (headroom > 0 && (isGemini3(model) || isGemini25Pro(model))) {
    // 핵심 원칙:
    // - req는 "사용자가 체감하는 글 길이"(슬라이더)로 쓰이므로 그대로 존중
    // - headroom은 빈 응답 방지를 위한 최소분만 더한다
    // - 단, Gemini 3 Pro에서 headroom이 커지면 호출이 매우 느려지는 문제가 있어 상한을 낮게 둔다

    // req가 작을수록(headroom 과다) 체감 지연이 커지므로 req 비례 상한을 둔다.
    // Gemini 3 Pro는 reasoning(=thoughtsTokenCount)이 크게 나와 본문이 잘리는 케이스가 잦아
    // headroom 상한을 조금 더 크게 잡되, 아래 hardMax로 전체 요청 크기는 강하게 제한한다.
    const headroomCapByReq = isGemini3Pro(model)
      ? g3ProHeadroomCap
      : Math.max(256, Math.floor(req * 0.85));
    const headroomHardCap = isGemini3Pro(model) ? g3ProHeadroomCap : 1536;
    const cappedHeadroom = Math.min(headroom, headroomCapByReq, headroomHardCap);

    const eff = req + cappedHeadroom + 64;

    // 최종 상한: 한 방 호출이 과도하게 커지지 않도록(=hang/120s+) 보수적 캡을 적용
    const g3ProHardMaxRaw = Number(process.env.G3PRO_MAX_OUTPUT_TOKENS_HARD ?? 16384);
    const g3ProHardMax = Number.isFinite(g3ProHardMaxRaw)
      ? Math.min(32768, Math.max(8192, Math.floor(g3ProHardMaxRaw)))
      : 16384;
    const hardMax = isGemini3Pro(model) ? g3ProHardMax : 8192;
    return Math.min(hardMax, Math.max(req, eff));
  }
  return req;
}

function defaultCallTimeoutMs(model: string) {
  const modelIs31Pro = isGemini31Pro(model);
  const modelIs3Pro = isGemini3Pro(model);
  const modelIs3Flash = isGemini3Flash(model);
  const modelIs25Pro = isGemini25Pro(model);
  return modelIs31Pro ? 110_000 : modelIs3Pro ? 75_000 : modelIs3Flash ? 30_000 : modelIs25Pro ? 75_000 : 60_000;
}

function resolveCallTimeoutMs(model: string, overrideMs: unknown) {
  const base = defaultCallTimeoutMs(model);
  const n = Number(overrideMs);
  if (!Number.isFinite(n)) return base;
  // Keep bounds conservative to avoid accidental near-infinite waits.
  return Math.max(5_000, Math.min(300_000, Math.floor(n)));
}

function resolveLongMemorySummaryTimeoutMs() {
  const raw = Number(process.env.LONG_MEMORY_SUMMARY_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(raw)) return 120_000;
  return Math.max(30_000, Math.min(300_000, Math.floor(raw)));
}


function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | null> {
  let timer: any = null;
  let didTimeout = false;

  const timeoutP = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      didTimeout = true;
      try {
        onTimeout?.();
      } catch {
        // ignore
      }
      resolve(null);
    }, Math.max(0, ms));
  });

  const r = (await Promise.race([p, timeoutP])) as any;
  if (timer) clearTimeout(timer);

  // If we timed out, ensure any eventual rejection is consumed (avoid unhandled rejections).
  if (r === null && didTimeout) {
    void p.catch(() => undefined);
  }
  return r as any;
}

function extractHttpStatus(err: any): number | null {
  const e = err || {};
  const cand = [
    e?.status,
    e?.code,
    e?.response?.status,
    e?.cause?.status,
    e?.cause?.code,
    e?.cause?.response?.status,
  ];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return Math.floor(n);
  }
  const msg = String(e?.message || e || "");
  const m = msg.match(/\b(429|500|502|503|504)\b/);
  if (m) return Number(m[1]);
  return null;
}

function isRetryableGeminiError(err: any) {
  const s = extractHttpStatus(err);
  // Typical transient classes: quota/rate (429), backend (5xx).
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
}

async function withRetry<T>(fn: () => Promise<T>, opts: { maxRetries: number; baseDelayMs: number; label?: string }) {
  let attempt = 0;
  let lastErr: any = null;
  while (attempt <= opts.maxRetries) {
    try {
      const value = await fn();
      return { value, retries: attempt };
    } catch (e: any) {
      lastErr = e;
      if (!isRetryableGeminiError(e) || attempt >= opts.maxRetries) throw e;
      const backoff = opts.baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * Math.max(50, opts.baseDelayMs));
      await sleep(backoff + jitter);
      attempt += 1;
      continue;
    }
  }
  // unreachable
  throw lastErr;
}

function countTokenModelCandidates(model: string) {
  const raw = String(model || "").trim();
  const provider = providerModelName(raw);
  const norm = normalizeModelName(raw);
  const out: string[] = [];
  for (const m of [raw, provider, norm]) {
    if (!m) continue;
    if (out.includes(m)) continue;
    out.push(m);
  }
  return out;
}

export async function countTokens(params: {
  model: string;
  text: string;
  systemInstruction?: string;
  timeoutMs?: number;
}): Promise<number | null> {
  const text = String(params?.text || "");
  if (!text.trim()) return 0;

  const rawTimeout = Number(params?.timeoutMs ?? process.env.GEMINI_COUNT_TOKENS_TIMEOUT_MS ?? 1800);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(300, Math.min(12000, Math.floor(rawTimeout))) : 1800;
  const systemInstruction = String(params?.systemInstruction || "");
  const modelCandidates = countTokenModelCandidates(String(params?.model || ""));

  for (const model of modelCandidates) {
    const controller = new (globalThis as any).AbortController();
    const req: any = {
      model,
      contents: [{ role: "user", parts: [{ text }] }],
      config: { abortSignal: controller.signal },
    };
    if (systemInstruction.trim()) req.config.systemInstruction = systemInstruction;

    try {
      const r0 = await withTimeout(
        withRetry(() => (genai.models as any).countTokens(req), {
          maxRetries: 1,
          baseDelayMs: 250,
          label: "countTokens",
        }),
        timeoutMs,
        () => {
          try {
            controller.abort();
          } catch {
            // ignore
          }
        }
      );

      if (!r0) continue;
      const resp = (r0 as any)?.value ?? r0;
      const total = Number((resp as any)?.totalTokens ?? (resp as any)?.total_tokens ?? NaN);
      if (Number.isFinite(total) && total >= 0) return Math.floor(total);
    } catch {
      // Try next model candidate.
    }
  }

  return null;
}

function isChatDebug() {
  // 로깅만 추가: 기존 기능/출력에는 영향 없음
  return String(process.env.CHAT_DEBUG || "").trim() === "1";
}

function safeLen(v: any) {
  return Array.from(String(v ?? "")).length;
}

function safePreview(v: any, max = 180) {
  const s = String(v ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function normalizeLongMemoryToneBanmal(input: string): string {
  let s = String(input || "");
  if (!s) return "";

  // Keep this conservative: only rewrite common sentence-final polite endings.
  // Goal is consistency ("반말 해체"), not a full morphological conversion.
  s = s.replace(/([가-힣]+?)했습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1했다");
  s = s.replace(/([가-힣]+?)였(?:었)?습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1였다");
  s = s.replace(/([가-힣]+?)입니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1이다");

  s = s.replace(/있습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "있다");
  s = s.replace(/없습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "없다");
  s = s.replace(/됩니다(?=(?:\s*[.!?…。]|\s*$))/gm, "된다");
  s = s.replace(/합니다(?=(?:\s*[.!?…。]|\s*$))/gm, "한다");

  // Fallback for remaining '-습니다' endings.
  s = s.replace(/([가-힣]+?)습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1다");
  return s;
}

export async function generateText(params: {
  system: string;
  user: string;
  opts: ChatGenOpts;
}): Promise<{ text: string; usage: any }> {
  const { system, user, opts } = params;
  throwIfAborted(opts.signal);

  const t0 = Date.now();

  // 일부 모델/SDK 조합에서 thinkingConfig 또는 stopSequences를 거부하는 케이스가 있어
  // 여러 조합을 순차적으로 시도한다.
  const stopSequences = Array.isArray(opts.stopSequences) ? opts.stopSequences.filter(Boolean) : [];

  // (Gemini 3 Pro) 안정적인 서술/대사 순서를 위해 샘플링을 보수적으로 고정.
  // - 기본값(temperature/topP/topK 미지정)은 실행마다 결과가 크게 흔들릴 수 있음
  // - creative writing은 살리되, 형식/길이 변동을 줄이기 위해 낮은 temperature를 사용

	const samplingConfig: any = (() => {
		if (!isGemini3Pro(opts.model)) return null;
		// Prefer per-request overrides when present (route.ts may set stricter sampling
		// for format-sensitive outputs like INFO/STATUS fences).
		const tRaw =
			typeof opts.temperature === "number" && Number.isFinite(opts.temperature)
				? opts.temperature
				: Number(process.env.G3PRO_TEMPERATURE ?? 0.35);
		const pRaw =
			typeof opts.topP === "number" && Number.isFinite(opts.topP)
				? opts.topP
				: Number(process.env.G3PRO_TOPP ?? 0.9);
		const kRaw =
			typeof opts.topK === "number" && Number.isFinite(opts.topK)
				? opts.topK
				: Number(process.env.G3PRO_TOPK ?? 32);


    // Defensive sanitize: avoid INVALID_ARGUMENT due to NaN/out-of-range.
    const temperature = Number.isFinite(tRaw) ? Math.min(2, Math.max(0, tRaw)) : 0.35;
    const topP = Number.isFinite(pRaw) ? Math.min(1, Math.max(0.05, pRaw)) : 0.9;
    const topK = Number.isFinite(kRaw) ? Math.max(1, Math.floor(kRaw)) : 32;


    return { temperature, topP, topK };
  })();

  const maxOutputTokensRequested = Number(opts.maxOutputTokensRequested ?? opts.maxOutputTokens);
  const maxOutputTokensForProvider = Number(opts.maxOutputTokens ?? maxOutputTokensRequested);
  const thinkingConfig = buildThinkingConfig(opts.model, opts.maxReasoningTokens, maxOutputTokensRequested);
  const effectiveMaxOutputTokens = computeEffectiveMaxOutputTokens(opts.model, maxOutputTokensForProvider, thinkingConfig, system, user);
  const requestModel = providerModelName(opts.model);

  const baseReq: any = {
    model: requestModel,
    contents: [{ role: "user", parts: [{ text: user }] }],
    config: {
      systemInstruction: system,
      maxOutputTokens: effectiveMaxOutputTokens,
      ...(samplingConfig ? samplingConfig : {}),
      ...(stopSequences.length ? { stopSequences } : {}),
      ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
      ...(opts.responseJsonSchema ? { responseJsonSchema: opts.responseJsonSchema } : {}),
    },
  };

  const mkNoStop = (req: any) => {
    const cfg = { ...(req.config || {}) } as any;
    delete cfg.stopSequences;
    return { ...req, config: cfg };
  };

  const withThinking: any = thinkingConfig
    ? {
        ...baseReq,
        config: {
          ...baseReq.config,
          thinkingConfig,
        },
      }
    : null;

  const reqs: Array<{ label: string; req: any }> = withThinking
    ? [
        { label: "withThinking", req: withThinking },
        { label: "base", req: baseReq },
        ...(stopSequences.length ? [{ label: "withThinkingNoStop", req: mkNoStop(withThinking) }] : []),
        ...(stopSequences.length ? [{ label: "baseNoStop", req: mkNoStop(baseReq) }] : []),
      ]
    : [
        { label: "base", req: baseReq },
        ...(stopSequences.length ? [{ label: "baseNoStop", req: mkNoStop(baseReq) }] : []),
      ];

  if (isChatDebug()) {
    console.log(
      JSON.stringify({
        tag: "gemini.req",
        model: opts.model,
        maxOutputTokensRequested,
        maxOutputTokensForProvider,
        maxOutputTokens: effectiveMaxOutputTokens,
        maxReasoningTokens: opts.maxReasoningTokens,
        thinkingBudget: (thinkingConfig as any)?.thinkingBudget ?? null,
        thinkingLevel: (thinkingConfig as any)?.thinkingLevel ?? null,
        temperature: samplingConfig?.temperature ?? null,
        topP: samplingConfig?.topP ?? null,
        topK: samplingConfig?.topK ?? null,
        stopSequences: stopSequences.length ? stopSequences : null,
        systemChars: system.length,
        systemHash: promptHash12(system),
        userChars: user.length,
        systemPreview: safePreview(system, 240),
        userPreview: safePreview(user, 240),
      })
    );
  }

  let resp: any = null; // accepted response (non-empty)
  let lastResp: any = null; // last response even if empty
  let lastErr: any = null;
  const attempts: Array<{ label: string; ok: boolean; ms: number; err?: string }> = [];

  const extractTextQuick = (r: any): string => {
    const parts0 = (r?.candidates?.[0]?.content?.parts || []) as any[];
    const joined0 = parts0.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
    return typeof r?.text === "string" ? r.text : joined0;
  };

  const extractOutputTokensQuick = (r: any): number => {
    const u = r?.usageMetadata || r?.usage || {};
    return Number(u?.candidatesTokenCount ?? u?.output_tokens ?? 0) || 0;
  };

  const isLikelyEmptyResponse = (r: any): boolean => {
    const t = String(extractTextQuick(r) || "");
    if (t.trim()) return false;
    const out = extractOutputTokensQuick(r);
    const noCandidates = !Array.isArray(r?.candidates) || r.candidates.length === 0;
    // Do not issue another billable request when the provider reports a
    // completed candidate. Local route guards handle their own over-filtering.
    return out === 0 || noCandidates;
  };

  const modelIs3Pro = isGemini3Pro(opts.model);
  const CALL_TIMEOUT_MS = resolveCallTimeoutMs(opts.model, opts.timeoutMs);

  // Gemini 3 Pro must stay strict single-call here: no fallback/retry request.
  const reqList = modelIs3Pro ? reqs.slice(0, 1) : reqs;

  for (const { label, req } of reqList) {
    const t1 = Date.now();
    const linkedAbort = linkedAbortController(opts.signal);
    try {
      const reqWithSignal = {
        ...(req as any),
        config: { ...((req as any).config || {}), abortSignal: linkedAbort.controller.signal },
      };

      const r0 = await withTimeout(
        withRetry(() => genai.models.generateContent(reqWithSignal), {
          maxRetries: 0,
          baseDelayMs: 650,
          label,
        }),
        CALL_TIMEOUT_MS,
        () => {
          try {
            linkedAbort.controller.abort();
          } catch {
            // ignore
          }
        }
      );
      throwIfAborted(opts.signal);

      if (!r0) {
        if (isChatDebug()) {
          console.debug(JSON.stringify({ tag: "gemini.timeout", model: opts.model, label, timeoutMs: CALL_TIMEOUT_MS }));
        }
        attempts.push({ label, ok: false, ms: Date.now() - t1, err: `timeout>${CALL_TIMEOUT_MS}ms` });
        // Gemini 3 Pro: hard-fail on timeout (no retries) per user request.
        if (modelIs3Pro) {
          lastErr = new Error(`timeout>${CALL_TIMEOUT_MS}ms`);
          break;
        }
        continue;
      }

      const r = (r0 as any)?.value ?? r0;
      lastResp = r;

      if (isLikelyEmptyResponse(r)) {
        attempts.push({ label, ok: false, ms: Date.now() - t1, err: "empty_output" });
        // Empty/blocked responses can still be billable. A successful provider
        // response ends this attempt; only a thrown config error may fall
        // through to a compatibility request shape.
        resp = r;
        break;
      }

      resp = r;
      attempts.push({ label, ok: true, ms: Date.now() - t1 } as any);
      break;
    } catch (e: any) {
      if (opts.signal?.aborted) throw abortError(opts.signal.reason);
      lastErr = e;
      attempts.push({ label, ok: false, ms: Date.now() - t1, err: String(e?.message || e) });
    } finally {
      linkedAbort.dispose();
    }
  }

  // Gemini 3 Pro: do not perform any fallback retries here.

  if (!resp) {
    // If we only got empty responses, keep the last one so the rescue path can run.
    resp = lastResp;
  }

  if (!resp) {
    throw lastErr || new Error("gemini generateContent failed");
  }

  const latencyMs = Date.now() - t0;

  const parts = (resp.candidates?.[0]?.content?.parts || []) as any[];
  const joined = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  const text = typeof resp.text === "string" ? resp.text : joined;

  const usage = resp.usageMetadata || resp.usage || {};
  if (process.env.LOG_USAGE_METADATA === "1") {
    try {
      const keys = usage && typeof usage === "object" ? Object.keys(usage) : [];
      console.debug("[gemini][usage]", JSON.stringify({ model: opts.model, keys, usage }));
    } catch {
      // ignore
    }
  }
  const finishReason = String(resp.candidates?.[0]?.finishReason || resp.finishReason || "");

  const promptTokens = Number(usage?.promptTokenCount ?? usage?.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.candidatesTokenCount ?? usage?.output_tokens ?? 0) || 0;
  const totalFromUsage = Number(usage?.totalTokenCount ?? usage?.total_tokens ?? 0) || 0;
  const hasThoughts =
    !!usage &&
    (Object.prototype.hasOwnProperty.call(usage, "thoughtsTokenCount") ||
      Object.prototype.hasOwnProperty.call(usage, "thoughts_token_count") ||
      Object.prototype.hasOwnProperty.call(usage, "thoughtsTokens") ||
      Object.prototype.hasOwnProperty.call(usage, "thoughts_tokens") ||
      Object.prototype.hasOwnProperty.call(usage, "reasoningTokens") ||
      Object.prototype.hasOwnProperty.call(usage, "reasoning_tokens"));

  let reasoningTokens = hasThoughts
    ? (Number(
        (usage as any)?.thoughtsTokenCount ??
          (usage as any)?.thoughts_token_count ??
          (usage as any)?.thoughtsTokens ??
          (usage as any)?.thoughts_tokens ??
          (usage as any)?.reasoningTokens ??
          (usage as any)?.reasoning_tokens ??
          0
      ) || 0)
    : undefined;
  // 일부 응답은 thoughts 키를 주지 않지만 totalTokenCount에는 reasoning이 포함될 수 있다.
  // 이 경우 total - (prompt + output)으로 추론 토큰을 보강해 누락 표시를 줄인다.
  const inferredReasoning = totalFromUsage - promptTokens - outputTokens;
  if ((!Number.isFinite(Number(reasoningTokens)) || Number(reasoningTokens) <= 0) && inferredReasoning > 0) {
    reasoningTokens = inferredReasoning;
  }
  const totalTokens = totalFromUsage || (promptTokens + outputTokens + (typeof reasoningTokens === "number" ? reasoningTokens : 0));

  let finalText = String(text || "");
  let finalUsage: any = {
    promptTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
  let finalFinishReason = finishReason;

  // (Gemini 3) Fail-safe:
  // 모델이 thinking에 maxOutputTokens를 전부 써버리면 outputTokens=0이 되며 화면엔 빈 응답이 나타난다.
  // 이 경우 1회만 'output 자리'를 확보해 재시도한다.
  const isG3 = isGemini3(opts.model);
  const fr = String(finalFinishReason || "").toUpperCase();
  const isEmptyG3 = isG3 && !finalText.trim();
  const isEmptyMax =
    isEmptyG3 &&
    (fr.includes("MAX") || Number(finalUsage.outputTokens || 0) === 0 || !Array.isArray(resp?.candidates) || resp.candidates.length === 0);

  const emptyOutputRescueEnabled = String(process.env.AI_EMPTY_OUTPUT_RESCUE || "").trim() === "1";
  if (emptyOutputRescueEnabled && isEmptyMax && !modelIs3Pro) {
    // Gemini 3 Pro can sometimes spend the entire budget on thinking and return empty visible text.
    // Do ONE rescue call on the SAME model to secure visible output.
    // For Gemini 3 Pro, avoid thinkingLevel (some variants reject certain levels).
    // Instead, cap thinking strictly with a small thinkingBudget.
    const rescueLevel = isCurrentGeminiFlashModel(opts.model)
      ? "low"
      : isGemini3Flash(opts.model) ? "minimal" : "low";
    const rescueThinkingConfig: any = modelIs3Pro ? { thinkingBudget: 128 } : { thinkingLevel: rescueLevel };
    const rescueHeadroom = modelIs3Pro ? 1024 : thinkingLevelHeadroom(rescueLevel);

    // Give the model enough room for BOTH thinking + visible text.
    const rescueUser = `${user}\n\n(중요) 직전 시도에서 출력이 비었습니다. 반드시 출력 규칙을 지키며 1문장 이상 가시 텍스트를 출력하세요.`;

    // We keep the user's requested maxOutputTokens as the 'visible-output budget' and add a headroom.
    const rescueMaxOut = Math.min(8192, Math.max(512, (maxOutputTokensRequested || 0) + rescueHeadroom + 512));

    const rescueReq: any = {
      ...baseReq,
      contents: [{ role: "user", parts: [{ text: rescueUser }] }],
      config: {
        ...baseReq.config,
        maxOutputTokens: rescueMaxOut,
        thinkingConfig: rescueThinkingConfig,
      },
    };

    const t2 = Date.now();
    try {
      // Rescue should be bounded, but Gemini 3 Pro can legitimately take longer than Flash.
      const RESCUE_TIMEOUT_MS = modelIs3Pro ? CALL_TIMEOUT_MS : 12000;
      let rr0: any = null;
      try {
        rr0 = await withTimeout(
          withRetry(() => genai.models.generateContent(rescueReq), {
            maxRetries: 1,
            baseDelayMs: 650,
            label: "rescueEmptyOutput",
          }),
          RESCUE_TIMEOUT_MS
        );
      } catch (e: any) {
        const msg = String(e?.message || e || "");
        // Gemini 3 Pro: some variants reject thinking config fields. Retry once without thinkingConfig.
        if (modelIs3Pro && /thinking/i.test(msg) && /(not supported|only set|invalid)/i.test(msg)) {
          const rescueReqNoThinking: any = {
            ...rescueReq,
            config: { ...(rescueReq.config || {}) },
          };
          try {
            delete rescueReqNoThinking.config.thinkingConfig;
          } catch {}
          rr0 = await withTimeout(
            withRetry(() => genai.models.generateContent(rescueReqNoThinking), {
              maxRetries: 1,
              baseDelayMs: 650,
              label: "rescueEmptyOutputNoThinking",
            }),
            RESCUE_TIMEOUT_MS
          );
        } else {
          throw e;
        }
      }

      if (!rr0) {
        attempts.push({
          label: "rescueEmptyOutput",
          ok: false,
          ms: Date.now() - t2,
          err: `timeout>${RESCUE_TIMEOUT_MS}ms`,
        });
        // timeout이면 원본 결과(빈 응답)를 그대로 두고, route.ts의 이어쓰기 로직에 맡긴다.
        // Update rolling stats for Gemini 3 Pro headroom tuning.
        if (typeof (finalUsage as any)?.reasoningTokens === "number") {
          recordGemini3ProThoughts(opts.model, Number((finalUsage as any).reasoningTokens));
        }

        return {
          text: finalText,
          usage: {
            ...finalUsage,
            latencyMs,
            model: opts.model,
            finishReason: finalFinishReason,
          },
        };
      }

      const rescueResp: any = (rr0 as any)?.value ?? rr0;
      attempts.push({ label: "rescueEmptyOutput", ok: true, ms: Date.now() - t2 });

      const rParts = (rescueResp.candidates?.[0]?.content?.parts || []) as any[];
      const rJoined = rParts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
      const rText = typeof rescueResp.text === "string" ? rescueResp.text : rJoined;

      const rUsage = rescueResp.usageMetadata || rescueResp.usage || {};
      const rFinish = String(rescueResp.candidates?.[0]?.finishReason || rescueResp.finishReason || "");

      const rPrompt = Number(rUsage?.promptTokenCount ?? rUsage?.prompt_tokens ?? 0) || 0;
      const rOut = Number(rUsage?.candidatesTokenCount ?? rUsage?.output_tokens ?? 0) || 0;
      const rTotalRaw = Number(rUsage?.totalTokenCount ?? rUsage?.total_tokens ?? 0) || 0;
      let rReason =
        Number(
          rUsage?.thoughtsTokenCount ??
            rUsage?.thoughts_token_count ??
            rUsage?.thoughtsTokens ??
            rUsage?.thoughts_tokens ??
            rUsage?.reasoningTokens ??
            rUsage?.reasoning_tokens ??
            0
        ) || 0;
      const rReasonInferred = rTotalRaw - rPrompt - rOut;
      if (rReason <= 0 && rReasonInferred > 0) rReason = rReasonInferred;
      const rTotal = rTotalRaw || (rPrompt + rOut + rReason);

      if (String(rText || "").trim()) {
        finalText = String(rText || "");
        finalUsage = {
          promptTokens: rPrompt,
          outputTokens: rOut,
          reasoningTokens: rReason,
          totalTokens: rTotal,
        };
        finalFinishReason = rFinish;
      }
    } catch (e: any) {
      attempts.push({ label: "rescueEmptyOutput", ok: false, ms: Date.now() - t2, err: String(e?.message || e) });
    }
  }

  if (isChatDebug()) {
    console.log(
      JSON.stringify({
        tag: "gemini.resp",
        model: opts.model,
        latencyMs,
        attempts,
        finishReason: finalFinishReason,
        usage: { ...finalUsage },
        textPreview: safePreview(finalText, 240),
      })
    );
  }

  // Update rolling stats for Gemini 3 Pro headroom tuning.
  if (typeof (finalUsage as any)?.reasoningTokens === "number") {
    recordGemini3ProThoughts(opts.model, Number((finalUsage as any).reasoningTokens));
  }

  // (자동 fallback) 거부 응답이면 gemini-2.5-pro로 한 번만 재시도.
  // - opts.disableRefusalFallback === true 면 비활성화 (재귀/특수 호출 방지).
  // (자동 fallback 1) MAX_TOKENS로 응답이 잘려서 본문이 비어버린 경우.
  // - thinking이 너무 많이 써서 visible output이 남지 않은 케이스 (gemini-3.x flash high 단계에서 가끔 발생).
  // - 같은 모델로 1회만 재호출 (output 한도 2배 + thinking 한 단계 낮춤) → 본문 보존.
  // - disableMaxTokensFallback flag로 재귀 가드.
  const maxTokensFallbackDisabled = Boolean((opts as any)?.disableMaxTokensFallback);
  const finishWasMaxTokens = String(finalFinishReason || "").toUpperCase() === "MAX_TOKENS";
  const visibleBodyShort = String(finalText || "").trim().length < 100;
  if (!maxTokensFallbackDisabled && finishWasMaxTokens && visibleBodyShort) {
    try {
      const expandedOut = Math.min(5000, Math.max(2000, Math.floor(Number(opts.maxOutputTokens || 1200) * 2)));
      const reducedReason = Math.max(384, Math.floor(Number(opts.maxReasoningTokens || 768) / 2));
      const fb = await generateText({
        system,
        user,
        opts: {
          ...opts,
          maxOutputTokens: expandedOut,
          maxReasoningTokens: reducedReason,
          disableMaxTokensFallback: true,
          // refusal fallback도 같이 막아 무한 체인 방지 (이미 본문이 비었으면 refusal 감지 X)
          disableRefusalFallback: true,
        },
      });
      return {
        text: (fb as any).text,
        usage: {
          ...(fb as any).usage,
          maxTokensFallback: {
            from: { maxOutputTokens: opts.maxOutputTokens, maxReasoningTokens: opts.maxReasoningTokens },
            to: { maxOutputTokens: expandedOut, maxReasoningTokens: reducedReason },
            reason: "max_tokens_truncation",
          },
        },
      };
    } catch {
      // fallback 실패 시 원본 결과 그대로 반환 (사용자가 적어도 빈 응답이라도 봄)
    }
  }

  // (자동 fallback 2) 거부 응답 감지 시 gemini-2.5-pro로 1회 재시도.
  // - 이미 fallback 모델이면 재시도해도 무의미하므로 건너뛴다.
  const fallbackDisabled = Boolean((opts as any)?.disableRefusalFallback);
  const alreadyFallback = String(opts.model || "").trim() === REFUSAL_FALLBACK_MODEL;
  if (!fallbackDisabled && !alreadyFallback && isRefusalText(finalText)) {
    try {
      const fb = await generateText({
        system,
        user,
        opts: {
          ...opts,
          model: REFUSAL_FALLBACK_MODEL,
          // 사용자 요청: 2.5 pro fallback 시 추론을 "최대한" 쓰도록.
          // maxReasoningTokens=-1 이면 buildThinkingConfig(25pro 분기)가 thinkingBudget=-1(=dynamic/auto)로
          // 보내고, 모델이 필요한 만큼 자율적으로 thoughts 토큰을 사용한다. (HIGH 한계 초과 가능)
          maxReasoningTokens: -1,
          disableRefusalFallback: true,
        },
      });
      return {
        text: (fb as any).text,
        usage: {
          ...(fb as any).usage,
          modelFallback: {
            from: opts.model,
            to: REFUSAL_FALLBACK_MODEL,
            reason: "refusal_detected",
            originalText: finalText.slice(0, 200),
          },
        },
      };
    } catch {
      // fallback 자체가 실패하면 원래 결과를 그대로 반환 (사용자가 적어도 거부 메시지를 볼 수 있게)
    }
  }

  return {
    text: finalText,
    usage: {
      ...finalUsage,
      latencyMs,
      model: opts.model,
      finishReason: finalFinishReason,
      maxOutputTokensRequested,
      maxOutputTokensForProvider,
      effectiveMaxOutputTokens,
      reasoningHeadroomTokens: Math.max(0, Number(effectiveMaxOutputTokens || 0) - Number(maxOutputTokensForProvider || 0)),
      thinkingBudget: (thinkingConfig as any)?.thinkingBudget ?? null,
      thinkingLevel: (thinkingConfig as any)?.thinkingLevel ?? null,
    },
  };
}


export async function generateTextStream(params: {
  system: string;
  user: string;
  opts: ChatGenOpts;
}): Promise<{ stream: AsyncIterable<string>; final: Promise<{ text: string; usage: any }> }> {
  const { system, user, opts } = params;
  throwIfAborted(opts.signal);

  const t0 = Date.now();

  // Keep request construction consistent with generateText() so behavior doesn't change.
  const stopSequences = Array.isArray(opts.stopSequences) ? opts.stopSequences.filter(Boolean) : [];

  const samplingConfig: any = (() => {
    if (!isGemini3Pro(opts.model)) return null;
	  // Prefer per-request overrides (route.ts may tighten sampling to improve format compliance).
	  const tRaw =
	    typeof opts.temperature === "number" && Number.isFinite(opts.temperature)
	      ? opts.temperature
	      : Number(process.env.G3PRO_TEMPERATURE ?? 0.35);
	  const pRaw =
	    typeof opts.topP === "number" && Number.isFinite(opts.topP) ? opts.topP : Number(process.env.G3PRO_TOPP ?? 0.9);
	  const kRaw =
	    typeof opts.topK === "number" && Number.isFinite(opts.topK) ? opts.topK : Number(process.env.G3PRO_TOPK ?? 32);

    const temperature = Number.isFinite(tRaw) ? Math.min(2, Math.max(0, tRaw)) : 0.35;
    const topP = Number.isFinite(pRaw) ? Math.min(1, Math.max(0.05, pRaw)) : 0.9;
    const topK = Number.isFinite(kRaw) ? Math.max(1, Math.floor(kRaw)) : 32;

    return { temperature, topP, topK };
  })();

  const maxOutputTokensRequested = Number(opts.maxOutputTokensRequested ?? opts.maxOutputTokens);
  const maxOutputTokensForProvider = Number(opts.maxOutputTokens ?? maxOutputTokensRequested);
  const thinkingConfig = buildThinkingConfig(opts.model, opts.maxReasoningTokens, maxOutputTokensRequested);
  const effectiveMaxOutputTokens = computeEffectiveMaxOutputTokens(opts.model, maxOutputTokensForProvider, thinkingConfig, system, user);
  const requestModel = providerModelName(opts.model);

  const baseReq: any = {
    model: requestModel,
    contents: [{ role: "user", parts: [{ text: user }] }],
    config: {
      systemInstruction: system,
      maxOutputTokens: effectiveMaxOutputTokens,
      ...(samplingConfig ? samplingConfig : {}),
      ...(stopSequences.length ? { stopSequences } : {}),
    },
  };

  const req: any = thinkingConfig
    ? { ...baseReq, config: { ...baseReq.config, thinkingConfig } }
    : baseReq;

  if (isChatDebug()) {
    console.log(
      JSON.stringify({
        tag: "gemini.req.stream",
        model: opts.model,
        maxOutputTokensRequested,
        maxOutputTokensForProvider,
        maxOutputTokens: effectiveMaxOutputTokens,
        maxReasoningTokens: opts.maxReasoningTokens,
        thinkingBudget: (thinkingConfig as any)?.thinkingBudget ?? null,
        thinkingLevel: (thinkingConfig as any)?.thinkingLevel ?? null,
        temperature: samplingConfig?.temperature ?? null,
        topP: samplingConfig?.topP ?? null,
        topK: samplingConfig?.topK ?? null,
        stopSequences: stopSequences.length ? stopSequences : null,
        systemChars: system.length,
        systemHash: promptHash12(system),
        userChars: user.length,
        systemPreview: safePreview(system, 240),
        userPreview: safePreview(user, 240),
      })
    );
  }

  const CALL_TIMEOUT_MS = resolveCallTimeoutMs(opts.model, opts.timeoutMs);

  // Shared state between iterator + final promise
  let full = "";
  let doneResolve: (() => void) | null = null;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  // Stream call (abortable)
  const linkedAbort = linkedAbortController(opts.signal);
  const controller = linkedAbort.controller;
  const reqWithSignal = {
    ...(req as any),
    config: { ...((req as any).config || {}), abortSignal: controller.signal },
  };

  let streamObj: any = null;
  try {
    const s0 = await withTimeout(
      withRetry(() => (genai.models as any).generateContentStream(reqWithSignal), {
        maxRetries: 0,
        baseDelayMs: 650,
        label: "stream",
      }),
      CALL_TIMEOUT_MS,
      () => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
    );

    // withRetry returns { value, retries }. Unwrap here so the stream normalizer
    // can see the actual SDK stream shape.
    streamObj = (s0 as any)?.value ?? s0;
  } catch (e: any) {
    linkedAbort.dispose();
    // No fallback calls here: callers may require strict single-call behavior.
    if (opts?.logOnError) console.error("generateTextStream stream call failed", e);
    throw e;
  }

  // Normalize SDK stream shapes.
  // @google/genai has shipped multiple shapes across versions:
  //  - { stream: AsyncIterable<chunk>, response: Promise<resp> }
  //  - { stream(): AsyncIterable<chunk>, response(): Promise<resp> }
  //  - AsyncIterable<chunk> (stream object itself)
  const resolveAsyncIterable = (obj: any): AsyncIterable<any> | null => {
    if (obj && typeof obj[Symbol.asyncIterator] === "function") return obj as any;

    const s = obj?.stream;
    if (s) {
      // stream: AsyncIterable
      if (typeof s[Symbol.asyncIterator] === "function") return s as any;
      // stream(): AsyncIterable
      if (typeof s === "function") {
        try {
          const v = s.call(obj);
          if (v && typeof v[Symbol.asyncIterator] === "function") return v as any;
        } catch {
          // ignore
        }
      }
    }

    // Some builds expose `iterator`.
    const it = obj?.iterator;
    if (it && typeof it[Symbol.asyncIterator] === "function") return it as any;

    return null;
  };

  const resolveResponsePromise = (obj: any): Promise<any> | null => {
    const r = obj?.response;
    if (r) {
      if (typeof r.then === "function") return r as any;
      if (typeof r === "function") {
        try {
          const v = r.call(obj);
          if (v && typeof v.then === "function") return v as any;
        } catch {
          // ignore
        }
      }
    }
    return null;
  };

  const streamIt = resolveAsyncIterable(streamObj);
  const responsePromise = resolveResponsePromise(streamObj);

  // If the SDK returned a non-iterable stream shape, avoid a second model call.
// If a response promise exists, await it and yield the full text once.
  if (!streamIt) {
    if (responsePromise) {
      const resp: any = await responsePromise.catch(() => null);
      linkedAbort.dispose();
      throwIfAborted(opts.signal);
      const parts0 = (resp?.candidates?.[0]?.content?.parts || []) as any[];
      const text =
        (typeof (resp as any)?.text === "string" ? (resp as any).text : "") ||
        parts0.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");

      const usage = (resp?.usageMetadata || resp?.usage || {}) as any;
      const finishReason = String(resp?.candidates?.[0]?.finishReason || resp?.finishReason || "");

      const promptTokens = Number(usage?.promptTokenCount ?? usage?.prompt_tokens ?? 0) || 0;
      const outputTokens = Number(usage?.candidatesTokenCount ?? usage?.output_tokens ?? 0) || 0;
      const totalFromUsage = Number(usage?.totalTokenCount ?? usage?.total_tokens ?? 0) || 0;
      let reasoningTokens =
        Number(
          usage?.thoughtsTokenCount ??
            usage?.thoughts_token_count ??
            usage?.thoughtsTokens ??
            usage?.thoughts_tokens ??
            usage?.reasoningTokens ??
            usage?.reasoning_tokens ??
            0
        ) || 0;
      const inferredReasoning = totalFromUsage - promptTokens - outputTokens;
      if (reasoningTokens <= 0 && inferredReasoning > 0) reasoningTokens = inferredReasoning;
      const totalTokens = totalFromUsage || (promptTokens + outputTokens + reasoningTokens);

      const latencyMs = Date.now() - t0;

      const finalUsage: any = {
        promptTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        latencyMs,
        model: opts.model,
        finishReason,
        maxOutputTokensRequested,
        maxOutputTokensForProvider,
        effectiveMaxOutputTokens,
        reasoningHeadroomTokens: Math.max(0, Number(effectiveMaxOutputTokens || 0) - Number(maxOutputTokensForProvider || 0)),
        thinkingBudget: (thinkingConfig as any)?.thinkingBudget ?? null,
        thinkingLevel: (thinkingConfig as any)?.thinkingLevel ?? null,
      };

      async function* once() {
        if (text) yield text;
      }
      return {
        stream: once(),
        final: Promise.resolve({ text, usage: finalUsage }),
      };
    }

    linkedAbort.dispose();
    throw new Error("generateTextStream: non-iterable stream shape");
  }
  const streamIter: AsyncIterable<any> = streamIt;

  const extractChunkText = (chunk: any): string => {
    if (!chunk) return "";
    // Some SDK versions expose `text` directly
    if (typeof chunk.text === "string") return chunk.text;
    // Some expose a method
    if (typeof chunk.text === "function") {
      try {
        const v = chunk.text();
        if (typeof v === "string") return v;
      } catch {
        // ignore
      }
    }
    const parts0 = (chunk?.candidates?.[0]?.content?.parts || []) as any[];
    return parts0.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  };

  // (진단 2026-07) 지연 분해용 스트림 계측:
  // - ttftMs: 첫 가시 청크까지 시간 (프리필+대기+안전필터 홀드 포함)
  // - maxInterChunkMs: 청크 사이 최대 공백 (스트림 중간 멈춤 = 안전필터 홀드/혼잡 정황)
  // thinking=0인데 총 시간이 긴 케이스가 "첫 토큰 대기"인지 "중간 멈춤"인지 구분할 수 있다.
  let tFirstChunkAt = 0;
  let lastChunkAt = 0;
  let maxInterChunkMs = 0;
  let streamChunks = 0;
  // (수정 2026-07) 일부 SDK/엔드포인트 조합은 usageMetadata를 responsePromise가 아니라
  // "마지막 스트림 청크"에 실어 보낸다. 이걸 안 읽으면 스트림 턴의 usage가 0으로 저장되어
  // reasoning/finishReason이 항상 비어 보이는 문제가 있었다. 청크에서도 usage를 수집한다.
  let usageFromChunks: any = null;
  let finishFromChunks = "";
  let streamEndKind = ""; // 진단: done|consumer-break
  let tailDrainChunks = 0; // 진단: 조기중단 후 추가로 읽은 청크 수
  let lastChunkKeys = ""; // 진단: 마지막 청크의 필드 구성

  // 중간 청크의 usageMetadata는 '부분'(trafficType 등만)일 수 있고,
  // prompt/thoughts 수치가 포함된 '완전한' usage는 마지막 청크에만 실린다.
  const usageLooksComplete = (u: any) => Number(u?.promptTokenCount ?? u?.prompt_tokens ?? 0) > 0;

  const collectChunkMeta = (chunk: any) => {
    try {
      const um = chunk?.usageMetadata || chunk?.usage;
      if (um && typeof um === "object") {
        // 더 완전한(늦게 온) usage가 이전 부분 usage를 덮어쓰게 한다.
        if (!usageFromChunks || usageLooksComplete(um) || !usageLooksComplete(usageFromChunks)) {
          usageFromChunks = um;
        }
      }
      const fr = String(chunk?.candidates?.[0]?.finishReason || "");
      if (fr) finishFromChunks = fr;
      if (chunk && typeof chunk === "object") lastChunkKeys = Object.keys(chunk).join(",");
    } catch {
      // ignore
    }
  };

  // NOTE: for-await 대신 이터레이터를 수동으로 잡는다.
  // 소비자(route)가 fence 닫힘 등으로 조기 break하면 for-await는 내부 스트림까지
  // 즉시 닫아버려서, "마지막 청크에 실려 오는 usage/finishReason"을 영영 놓친다.
  // (그동안 스트림 턴의 usage가 추정치로만 저장되던 원인)
  const innerIt: AsyncIterator<any> = (streamIter as any)[Symbol.asyncIterator]();

  async function* iterator(): AsyncIterable<string> {
    try {
      while (true) {
        throwIfAborted(opts.signal);
        const r = await innerIt.next();
        throwIfAborted(opts.signal);
        if (r?.done) {
          streamEndKind = "done";
          break;
        }
        const chunk = r?.value;
        collectChunkMeta(chunk);
        const t = extractChunkText(chunk);
        if (!t) continue;

        const nowChunk = Date.now();
        if (!tFirstChunkAt) tFirstChunkAt = nowChunk;
        if (lastChunkAt) maxInterChunkMs = Math.max(maxInterChunkMs, nowChunk - lastChunkAt);
        lastChunkAt = nowChunk;
        streamChunks += 1;

        // Support both cumulative and incremental chunk styles.
        let delta = t;
        if (t.startsWith(full)) {
          delta = t.slice(full.length);
          full = t;
        } else {
          full += t;
          delta = t;
        }
        if (delta) yield delta;
      }
    } finally {
      // (usage 꼬리 회수) 소비자가 조기 중단해도 usage가 실린 마지막 청크를
      // 잠깐(≤1.2초)만 더 읽어 회수한다. 텍스트는 버린다.
      try {
        if (!streamEndKind) streamEndKind = "consumer-break";
        if (!controller.signal.aborted && !usageLooksComplete(usageFromChunks)) {
          const deadline = Date.now() + 1200;
          while (Date.now() < deadline) {
            const waitMs = Math.max(50, deadline - Date.now());
            const r: any = await Promise.race([
              innerIt.next().catch(() => null),
              new Promise((res) => setTimeout(() => res(undefined), waitMs)),
            ]);
            if (!r || r.done) break;
            tailDrainChunks += 1;
            collectChunkMeta(r.value);
            if (usageLooksComplete(usageFromChunks)) break;
          }
        }
      } catch {
        // ignore
      }
      try {
        innerIt.return?.(undefined as any);
      } catch {
        // ignore
      }
      try {
        doneResolve && doneResolve();
      } catch {
        // ignore
      }
      linkedAbort.dispose();
    }
  }

  const final = (async () => {
    await donePromise;

    let resp: any = null;
    try {
      resp = responsePromise ? await responsePromise : null;
    } catch {
      resp = null;
    }

    // responsePromise가 usage를 안 주는 SDK 조합에서는 마지막 청크에서 수집한 usage로 보강한다.
    const usage = (resp?.usageMetadata || resp?.usage || usageFromChunks || {}) as any;
    const finishReason = String(resp?.candidates?.[0]?.finishReason || resp?.finishReason || finishFromChunks || "");

    const promptTokens = Number(usage?.promptTokenCount ?? usage?.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(usage?.candidatesTokenCount ?? usage?.output_tokens ?? 0) || 0;
    const totalFromUsage = Number(usage?.totalTokenCount ?? usage?.total_tokens ?? 0) || 0;
    let reasoningTokens =
      Number(
        usage?.thoughtsTokenCount ??
          usage?.thoughts_token_count ??
          usage?.thoughtsTokens ??
          usage?.thoughts_tokens ??
          usage?.reasoningTokens ??
          usage?.reasoning_tokens ??
          0
      ) || 0;
    const inferredReasoning = totalFromUsage - promptTokens - outputTokens;
    if (reasoningTokens <= 0 && inferredReasoning > 0) reasoningTokens = inferredReasoning;
    const totalTokens = totalFromUsage || (promptTokens + outputTokens + reasoningTokens);

    const latencyMs = Date.now() - t0;

    const finalUsage: any = {
      promptTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      latencyMs,
      model: opts.model,
      finishReason,
      maxOutputTokensRequested,
      maxOutputTokensForProvider,
      effectiveMaxOutputTokens,
      reasoningHeadroomTokens: Math.max(0, Number(effectiveMaxOutputTokens || 0) - Number(maxOutputTokensForProvider || 0)),
      thinkingBudget: (thinkingConfig as any)?.thinkingBudget ?? null,
      thinkingLevel: (thinkingConfig as any)?.thinkingLevel ?? null,
      // (진단) 지연 분해: 첫 청크까지 / 중간 최대 공백 / 청크 수
      ttftMs: tFirstChunkAt ? tFirstChunkAt - t0 : null,
      maxInterChunkMs,
      streamChunks,
    };

    if (isChatDebug()) {
      console.log(
        JSON.stringify({
          tag: "gemini.resp.stream",
          model: opts.model,
          latencyMs,
          ttftMs: (finalUsage as any).ttftMs,
          maxInterChunkMs,
          streamChunks,
          promptTokens,
          outputTokens,
          reasoningTokens,
          finishReason,
          usageSource: resp?.usageMetadata || resp?.usage ? "resp" : usageFromChunks ? "chunks" : "none",
          streamEndKind,
          tailDrainChunks,
          lastChunkKeys,
        })
      );
    }

    // Update rolling stats for Gemini 3 Pro headroom tuning (best-effort).
    try {
      if (typeof reasoningTokens === "number") {
        recordGemini3ProThoughts(opts.model, Number(reasoningTokens));
      }
    } catch {
      // ignore
    }

    return { text: full, usage: finalUsage };
  })();

  return { stream: iterator(), final };
}


export async function summarizeKorean(params: {
  text: string;
  targetChars: number;
  opts: ChatGenOpts;
  turnRangeLabel?: string;
  perTurnChars?: number;
  guidance?: string;
}) {
  const { text, targetChars, opts, turnRangeLabel, perTurnChars, guidance } = params;

  const rangeLabel = String(turnRangeLabel || "이번 구간");

  // ---- Clean dialogue (keep ai.ts self-contained) ----
  let cleanDialogue = String(text || "");
  // remove fenced blocks (INFO 포함), media markdown, links
  cleanDialogue = cleanDialogue.replace(/```[\s\S]*?```/g, "");
  cleanDialogue = cleanDialogue.replace(/!\[[^\]]*\]\([^\)]+\)/g, "");
  cleanDialogue = cleanDialogue.replace(/\[[^\]]*\]\([^\)]+\)/g, "");
  cleanDialogue = cleanDialogue.replace(/https?:\/\/\S+/g, "");
  // trim junk lines
  cleanDialogue = cleanDialogue
    .split("\n")
    .filter((ln) => {
      const t = ln.trim();
      if (!t) return false;
      if (/^[!\-_=~.]+$/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();

  const extraGuide = guidance ? `\n- 추가 지침: ${guidance}` : "";
  const perTurnHint =
    typeof perTurnChars === "number" && Number.isFinite(perTurnChars) && perTurnChars > 0
      ? `\n- 참고: 턴당 글자수 목표(perTurnChars) ≈ ${Math.floor(perTurnChars)}자`
      : "";

  const system = `너는 소설/대화 로그의 '장기 기억 요약 작가'다.
주어진 [대화]를 읽고, 이후 대화에 참고할 수 있도록 '라벨링 요약'을 만든다.

반드시 한국어로만 답하고, 아래 출력 형식을 절대 어기지 마라.
- 라벨은 정확히 4개: [핵심 사건], [정보/설정], [감정/태도], [합의/약속]
- 각 라벨은 반드시 1줄 이상 작성한다. 내용이 없으면 '없음'이라고 적어라.
- 라벨 줄을 비워두거나, 라벨을 누락하거나, 다른 라벨을 추가하지 마라.
- 불필요한 마크다운(불릿/헤딩/코드블록) 금지. (단, 첫 줄의 '## 장기 기억 (...)' 헤더만 예외)
- 직접 대사 인용(" ", “ ”) 금지. 요지만 서술한다.`;

  const user = `아래 [대화]를 기반으로 장기 기억 요약을 작성해줘.

[요구사항]
1) 문체는 건조한 서술체("~한다", "~했다") 중심으로.
2) 등장인물을 임의로 추가하지 마라. (대화에 없는 제3자/집단 생성 금지)
3) 라벨마다 핵심만 간결히 적되, 너무 짧게(한두 단어) 끝내지 말라.${extraGuide}${perTurnHint}

[출력 형식(절대 준수)]
## 장기 기억 (${rangeLabel})

[핵심 사건] ...
[정보/설정] ...
[감정/태도] ...
[합의/약속] ...

[분량 목표]
- 최소 ${Math.max(120, Math.floor(targetChars * 0.7))}자 ~ 최대 ${Math.floor(targetChars * 1.3)}자

[대화]
${cleanDialogue}`;

  // 요약은 잘리는 경우가 많아 maxOutputTokens를 넉넉하게 확보한다.
  const summaryOpts: ChatGenOpts = {
    ...opts,
    maxOutputTokens: Math.max(1200, Number((opts as any)?.maxOutputTokens || 0)),
  };

  const r = await generateText({ system, user, opts: summaryOpts });

  // ---- Normalize output to the strict label format ----
  const rawOut = String(r.text || "").replace(/\r\n/g, "\n").trim();
  const wantHeader = `## 장기 기억 (${rangeLabel})`;

  const labels = [
    "핵심 사건",
    "정보/설정",
    "감정/태도",
    "합의/약속",
  ] as const;

  // Prefer robust "segment" parsing so we can handle cases like:
  // "[감정/태도] ... [합의/약속] ..."
  const picked: Record<(typeof labels)[number], string[]> = {
    "핵심 사건": [],
    "정보/설정": [],
    "감정/태도": [],
    "합의/약속": [],
  };

  const segRe = /\[(핵심\s*사건|정보\/설정|감정\/태도|합의\/약속)\]\s*[:：]?\s*/g;
  const matches = [...rawOut.matchAll(segRe)];

  const cleanVal = (v: string) => {
    let t = String(v || "");
    // drop any accidental headings / bullets / code fences
    t = t.replace(/^\s*#{1,6}\s*/gm, "");
    t = t.replace(/```[\s\S]*?```/g, " ");
    t = t.replace(/^[\-\*•]\s+/gm, "");
    // avoid direct quotes
    t = t.replace(/[“”"]/g, "");
    // collapse whitespace
    t = t.replace(/\s+/g, " ").trim();
    return t;
  };

  if (matches.length) {
    for (let i = 0; i < matches.length; i++) {
      const m0 = matches[i];
      const keyRaw = String(m0[1] || "").replace(/\s+/g, " ").trim();
      const key = (keyRaw === "핵심 사건" ? "핵심 사건"
        : keyRaw === "정보/설정" ? "정보/설정"
        : keyRaw === "감정/태도" ? "감정/태도"
        : "합의/약속") as (typeof labels)[number];

      const startIdx = (m0.index ?? 0) + String(m0[0]).length;
      const endIdx = i + 1 < matches.length ? (matches[i + 1].index ?? rawOut.length) : rawOut.length;
      const seg = rawOut.slice(startIdx, endIdx);
      const val = cleanVal(seg);
      if (val) picked[key].push(val);
    }
  } else {
    // Fallback: line-based pick
    const lines = rawOut.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
    for (const ln of lines) {
      for (const key of labels) {
        const re = new RegExp(`^\\[${key.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}\\]\\s*[:：]?\\s*(.*)$`);
        const mm = ln.match(re);
        if (mm) {
          const v = cleanVal(String(mm[1] || ""));
          if (v) picked[key].push(v);
          break;
        }
      }
    }
  }

  // Build normalized output (exactly header + 4 label lines)
  const outLines: string[] = [];
  outLines.push(wantHeader);
  outLines.push("");
  for (const key of labels) {
    // Join multiple mentions but keep it one line.
    let v = picked[key].length ? picked[key].join(" / ") : "없음";
    v = cleanVal(v);
    if (!v) v = "없음";
    outLines.push(`[${key}] ${v}`);
  }

  // Trim helper for label values.
  // - Keeps output within budget without adding ellipsis.
  // - Prefers cutting on whitespace/punctuation boundaries when possible.
  const trimSmart = (input: string, maxLen: number): string => {
    const s = String(input || "").replace(/\s+/g, " ").trim();
    const limit = Math.max(0, Math.floor(Number(maxLen) || 0));
    if (!s || limit <= 0) return "";
    if (s.length <= limit) return s;

    // Hard cut, then try to backtrack to a natural boundary.
    let cut = s.slice(0, limit).trimEnd();

    // Backtrack to last whitespace or common punctuation if it exists reasonably close.
    const tail = cut.slice(Math.max(0, cut.length - 20));
    const m = tail.match(/^(.*?)([\s,.;:!?\)\]\}、。！？…])[^\s]*$/);
    if (m && m[1] && m[1].trim().length >= Math.max(4, Math.floor(limit * 0.5))) {
      cut = m[1].trimEnd();
    }

    // Defensive: remove trailing ellipsis/dots.
    cut = cut.replace(/(\u2026|\.{3,})\s*$/g, "").trimEnd();
    return cut;
  };

// Hard enforce the length budget ("턴당 글자" * N턴)
// NOTE: We try to use as much of the target as possible while keeping the 4-label format.
const maxChars = Math.max(20, Math.floor(Number.isFinite(targetChars) ? targetChars : 200));

const headerBlock = wantHeader + "\n\n"; // header + blank line
const prefixes = labels.map((k) => `[${k}] `);

// fixed: headerBlock + label prefixes + newlines between label lines
const fixed = headerBlock.length + prefixes.reduce((a, b) => a + b.length, 0) + 3; // 3 newlines between 4 lines

const budgetForValues = Math.max(0, maxChars - fixed);

// Distribute value budget across 4 labels.
let perLabelBudget = Math.max(6, Math.floor(budgetForValues / 4));

// Re-balance dynamically to fit as close as possible to maxChars
const build = (budget: number) => {
  const lines: string[] = [];
  lines.push(wantHeader);
  lines.push("");
  for (const key of labels) {
    const val = String(outLines.find((ln) => ln.startsWith(`[${key}]`)) || "").replace(/^\[[^\]]+\]\s*/, "");
    const clipped = trimSmart(val, budget);
    lines.push(`[${key}] ${clipped || "없음"}`);
  }
  return lines.join("\n").trim();
};

// Increase budget a bit if we are too short (rare: parser cleaned too much)
let finalText = build(perLabelBudget);

// If too long, shrink budget until it fits.
while (finalText.length > maxChars && perLabelBudget > 4) {
  perLabelBudget -= 2;
  finalText = build(perLabelBudget);
}

// If still too long (extreme tiny target), accept minimal form.
if (finalText.length > maxChars) {
  finalText = build(4);
}

// Remove any trailing ellipsis characters defensively.
finalText = finalText.replace(/(\u2026|\.{3,})\s*$/g, "").trimEnd();

return finalText;
}

// ---------------------------------------------------------------------------
// Long-memory summary (free-form, no headings/labels)
// - Used by /api/chat/memory (long-term memory blocks)
// - Must NOT change summarizeKorean() behavior because /api/chat/send uses it
// ---------------------------------------------------------------------------
export async function summarizeLongMemoryKorean(params: {
  text: string;
  targetChars: number;
  opts: ChatGenOpts;
  guidance?: string;
}) {
  const { text, targetChars, opts, guidance } = params;

  // ---- Clean dialogue (keep ai.ts self-contained) ----
  let cleanDialogue = String(text || "");
  cleanDialogue = cleanDialogue.replace(/```[\s\S]*?```/g, "");
  cleanDialogue = cleanDialogue.replace(/!\[[^\]]*\]\([^\)]+\)/g, "");
  cleanDialogue = cleanDialogue.replace(/\[([^\]]*?)\]\([^\)]+\)/g, "$1");
  cleanDialogue = cleanDialogue.replace(/https?:\/\/\S+/g, "");
  cleanDialogue = cleanDialogue
    .split("\n")
    .filter((ln) => {
      const t = ln.trim();
      if (!t) return false;
      if (/^[!\-_=~.]+$/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();

  const soft = Math.max(60, Math.floor(Number(targetChars) || 240));
  const hard = Math.min(2000, Math.max(80, Math.ceil(soft * 1.15)));
  const extraGuide = guidance ? `\n- 추가 지침: ${guidance}` : "";

  const system = `너는 소설/대화 로그의 장기기억 요약가다.
주어진 내용을 다음 대화에서도 참고할 수 있도록, '핵심만' 자연스러운 한국어 문장으로 압축한다.

출력 규칙(절대 준수):
- 한국어만.
- 말투는 항상 반말(해체, '~다')로 통일. '~요/~습니다' 같은 존댓말 종결 금지.
- 영문 알파벳(A-Z,a-z) 사용 금지. 영어 고유명사/약어는 가능하면 한국어로 옮겨 적거나 풀어써라.
- 마크다운(헤딩/불릿/코드블록) 금지. 평문 문장만.
			- [핵심 사건]/[정보/설정]/[감정/태도]/[합의/약속] 같은 라벨 금지.
- 직접 대사 인용(\"...\") 금지. 요지만 서술.
- 등장인물/사실을 임의로 추가하지 마라.
- 사실 신뢰도는 [사용자]의 명시적 설정·정정 > 제공된 인물별 정본 사실 > 검증된 사건 결과 > [어시스턴트] 지문 순서다.
- [어시스턴트]가 임의로 붙인 체형·외모·나이·직업·정체 형용사는 사용자 설정이나 정본 사실을 변경하는 근거가 아니다.
- [어시스턴트] 지문에만 나온 정적인 신체·프로필 묘사는 사건 요약에 승격하지 마라. 필요한 인물 사실은 별도의 구조화 기억이 담당한다.
- 키·체중·체형·외모를 요약해야 할 때는 반드시 같은 문장에 그 속성 소유자의 고유명사를 쓴다. 현재 화자·장면 초점·기억 대상·가장 가까운 인물에게 다른 참여자의 신체를 옮기지 마라.
- 인물별 사건 기억은 그 인물의 관계·감정 연속성을 위한 기억이지, 사건 문장 속 모든 신체 속성이 그 인물 것이라는 뜻이 아니다.
- 키·체중·나이 등 수치와 정반대인 표현을 동의어·비유로 새로 만들지 마라.
- [사용자]가 직접 확정·정정하거나 '기억해'라고 지정한 설정은 해당 요약에서 생략하지 마라.
- 확정 설정의 인물 고유명사, 별칭, 가족관계의 대상과 세대, 나이·날짜·횟수·수치는 원문 그대로 보존해라.
- 같은 가족 호칭이라도 대상이나 세대가 다르면 별개의 관계이며, 이름 없는 역할 인물을 다른 이름 있는 인물과 합치지 마라.
- 각 인물의 집·자택·거처는 별개의 장소로 유지하고, 사용자가 같은 건물이라고 명시하지 않은 두 거주지를 합치지 마라.
- 'A의 아랫집/윗집'은 오직 A의 거주지 기준이며, 그 이웃이나 층 관계를 B의 집으로 옮기지 마라.
- 방문·잠입·숙박·현재 장면 위치를 거주지 변경이나 이사로 요약하지 마라.
- 인물/관계/설정/목표/약속/미해결/상태 변화 중 원문에서 새로 생기거나 바뀐 핵심만 포함해라.
- 없는 항목을 분량에 맞추려고 만들거나, 앞에서 이미 확정된 사실을 변화 없이 반복하지 마라.
- 순간적인 표정·눈빛·몸짓·말투·욕설·비명·울음은 관계·부상·결정·위치 등 지속 상태를 바꾸지 않으면 생략해라.
- 장기 보존할 새 사실이 적으면 목표 글자수를 억지로 채우지 말고 한 문장으로 짧게 끝내라.
- 사건은 가능한 한 원인→행동→결과 순서로 유지해라.
- 관계 변화는 양쪽 고유명사를 함께 명시해라.
- 호칭/관계 단서가 명확하면 그 표현(예: 선배/오빠/님)을 유지하고, 상충되는 새 호칭을 임의로 만들지 마라.
- 관계/호칭은 발화한 캐릭터에게만 귀속하고, 다른 캐릭터의 관계나 호칭을 복사하지 마라.
- 호칭은 반드시 '발화자 → 수신자 → 호칭'으로 풀어 써라. 'A가 B를 선배님이라고 불렀다'를 'B가 A를 선배님이라고 불렀다'로 뒤집지 마라.
- '선배님, 말씀하세요'처럼 호칭 뒤에 직접 말이 이어지면 현재 발화자가 수신자를 그 호칭으로 부른 것이다. 강요·농담·위장 가족 호칭을 실제 혈연·혼인으로 승격하지 마라.
- [사용자]가 관계/호칭을 부정하거나 정정하면 그 최신 정정을 [어시스턴트]의 이전 서술보다 우선해라.
- 부정된 관계 단어를 긍정 관계로 뒤집지 말고, 부정/철회/정정 상태를 그대로 보존해라.
- 시간 흐름은 과거→현재 순으로 유지하고, 최신 변화/현재 상태를 문장 끝에서 분명히 마무리해라.
- 숫자 정보(나이/횟수/수치/날짜)는 원문 값을 유지해라.
- 기존 사실과 충돌하는 새 정보가 있으면 '변경됨'을 짧게 명시해라.
- 사망/사살/생존/부활/실종/귀환은 해당 인물의 고유명사와 확정 여부를 반드시 함께 보존해라.
- '죽을지도 모른다', '자살할 수 있다', '죽이면', '죽이겠다' 같은 가정·가능성·협박·조건문을 실제 사망이나 '죽음 이후'로 바꾸지 마라.
- 사망은 원문에 실제 완료 사건이 명시된 경우에만 기록하고, 같은 인물이 이후 말하거나 행동하면 생존 근거를 우선해 잘못된 사망 단정을 폐기해라.
- 사망 보도/소문/추정과 실제 사망을 구분하고, 이후 생존 확인이나 오보 정정이 있으면 최신 상태를 명시해라.
- 죽거나 실종된 인물을 후속 장면에서 근거 없이 살아 돌아온 것으로 요약하지 마라.
- 문장을 중간에서 끊지 말고 완결된 문장으로 끝내라.`;

  const user = `아래 [대화]를 읽고 장기기억 요약을 작성해줘.${extraGuide}

[분량]
- 목표: 약 ${soft}자
- 허용 상한: 최대 ${hard}자 (단, 문장 마무리를 위해 약간의 여유는 허용)

[요약 방식]
1) 1~3문장.
2) 사건/관계/상태 중심. 감정/추측은 배제.
3) 문장 끝은 반드시 자연스럽게 마무리.

[대화]
${cleanDialogue}`;

  // Default: downshift Gemini 3 summaries to a faster model (cost/latency).
  // When `opts.noDownshift` is true, keep the caller's model as-is.
  const noDownshift = Boolean((opts as any)?.noDownshift);
  const summaryModel = noDownshift
    ? String(opts.model || "").trim()
    : opts.model && opts.model.startsWith("gemini-3")
      ? GEMINI_3_FLASH_MODEL
      : opts.model;

  const summaryMaxOutputTokens =
    isGemini3Flash(summaryModel) ? 1600 : 900;
  const summaryMaxReasoningTokens =
    // Flash도 thinkingConfig를 완전히 생략하면 hidden thoughts가 과소비되어
    // MAX_TOKENS로 본문이 짧게 잘리는 케이스가 있다. 현재 Flash의 low를 명시한다.
    (isGemini3Pro(summaryModel) || isGemini25Pro(summaryModel) || isGemini3Flash(summaryModel)) ? 128 : 0;

  const summaryOpts: ChatGenOpts = {
    ...opts,
    model: summaryModel,
    // 요약은 길게 필요 없고, 완료 신호를 빨리 받는 게 중요
    // NOTE: Gemini 3 Pro는 thinkingConfig를 생략하면 hidden thoughts가 maxOutputTokens를 잠식해
    // 출력이 짧게 잘리거나(MAX_TOKENS) 빈 응답이 나오는 케이스가 있어, 최소 thinkingBudget(128)을 건다.
    maxOutputTokens: summaryMaxOutputTokens,
    maxReasoningTokens: summaryMaxReasoningTokens,
    timeoutMs: (opts as any)?.timeoutMs ?? resolveLongMemorySummaryTimeoutMs(),
    stopSequences: ["<<<END_OF_OUTPUT>>>"],
  };

  const r = await generateText({ system, user, opts: summaryOpts });
  let out = String(r.text || "").replace(/\r\n/g, "\n").trim();

  // Strip any accidental markdown/headings/bullets.
  out = out.replace(/^\s*#{1,6}\s*.*$/gm, "");
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/^[\-\*•]\s+/gm, "");
  out = out.replace(/[“”"]/g, "");
	// Strip any accidental legacy labels.
	for (const lab of ["[핵심 사건]", "[정보/설정]", "[감정/태도]", "[합의/약속]"]) {
		out = out.split(lab).join("");
	}
  // Some models occasionally leak English labels like "thought Characters:".
  // Keep this conservative: only remove the specific leaked label prefixes.
  out = out.replace(/^\s*(?:thought|analysis|reasoning)\b\s*[:：-]?\s*/i, "");
  out = out.replace(/\b(?:Characters?|Setting)\s*[:：]\s*/gi, "");
  out = out.replace(/\s+/g, " ").trim();

		// Remove rare leaked English meta labels (e.g. "thought Characters:")
	out = out.replace(/^\s*(?:thought|analysis|reasoning)\b\s*[:：\-]?\s*/i, "");
	out = out.replace(/\b(?:Characters?|Setting)\b\s*[:：\-]\s*/gi, "");
  out = normalizeLongMemoryToneBanmal(out);

  const endsNice = (s: string) => {
    const t = String(s || "").trim();
    if (!t) return false;
    if (/[.!?…。]$/.test(t)) return true;
    // Korean declarative endings
    return /(다|요|니다|했다|하였다|된다|됐다|있다|없다|였다|이었다)$/.test(t.replace(/\s+$/g, ""));
  };

  const trimToBoundary = (s: string, limit: number) => {
    const x = String(s || "").trim();
    if (!x) return "";
    if (x.length <= limit) return x;
    const cut = x.slice(0, limit).trimEnd();
    // Prefer sentence punctuation boundary.
    const lastP = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf("…"));
    if (lastP >= Math.floor(limit * 0.45)) return cut.slice(0, lastP + 1).trim();
    // Or whitespace boundary.
    const lastSp = cut.lastIndexOf(" ");
    if (lastSp >= Math.floor(limit * 0.6)) return cut.slice(0, lastSp).trim();
    return cut.trim();
  };

  // Hard cap, but try to preserve a clean sentence ending.
  if (out.length > hard) {
    const clipped = trimToBoundary(out, hard);
    out = clipped;
  }

  // If still not nicely ended and we have a small margin, allow up to +12 chars to finish.
  if (!endsNice(out) && out.length < hard + 12) {
    // If model ended without punctuation, do nothing; server-side post-processor can handle.
    // (We keep ai.ts conservative to avoid hallucinating an ending.)
  }

  return out.trim();
}
// ---------------------------------------------------------------------------
// Long-memory section summary (요약.txt 스타일)
// - Output format (exact):
//   ### <짧은 제목> (<start>-<end>턴)
//   <요약 본문>
// - Body is capped by targetChars and trimmed to a clean sentence/space boundary.
// ---------------------------------------------------------------------------
export async function summarizeLongMemorySectionKorean(params: {
  text: string;
  startTurn: number;
  endTurn: number;
  targetChars: number;
  opts: ChatGenOpts;
  guidance?: string;
  personaName?: string;
}): Promise<string> {
  const { text, startTurn, endTurn, targetChars, opts, guidance, personaName } = params;

  const st = Math.max(1, Math.floor(Number(startTurn) || 1));
  const ed = Math.max(1, Math.floor(Number(endTurn) || 1));
  const turnLabel = `${st}-${ed}턴`;

  // Budget: user 요청(80자/턴 x 3턴) = 240자 목표
  const soft = Math.max(120, Math.floor(Number(targetChars) || 240));
  const hard = Math.min(2000, Math.max(160, Math.ceil(soft * 1.15)));
  const extraGuide = guidance ? `\n- 추가 지침: ${String(guidance).trim()}` : "";

  // ---- Clean dialogue (keep ai.ts self-contained) ----
  let cleanDialogue = String(text || "");
  cleanDialogue = cleanDialogue.replace(/```[\s\S]*?```/g, "");
  cleanDialogue = cleanDialogue.replace(/!\[[^\]]*\]\([^\)]+\)/g, "");
  cleanDialogue = cleanDialogue.replace(/\[([^\]]*?)\]\([^\)]+\)/g, "$1");
  cleanDialogue = cleanDialogue.replace(/https?:\/\/\S+/g, "");
  cleanDialogue = cleanDialogue
    .split("\n")
    .map((ln) => ln.trimEnd())
    .filter((ln) => {
      const t = ln.trim();
      if (!t) return false;
      if (/^[!\-_=~.]+$/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();

  const heroName = String(personaName || "").trim();
  const heroGuide = heroName
    ? `- 주인공 이름은 반드시 '${heroName}'로 표기(\{\{USER\}\} 같은 토큰 금지).`
    : "- 주인공 이름이 명시되어 있으면 그 고유명칭을 그대로 쓰고, 불명확하면 '주인공'으로 표기(\{\{USER\}\} 토큰 금지).";

  const system = `너는 '장기 기억(요약.txt)'에 추가될 한 개의 섹션을 작성하는 요약가다.

대상: 대화의 특정 구간(${turnLabel}).

출력 형식은 반드시 아래 2줄(다른 텍스트 금지):
1) ### <짧은 제목> (${turnLabel})
2) <자연스러운 요약 문단 1개 (1~3문장)>

규칙(절대 준수):
- 한국어만
- 말투는 항상 반말(해체, '~다')로 통일. '~요/~습니다' 같은 존댓말 종결 금지.
- 영문 알파벳(A-Z,a-z) 사용 금지. 영어 고유명사/약어는 가능하면 한국어로 옮겨 적거나 풀어써라.
- 라벨(예: 장소/시점:, 등장인물/세력:)로 줄을 나누지 말고, 1개 문단 안에서 자연스럽게 이어서 서술
- 직접 대사 인용 금지(따옴표/대사 복붙 금지)
- 불릿/번호/표/코드블록/링크/경로/URL 금지
- ${heroGuide}
- 등장인물은 이름/별명/호칭이 대화에 1회라도 등장하면, 요약에서는 반드시 그 고유명칭으로 통일해 표기하고(대명사 대신 이름 반복 허용), \"소녀/사내/남자/여자\" 같은 일반명사로 바꿔치기하지 말 것(이름이 정말 불명확할 때만 일반명사 허용).
- 가능한 한: (1)장소/시점(확실할 때만) (2)주요 인물/세력 (3)발단→핵심 행동→결과 (4)미해결/다음 목표 포함
- 인물/관계/설정/목표/약속/미해결/상태 변화 중 원문에서 새로 생기거나 바뀐 핵심만 포함
- 없는 항목을 분량에 맞추려고 만들거나, 앞에서 이미 확정된 사실을 변화 없이 반복하지 말 것
- 순간적인 표정·눈빛·몸짓·말투·욕설·비명·울음은 관계·부상·결정·위치 등 지속 상태를 바꾸지 않으면 생략
- 장기 보존할 새 사실이 적으면 목표 글자수를 억지로 채우지 말고 한 문장으로 짧게 종료
- 관계 변화는 양쪽 고유명사를 함께 명시
- 호칭/관계 단서가 명확하면 그 표현(예: 선배/오빠/님)을 유지하고, 상충되는 새 호칭을 임의로 만들지 말 것
- 관계/호칭은 발화한 캐릭터에게만 귀속하고, 다른 캐릭터의 관계나 호칭을 복사하지 말 것
- 호칭은 반드시 '발화자 → 수신자 → 호칭'으로 풀어 쓰고, 누가 누구를 불렀는지 역전하지 말 것
- '선배님, 말씀하세요' 같은 직접 호명은 현재 발화자가 수신자를 그 호칭으로 부른 것이며, 강요·농담·위장 가족 호칭은 실제 혈연·혼인으로 승격하지 말 것
- 각 인물의 집·자택·거처는 별개의 장소로 유지하고, 사용자가 같은 건물이라고 명시하지 않은 두 거주지를 합치지 말 것
- 'A의 아랫집/윗집'은 오직 A의 거주지 기준이며, 그 이웃이나 층 관계를 B의 집으로 옮기지 말 것
- 방문·잠입·숙박·현재 장면 위치를 거주지 변경이나 이사로 요약하지 말 것
- [사용자]가 관계/호칭을 부정하거나 정정하면 그 최신 정정을 [어시스턴트]의 이전 서술보다 우선할 것
- 부정된 관계 단어를 긍정 관계로 뒤집지 말고, 부정/철회/정정 상태를 그대로 보존할 것
- 시간 흐름은 구간 시작→종료 순으로 유지하고, 최신 상태/결론을 마지막에 명시할 것
- 숫자 정보(나이/횟수/수치/날짜)는 가능하면 원문 값을 유지
- 기존 사실과 충돌하는 새 정보가 있으면 '변경됨'을 짧게 명시
- 사망/사살/생존/부활/실종/귀환은 해당 인물의 고유명사와 확정 여부를 반드시 함께 보존할 것
- '죽을지도 모른다', '자살할 수 있다', '죽이면', '죽이겠다' 같은 가정·가능성·협박·조건문을 실제 사망이나 '죽음 이후'로 바꾸지 말 것
- 사망은 원문에 실제 완료 사건이 명시된 경우에만 기록하고, 같은 인물이 이후 말하거나 행동하면 생존 근거를 우선해 잘못된 사망 단정을 폐기할 것
- 사망 보도/소문/추정과 실제 사망을 구분하고, 이후 생존 확인이나 오보 정정이 있으면 최신 상태를 명시할 것
- 죽거나 실종된 인물을 후속 장면에서 근거 없이 살아 돌아온 것으로 요약하지 말 것
- 사실/등장인물을 임의로 추가하지 말 것
- 사실 신뢰도는 [사용자]의 명시적 설정·정정 > 제공된 인물별 정본 사실 > 검증된 사건 결과 > [어시스턴트] 지문 순서로 적용할 것
- [어시스턴트]가 임의로 붙인 체형·외모·나이·직업·정체 형용사는 사용자 설정이나 정본 사실을 변경하는 근거로 쓰지 말 것
- [어시스턴트] 지문에만 나온 정적인 신체·프로필 묘사는 사건 요약에 승격하지 말 것. 필요한 인물 사실은 별도의 구조화 기억이 담당함
- 키·체중·체형·외모를 보존할 때는 같은 문장에 속성 소유자의 고유명사를 반드시 쓸 것. 현재 화자·장면 초점·기억 대상에게 다른 참여자의 신체를 옮기지 말 것
- 인물별 사건 기억의 대상은 기억 소유자일 뿐, 사건 문장 속 모든 신체 속성의 소유자가 아님
- 키·체중·나이 등 수치와 정반대인 표현을 동의어·비유로 새로 만들지 말 것
- 본문(2번째 줄)은 약 ${soft}자 이내로 최대한 압축(필요하면 과감히 생략)
- ${soft}자는 최소 분량이 아니라 상한 목표이며, 핵심 정보가 적으면 훨씬 짧아도 됨${extraGuide}

오직 위 형식만 출력하라.`;

  const user = `아래 [대화]를 읽고, ${turnLabel} 구간 요약 섹션을 작성해줘.

[분량]
- 목표: 헤더 1줄 + 본문 1줄(자연 문단) ≈ ${soft}자
- 허용 상한: 최대 ${hard}자(문장 마무리를 위한 소폭 여유만 허용)

[대화]
${cleanDialogue}`;

  // Default: downshift Gemini 3 summaries to a faster model (cost/latency).
  // When `opts.noDownshift` is true, keep the caller's model as-is.
  const noDownshift = Boolean((opts as any)?.noDownshift);
  const summaryModel = noDownshift
    ? String(opts.model || "").trim()
    : opts.model && opts.model.startsWith("gemini-3")
      ? GEMINI_3_FLASH_MODEL
      : opts.model;

  const summaryMaxOutputTokens =
    isGemini3Flash(summaryModel) ? 1600 : 900;
  const summaryMaxReasoningTokens =
    // Flash도 thinkingConfig를 완전히 생략하면 hidden thoughts가 과소비되어
    // MAX_TOKENS로 본문이 짧게 잘리는 케이스가 있다. 현재 Flash의 low를 명시한다.
    (isGemini3Pro(summaryModel) || isGemini25Pro(summaryModel) || isGemini3Flash(summaryModel)) ? 128 : 0;

  const summaryOpts: ChatGenOpts = {
    ...opts,
    model: summaryModel,
    // 요약 섹션은 짧고 안정적으로
    // NOTE: Gemini 3 Pro는 thinkingConfig를 생략하면 hidden thoughts가 maxOutputTokens를 잠식해
    // 출력이 짧게 잘리거나(MAX_TOKENS) 빈 응답이 나오는 케이스가 있어, 최소 thinkingBudget(128)을 건다.
    maxOutputTokens: summaryMaxOutputTokens,
    maxReasoningTokens: summaryMaxReasoningTokens,
    timeoutMs: (opts as any)?.timeoutMs ?? resolveLongMemorySummaryTimeoutMs(),
    stopSequences: ["<<<END_OF_OUTPUT>>>"],
  };

  const r = await generateText({ system, user, opts: summaryOpts });
  let out = String(r.text || "").replace(/\r\n/g, "\n").trim();

  // Remove fenced code blocks and inline code remnants.
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/`+/g, "");

  // Strip URLs aggressively.
  out = out.replace(/https?:\/\/\S+/gi, "");
  out = out.replace(/\b\w+?:\/\/\S+/gi, "");

  // Normalize quotes/asterisks that could look like dialogue or emphasis.
  out = out.replace(/["“”‘’]/g, "");
  out = out.replace(/[\*＊∗﹡⁎]/g, "");

  // Split into non-empty trimmed lines.
  const lines0 = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !!l);

  const isHeadingLine = (l: string) => /^#{1,6}\s+/.test(String(l || "").trim());

  let headingLine = "";
  let bodyLines: string[] = [];

  if (lines0.length > 0 && isHeadingLine(lines0[0])) {
    headingLine = lines0[0];
    bodyLines = lines0.slice(1);
  } else {
    // Sometimes the model omits the heading or places it later.
    const idx = lines0.findIndex((l) => isHeadingLine(l));
    if (idx >= 0) {
      headingLine = lines0[idx];
      bodyLines = [...lines0.slice(0, idx), ...lines0.slice(idx + 1)];
    } else {
      bodyLines = lines0;
    }
  }

  // (핵심) 본문에 섞여 들어오는 헤더(### ...) 제거 → "같은 제목 2번" 중복 방지
  bodyLines = bodyLines.filter((l) => !isHeadingLine(l));

  const ensureRange = (h: string) => {
    const t = String(h || "").trim();
    const has = new RegExp(`\\(\\s*${turnLabel.replace(/[-]/g, "\\-")}\\s*\\)`).test(t);
    if (has) return t;
    const stripped = t.replace(/\([^)]*\)\s*$/g, "").trim();
    return `${stripped} (${turnLabel})`.trim();
  };

  // Normalize heading/title.
  let title = String(headingLine || "").trim();
  title = title.replace(/^#{1,6}\s+/, "");
  title = title.replace(/\([^)]*\)\s*$/g, "").trim();
  title = title.replace(/\s+/g, " ").trim();
  if (!title) title = "요약";
  if (title.length > 28) title = title.slice(0, 28).trim();
  const headerLine = ensureRange(`### ${title}`);

  const stripLabelPrefix = (s: string) =>
    String(s || "")
      .replace(
        /^(장소\s*\/\s*시점|등장인물\s*\/\s*세력|등장인물|발단|핵심\s*행동|결과|미해결\s*(떡밥)?\s*\/\s*(다음\s*)?(목표)?)\s*[:：\-]\s*/,
        ""
      )
      .trim();

  const trimToKoreanBoundary = (s: string, limit: number) => {
    const x = String(s || "").replace(/\s+/g, " ").trim();
    if (!x) return "";
    if (x.length <= limit) return x;
    const cut = x.slice(0, limit).trimEnd();
    const lastP = Math.max(
      cut.lastIndexOf("."),
      cut.lastIndexOf("!"),
      cut.lastIndexOf("?"),
      cut.lastIndexOf("…"),
      cut.lastIndexOf("。")
    );
    if (lastP >= Math.floor(limit * 0.45)) return cut.slice(0, lastP + 1).trim();

    // Prefer Korean sentence endings like "다"/"요".
    // NOTE: allow punctuation/comma right after endings ("...했다,") so we can clip cleanly.
    const ends = ["다", "요", "함", "됨"];
    let best = -1;
    for (const e of ends) {
      const re = new RegExp(`${e}(?=\\s|$|[,.!?…。])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(cut))) {
        best = Math.max(best, m.index + e.length);
      }
    }
    if (best >= Math.floor(limit * 0.45)) {
      const clipped = cut.slice(0, best).trim();
      return /[.!?…。]$/.test(clipped) ? clipped : `${clipped}.`;
    }

    const lastSp = cut.lastIndexOf(" ");
    const bySpace = lastSp >= Math.floor(limit * 0.6) ? cut.slice(0, lastSp).trim() : cut.trim();

    // Avoid obviously dangling one-word fragments at the end (e.g. "...에게 이").
    // If the last token is a 1-char determiner/pronoun/conjunction, drop it.
    const m1 = bySpace.match(/^(.*\S)\s+([가-힣])$/);
    if (m1) {
      const last = m1[2];
      const bad1 = ["이", "그", "저", "내", "네", "제", "또"];
      if (bad1.includes(last)) return String(m1[1]).trim();
    }
    // Also trim trailing connectors if they appear as a final token.
    return bySpace.replace(/\s+(그리고|하지만|또는|및|그래서|즉)\s*$/g, "").trim();
  };

  const hero = heroName || "주인공";

  // Body: collapse to one paragraph (remove any accidental label prefixes).
  let bodyRaw = bodyLines
    .map(stripLabelPrefix)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  // Safety: remove placeholders even if the model slips.
  bodyRaw = bodyRaw.replace(/\{\{USER\}\}/g, hero);
  if (heroName) bodyRaw = bodyRaw.replace(/\b주인공\b/g, heroName);
  bodyRaw = bodyRaw.replace(/\b사용자\b/g, hero);

  // Remove common leaked English meta labels (rare), e.g. "thought Characters:".
  bodyRaw = bodyRaw.replace(/^\s*(?:thought|analysis|reasoning)\b\s*[:：\-]?\s*/i, "");
  bodyRaw = bodyRaw.replace(/\b(?:Characters?|Setting)\b\s*[:：\-]\s*/gi, "");
  bodyRaw = normalizeLongMemoryToneBanmal(bodyRaw);

  // Cap to overall budget (body only).
  // IMPORTANT: allow a small margin (hard) so we can finish a sentence naturally.
  // Otherwise we often cut mid-clause at exactly `soft` chars and the tail fixer appends a '.'
  // which can yield awkward endings like "...에게 이.".
  const overallCap = Math.max(120, hard);
  const bodyFinal = trimToKoreanBoundary(bodyRaw, overallCap);
  return `${headerLine}\n${bodyFinal}`.trim();
}
