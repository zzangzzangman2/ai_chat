export const DEFAULT_CHAT_MODEL = "gemini-2.5-pro" as const;
// (변경 2026-05) gemini-3-flash-preview → gemini-3.5-flash. 변수명은 보존(하위 호환).
export const GEMINI_3_FLASH_MODEL = "gemini-3.5-flash" as const;
export const GEMINI_31_PRO_MODEL = "gemini-3.1-pro-preview" as const;

export const CHAT_MODEL_IDS = [
  DEFAULT_CHAT_MODEL,
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

  if (m === "gemini-2-5-flash" || m === "gemini-2.5-flash") return DEFAULT_CHAT_MODEL;
  if (m === "gemini-2-5-pro") return DEFAULT_CHAT_MODEL;

  if (
    m === "gemini-3-flash" ||
    m === "gemini-3-flash-preview" ||
    m === "gemini-3.1-flash" ||
    m === "gemini-3.1-flash-preview" ||
    m === "gemini-3.1-flash-lite" ||
    m === "gemini-3.1-flash-lite-preview" ||
    m === "gemini-3.5-flash-preview" ||
    m === "gemini-3.5-flash-lite"
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
  if (model && isGemini3FlashModel(model)) return 0;
  return 384;
}

export function isGemini3ProModel(model: string): boolean {
  return /^gemini-3(?:\.\d+)?-pro(?:-|$)/i.test(normalizeModelId(model));
}

export function isGemini31ProModel(model: string): boolean {
  return /^gemini-3\.1-pro(?:-|$)/i.test(normalizeModelId(model));
}

export function isGemini3FlashModel(model: string): boolean {
  return /^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(normalizeModelId(model));
}

export function isGemini3Model(model: string): boolean {
  return /^gemini-3(?:[.-]|$)/i.test(normalizeModelId(model));
}

export function isGemini25ProModel(model: string): boolean {
  const m = normalizeModelId(model);
  return m === DEFAULT_CHAT_MODEL || m.startsWith(`${DEFAULT_CHAT_MODEL}-`);
}
