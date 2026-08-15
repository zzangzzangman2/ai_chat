export const GEMINI_25_PRO_MODEL = "gemini-2.5-pro" as const;
// Legacy constant name is preserved for callers while the selected Flash model advances.
// (2026-08-14) 3.6 → 3.7. Vertex(global)에서 gemini-3.7-flash 제공 확인.
export const GEMINI_3_FLASH_MODEL = "gemini-3.7-flash" as const;
export const GEMINI_31_PRO_MODEL = "gemini-3.1-pro-preview" as const;
export const DEFAULT_CHAT_MODEL = GEMINI_31_PRO_MODEL;

export const CHAT_MODEL_IDS = [
  GEMINI_25_PRO_MODEL,
  GEMINI_3_FLASH_MODEL,
  GEMINI_31_PRO_MODEL,
] as const;

export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];

export const CHAT_MODEL_ID_SET: ReadonlySet<string> = new Set(CHAT_MODEL_IDS);

export function stripProviderPrefix(model: string): string {
  const raw = String(model || "").trim();
  if (!raw) return "";
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

export function normalizeModelId(model: string): string {
  const m = stripProviderPrefix(model).trim().toLowerCase();
  if (!m) return "";

  if (m === "gemini-2-5-flash" || m === "gemini-2.5-flash") return GEMINI_25_PRO_MODEL;
  if (m === "gemini-2-5-pro") return GEMINI_25_PRO_MODEL;

  if (
    m === "gemini-3-flash" ||
    m === "gemini-3-flash-preview" ||
    m === "gemini-3.1-flash" ||
    m === "gemini-3.1-flash-preview" ||
    m === "gemini-3.1-flash-lite" ||
    m === "gemini-3.1-flash-lite-preview" ||
    m === "gemini-3.5-flash" ||
    m === "gemini-3.5-flash-preview" ||
    m === "gemini-3.5-flash-lite" ||
    m === "gemini-3.6-flash-preview" ||
    // 3.6에서 3.7로 올리면서, 기존 대화/설정에 저장된 3.6 값도 현재 Flash로 흡수한다.
    m === "gemini-3.6-flash" ||
    m === "gemini-3.7-flash-preview"
  ) {
    return GEMINI_3_FLASH_MODEL;
  }

  if (m === "gemini-3-pro" || m === "gemini-3-pro-preview" || m === "gemini-3.1-pro") {
    return GEMINI_31_PRO_MODEL;
  }

  return m;
}

export function isAllowedChatModel(model: string): model is ChatModelId {
  return CHAT_MODEL_ID_SET.has(normalizeModelId(model));
}

export function coerceChatModelId(model: string, fallback: ChatModelId = DEFAULT_CHAT_MODEL): ChatModelId {
  const normalized = normalizeModelId(model);
  return CHAT_MODEL_ID_SET.has(normalized) ? (normalized as ChatModelId) : fallback;
}

export function providerModelNameForGemini(model: string): string {
  const normalized = normalizeModelId(model);
  if (CHAT_MODEL_ID_SET.has(normalized)) return normalized;
  return stripProviderPrefix(model) || model;
}

export function defaultReasoningTokensForModel(model?: string): number {
  if (model && isGemini36FlashModel(model)) return 640;
  if (model && isGemini3FlashModel(model)) return 0;
  return 384;
}

export function isGemini3ProModel(model: string): boolean {
  return /^gemini-3(?:\.\d+)?-pro(?:-|$)/i.test(normalizeModelId(model));
}

export function isGemini31ProModel(model: string): boolean {
  return /^gemini-3\.1-pro(?:-|$)/i.test(normalizeModelId(model));
}

export function isGemini36FlashModel(model: string): boolean {
  return normalizeModelId(model) === GEMINI_3_FLASH_MODEL;
}

export function isGemini3FlashModel(model: string): boolean {
  return /^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(normalizeModelId(model));
}

export function isGemini3Model(model: string): boolean {
  return /^gemini-3(?:[.-]|$)/i.test(normalizeModelId(model));
}

// ──────────────────────────────────────────────────────────────────────
// 추론(사고) 프리셋 — UI 버튼과 서버 매핑의 단일 출처
// ──────────────────────────────────────────────────────────────────────
//
// (2026-08-15) 기존에는 UI(textUtils.getReasoningPresets)와 서버(ai.buildThinkingConfig)가
// 각자 매핑 테이블을 들고 있었고, 그 사이에 낀 값이 서로 다르게 해석됐다.
// 실측: 3.1 Pro(LOW=384)에서 3.7 Flash로 모델만 바꾼 방에 384가 그대로 남았는데
//   - UI  : 최근접 반올림 → |0-384|=384 vs |640-384|=256 → "MID"로 표시
//   - 서버: 하한 밴딩 → t>=256 → thinkingLevel "low"로 전송
// 화면은 MID(medium)라고 하는데 실제로는 low가 나가고 reasoningTokens=0으로 돌았다.
// 프리셋 표를 여기 한 곳에 두고 UI/서버가 같이 참조한다.
export type ReasoningPresetLevel = "zero" | "low" | "middle" | "high";

export function reasoningPresetsForModel(model: string): Record<ReasoningPresetLevel, number> {
  if (isGemini3ProModel(model)) {
    // zero 슬롯은 UI에서 FAST로 노출되며 공식 지원 레벨인 low에 매핑된다.
    return { zero: 0, low: 384, middle: 768, high: 1536 };
  }
  // NOTE: isGemini36FlashModel()은 legacy 상수명이라 현재 GEMINI_3_FLASH_MODEL(=3.7)에
  // 매치된다. 여기서는 "실제 3.6"만 걸러야 하므로 버전을 명시적으로 검사한다.
  // (기존 UI 표와 동일하게 유지 — 3.7 Flash는 아래 3-flash 분기로 간다.)
  if (/^gemini-3\.6-flash(?:-|$)/i.test(normalizeModelId(model))) {
    return { zero: 640, low: 640, middle: 640, high: 1024 };
  }
  if (isGemini3FlashModel(model)) {
    // LOW는 latency 우선 minimal, MID/HIGH는 thinkingLevel로 매핑한다.
    return { zero: 0, low: 0, middle: 640, high: 1024 };
  }
  // gemini-2.5-pro
  return { zero: 0, low: 384, middle: 768, high: 2048 };
}

/**
 * 해당 모델의 UI 버튼으로 실제 만들 수 있는 값인지 검사한다.
 * 모델 교체 시 이전 모델의 값이 "범위 안"이라는 이유만으로 살아남아
 * 어느 버튼에도 대응하지 않는 고아 값이 되는 것을 막는 용도.
 */
export function isReasoningPresetValue(model: string, tokens: number): boolean {
  const t = Number(tokens);
  if (!Number.isFinite(t)) return false;
  return Object.values(reasoningPresetsForModel(model)).includes(Math.floor(t));
}

export function isGemini25ProModel(model: string): boolean {
  const m = normalizeModelId(model);
  return m === GEMINI_25_PRO_MODEL || m.startsWith(`${GEMINI_25_PRO_MODEL}-`);
}
