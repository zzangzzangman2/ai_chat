import { sanitizePromptForModel } from "./textPolicy";

// Small LRU cache for sanitizePromptForModel() results.
// 목적: 동일한 preset/persona/note/lore/formatGuide 블록을 매 요청마다 sanitize하며
// 불필요한 문자열/정규식 비용을 줄여 "첫 토큰" 체감을 개선한다.
const MAX_ENTRIES = 64;
const lru = new Map<string, string>();

export function sanitizePromptCached(input: string): string {
  const key = String(input ?? "");
  const hit = lru.get(key);
  if (hit !== undefined) {
    // refresh LRU
    lru.delete(key);
    lru.set(key, hit);
    return hit;
  }

  const out = sanitizePromptForModel(key);
  lru.set(key, out);

  if (lru.size > MAX_ENTRIES) {
    const first = lru.keys().next().value as string | undefined;
    if (first) lru.delete(first);
  }

  return out;
}
