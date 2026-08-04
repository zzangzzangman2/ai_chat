export type CharacterScopeRow = {
  id: string;
  name: string;
  aliases?: string;
};

export type RelationshipCorrection = {
  text: string;
  terms: string[];
};

const RELATIONSHIP_TERMS = [
  "서방",
  "남편",
  "아내",
  "부인",
  "신랑",
  "각시",
  "연인",
  "애인",
  "배우자",
  "가족",
  "아버지",
  "어머니",
  "아빠",
  "엄마",
  "형님",
  "형",
  "누나",
  "오빠",
  "언니",
  "동생",
  "주인",
  "상전",
  "부하",
  "친구",
  "선배",
  "후배",
  "스승",
  "제자",
] as const;

const CORRECTION_MARKER =
  /(?:아니(?:야|다|라고|라|고|지|ㄴ|는|었|었어)?|아닌|아냐|아님|내가\s*왜|내가왜|잘못|틀렸|정정|거부|부르지\s*마|호칭하지\s*마|말고)/i;
const NEGATION_MARKER =
  /(?:아니(?:야|다|라고|라|고|지|ㄴ|는|었|었어)?|아닌|아냐|아님|잘못|틀렸|정정|거부|부정|금지|철회|취소|부르지\s*마|호칭하지\s*마|말고)/i;

export function stripFencedBlocks(text: string) {
  return String(text || "").replace(/```[\s\S]*?```/g, " ");
}

function parseAliases(raw: string) {
  const src = String(raw || "").trim();
  if (!src) return [] as string[];
  const out: string[] = [];
  const add = (value: unknown) => {
    const alias = String(value || "").trim();
    if (alias) out.push(alias);
  };

  try {
    const parsed = JSON.parse(src);
    if (Array.isArray(parsed)) parsed.forEach(add);
    else if (Array.isArray(parsed?.aliases)) parsed.aliases.forEach(add);
  } catch {}

  src.split(/[\n,;\/|]+/g).forEach(add);
  return Array.from(new Set(out));
}

export function findFocusedCharacterIds(rows: CharacterScopeRow[], focusText: string) {
  const haystack = stripFencedBlocks(focusText).toLowerCase();
  const ids = new Set<string>();
  if (!haystack.trim()) return ids;

  for (const row of rows) {
    const canonicalName = String(row.name || "").trim().toLowerCase();
    const aliases = parseAliases(String(row.aliases || ""))
      .map((name) => name.trim().toLowerCase())
      // One-character aliases collide with ordinary word fragments. Keep them
      // stored, but do not use them for automatic current-turn focus.
      .filter((name) => name.length >= 2);
    const canonicalMentioned =
      canonicalName.length >= 2
        ? haystack.includes(canonicalName)
        : canonicalName.length === 1
          ? haystack.split(/[^\p{L}\p{N}]+/gu).includes(canonicalName)
          : false;
    if (canonicalMentioned || aliases.some((name) => haystack.includes(name))) {
      ids.add(String(row.id || ""));
    }
  }
  return ids;
}

function userSegments(source: string) {
  const src = String(source || "");
  const segments: string[] = [];
  if (src.includes("[사용자]")) {
    const re = /\[사용자\]\s*([\s\S]*?)(?=\n\n\[(?:사용자|어시스턴트)\]|$)/g;
    for (const match of src.matchAll(re)) {
      const value = String(match[1] || "").trim();
      if (value) segments.push(value);
    }
    return segments;
  }

  // Character-turn refresh uses "[페르소나명 입력]" instead of "[사용자]".
  // Keep assistant output out of correction detection in that path as well.
  if (/\[[^\]\n]{1,80}\s+입력\]/.test(src)) {
    const re = /\[[^\]\n]{1,80}\s+입력\]\s*([\s\S]*?)(?=\n\n\[어시스턴트 응답\]|$)/g;
    for (const match of src.matchAll(re)) {
      const value = String(match[1] || "").trim();
      if (value) segments.push(value);
    }
    return segments;
  }

  return [src];
}

export function extractRelationshipCorrections(source: string): RelationshipCorrection[] {
  const corrections: RelationshipCorrection[] = [];
  for (const segment of userSegments(stripFencedBlocks(source))) {
    if (!CORRECTION_MARKER.test(segment)) continue;
    const terms: string[] = [];
    for (const term of RELATIONSHIP_TERMS) {
      if (!segment.includes(term)) continue;
      if (terms.some((existing) => existing.includes(term))) continue;
      terms.push(term);
    }
    if (!terms.length) continue;
    corrections.push({ text: segment.replace(/\s+/g, " ").trim().slice(0, 300), terms: [...terms] });
  }
  return corrections.slice(-3);
}

export function buildRelationshipCorrectionGuidance(source: string) {
  const corrections = extractRelationshipCorrections(source);
  if (!corrections.length) return "";
  return [
    "- (최우선) 아래는 사용자가 직접 밝힌 관계/호칭 정정이다. 이전 어시스턴트 대사나 기억보다 우선한다.",
    `  - 정정 감지 관계어: ${Array.from(new Set(corrections.flatMap((item) => item.terms))).join(", ")}`,
    "  - 구체적인 대상과 긍정/부정 방향은 최신 사용자 입력을 그대로 따른다.",
    "- 정정에서 부정된 관계를 긍정 관계로 뒤집거나, 부정된 호칭을 해당 인물이 계속 쓰는 것으로 기록하지 말 것.",
  ].join("\n");
}

function termContexts(summary: string, term: string) {
  const src = String(summary || "");
  const contexts: string[] = [];
  let from = 0;
  while (from < src.length) {
    const index = src.indexOf(term, from);
    if (index < 0) break;
    contexts.push(src.slice(Math.max(0, index - 28), Math.min(src.length, index + term.length + 28)));
    from = index + term.length;
  }
  return contexts;
}

export function analyzeRelationshipCorrectionDrift(source: string, summary: string) {
  const corrections = extractRelationshipCorrections(source);
  if (!corrections.length) return { ok: true, reason: "no_correction", terms: [] as string[] };

  const terms = Array.from(new Set(corrections.flatMap((item) => item.terms)));
  const contradicted: string[] = [];
  for (const term of terms) {
    const termCorrections = corrections.filter((item) => item.terms.includes(term));
    const hasMixedAssignment = termCorrections.some((item) => {
      const contexts = termContexts(item.text, term);
      const hasDeniedUse = contexts.some((context) => NEGATION_MARKER.test(context));
      const hasAffirmedUse = contexts.some((context) => !NEGATION_MARKER.test(context));
      return (hasDeniedUse && hasAffirmedUse) || /(?:맞아|맞다|맞고|맞음|맞는)/.test(item.text);
    });
    // "A는 아니고 B는 맞다"처럼 같은 관계어의 소유자가 갈리는 문장은
    // 단어 단위 검증으로 판정하지 않고 프롬프트의 캐릭터 경계 규칙에 맡긴다.
    if (hasMixedAssignment) continue;

    const contexts = termContexts(summary, term);
    if (!contexts.length) continue;
    if (contexts.some((context) => !NEGATION_MARKER.test(context))) contradicted.push(term);
  }

  return contradicted.length
    ? { ok: false, reason: "relationship_correction_reversed", terms: contradicted }
    : { ok: true, reason: "ok", terms };
}
