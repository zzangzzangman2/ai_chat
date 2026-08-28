export const EVENT_ONLY_META_POLICY_MARKER = "제작자 메타 패널 정책: EVENT_ONLY";
export const ABILITY_VIEW_QUICK_COMMAND_MARKER = "빠른 명령: 능력치 보기";

const EVENT_ONLY_META_POLICY_RE =
  /(?:제작자\s*)?메타\s*패널\s*정책\s*:\s*EVENT(?:[_ -]?ONLY)\b/iu;
const ABILITY_VIEW_QUICK_COMMAND_RE =
  /빠른\s*명령\s*:\s*[^\n]{0,120}능력치\s*보기/u;

export function usesEventOnlyMetaPolicy(...sources: unknown[]): boolean {
  return EVENT_ONLY_META_POLICY_RE.test(sources.map((source) => String(source || "")).join("\n"));
}

export function supportsAbilityViewQuickCommand(...sources: unknown[]): boolean {
  return ABILITY_VIEW_QUICK_COMMAND_RE.test(sources.map((source) => String(source || "")).join("\n"));
}

