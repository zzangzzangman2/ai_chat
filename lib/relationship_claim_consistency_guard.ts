export type RelationshipClaimIdentity = {
  name: string;
  aliases?: string[];
};

export type RelationshipCanonRelation = {
  subjectName: string;
  objectName: string;
  relation: string;
  source?: "manual" | "structured" | "identity" | "contextual";
  sourceRole?: string;
  isManual?: boolean;
  firstSeenTurn?: number;
  lastSeenTurn?: number;
};

export type RelationshipClaimGuardResult = {
  text: string;
  removed: number;
  rewritten: number;
  claims: string[];
};

type FamilyClaim = {
  owner: string;
  target: string;
  relation: string;
};

const FAMILY_RELATIONS = new Set([
  "아버지", "어머니", "부모", "딸", "아들", "자녀",
  "할아버지", "할머니", "조부모", "손녀", "손자", "손자녀",
  "언니", "누나", "오빠", "형", "동생", "여동생", "남동생",
  "자매", "형제", "형제자매", "배우자",
]);

const CHILD_TERMS = new Set(["딸", "아들", "자녀", "아이", "애", "아기", "애기"]);
const PARENT_TERMS = new Set(["아버지", "아빠", "어머니", "엄마", "부모"]);
const SIBLING_TERMS = new Set([
  "언니", "누나", "오빠", "형", "동생", "여동생", "남동생", "자매", "형제", "형제자매",
]);

function clean(value: unknown, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function key(value: unknown) {
  return clean(value, 80).toLocaleLowerCase("ko-KR");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFamilyTerm(value: unknown) {
  const term = clean(value, 30)
    .replace(/^(?:친|양)/u, "")
    .replace(/^(?:첫째|둘째|셋째|막내)\s*/u, "");
  if (term === "아빠") return "아버지";
  if (term === "엄마") return "어머니";
  if (["아이", "애", "아기", "애기"].includes(term)) return "자녀";
  if (term === "남편" || term === "아내") return "배우자";
  return term;
}

function relationIsTrusted(relation: RelationshipCanonRelation) {
  const relationName = normalizeFamilyTerm(relation.relation);
  if (!FAMILY_RELATIONS.has(relationName)) return false;
  if (relation.isManual || relation.source === "manual" || relation.source === "identity") {
    return true;
  }
  if (String(relation.sourceRole || "").toLowerCase() === "user") return true;
  // The graph loader already quarantines one-turn assistant extractions. A
  // structural edge independently observed on later turns can be used to keep
  // ordinary family address intact, while a single generated claim still
  // cannot authenticate itself.
  return (
    relation.source === "structured" &&
    Number(relation.lastSeenTurn || 0) > Number(relation.firstSeenTurn || 0)
  );
}

function addClaim(map: Map<string, FamilyClaim>, owner: string, relation: string, target: string) {
  const ownerName = clean(owner, 80);
  const targetName = clean(target, 80);
  const relationName = normalizeFamilyTerm(relation);
  if (!ownerName || !targetName || ownerName === targetName || !relationName) return;
  map.set(`${key(ownerName)}\u0000${relationName}\u0000${key(targetName)}`, {
    owner: ownerName,
    target: targetName,
    relation: relationName,
  });
}

function familyClaims(relations: RelationshipCanonRelation[]) {
  const claims = new Map<string, FamilyClaim>();
  for (const row of relations.filter(relationIsTrusted)) {
    const subject = clean(row.subjectName, 80);
    const target = clean(row.objectName, 80);
    const relation = normalizeFamilyTerm(row.relation);
    addClaim(claims, subject, relation, target);

    if (relation === "아버지" || relation === "어머니" || relation === "부모") {
      addClaim(claims, target, "자녀", subject);
    } else if (relation === "딸" || relation === "아들" || relation === "자녀") {
      addClaim(claims, target, "부모", subject);
    } else if (relation === "할아버지" || relation === "할머니" || relation === "조부모") {
      addClaim(claims, target, "손자녀", subject);
    } else if (relation === "손녀" || relation === "손자" || relation === "손자녀") {
      addClaim(claims, target, "조부모", subject);
    } else if (SIBLING_TERMS.has(relation)) {
      addClaim(claims, target, "형제자매", subject);
    } else if (relation === "배우자") {
      addClaim(claims, target, "배우자", subject);
    }
  }
  return claims;
}

function compatibleRelations(termRaw: unknown) {
  const term = normalizeFamilyTerm(termRaw);
  if (term === "자녀") return new Set(["딸", "아들", "자녀"]);
  if (term === "부모") return new Set(["아버지", "어머니", "부모"]);
  if (term === "손자녀") return new Set(["손녀", "손자", "손자녀"]);
  if (term === "조부모") return new Set(["할아버지", "할머니", "조부모"]);
  if (SIBLING_TERMS.has(term)) return new Set([term, "형제자매", "형제", "자매"]);
  return new Set([term]);
}

function claimSupported(
  claims: Map<string, FamilyClaim>,
  owner: string,
  target: string,
  relation: string
) {
  const relations = compatibleRelations(relation);
  for (const compatible of relations) {
    if (claims.has(`${key(owner)}\u0000${compatible}\u0000${key(target)}`)) return true;
  }
  return false;
}

function buildIdentityLookup(identities: RelationshipClaimIdentity[]) {
  const variants: Array<{ value: string; canonical: string }> = [];
  const seen = new Set<string>();
  for (const identity of identities) {
    const canonical = clean(identity.name, 80);
    if (!canonical) continue;
    for (const raw of [canonical, ...(identity.aliases || [])]) {
      const value = clean(raw, 80);
      const variantKey = `${key(value)}\u0000${key(canonical)}`;
      if (!value || value.length < 2 || seen.has(variantKey)) continue;
      seen.add(variantKey);
      variants.push({ value, canonical });
    }
  }
  return variants.sort((a, b) => b.value.length - a.value.length);
}

function mentionsIn(
  text: string,
  variants: Array<{ value: string; canonical: string }>,
  offset = 0
) {
  const mentions: Array<{ canonical: string; value: string; index: number; end: number }> = [];
  for (const variant of variants) {
    let from = 0;
    while (from < text.length) {
      const found = text.indexOf(variant.value, from);
      if (found < 0) break;
      mentions.push({
        canonical: variant.canonical,
        value: variant.value,
        index: offset + found,
        end: offset + found + variant.value.length,
      });
      from = found + Math.max(1, variant.value.length);
    }
  }
  return mentions.sort((a, b) => a.index - b.index || b.value.length - a.value.length);
}

function quoteBounds(source: string, at: number) {
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const nextLine = source.indexOf("\n", at);
  const lineEnd = nextLine < 0 ? source.length : nextLine;
  const before = source.slice(lineStart, at);
  const straight = before.lastIndexOf('"');
  const curly = before.lastIndexOf("“");
  const relativeOpen = Math.max(straight, curly);
  const open = relativeOpen >= 0 ? lineStart + relativeOpen : -1;
  if (open < 0) return { lineStart, lineEnd, open: -1, close: -1 };
  const opening = source[open];
  const closing = opening === "“" ? "”" : '"';
  const close = source.indexOf(closing, at);
  if (close < 0 || close > lineEnd) return { lineStart, lineEnd, open: -1, close: -1 };
  return { lineStart, lineEnd, open, close };
}

function inferSpeaker(
  source: string,
  at: number,
  variants: Array<{ value: string; canonical: string }>
) {
  const bounds = quoteBounds(source, at);
  const beforeEnd = bounds.open >= 0 ? bounds.open : at;
  const beforeStart = Math.max(0, beforeEnd - 360);
  const afterStart = bounds.close >= 0 ? bounds.close + 1 : at;
  const afterEnd = Math.min(source.length, afterStart + 180);
  const candidates = [
    ...mentionsIn(source.slice(beforeStart, beforeEnd), variants, beforeStart).map((mention) => ({
      ...mention,
      side: "before" as const,
    })),
    ...mentionsIn(source.slice(afterStart, afterEnd), variants, afterStart).map((mention) => ({
      ...mention,
      side: "after" as const,
    })),
  ];
  let best: { canonical: string; score: number } | null = null;
  for (const mention of candidates) {
    const tail = source.slice(mention.end, Math.min(source.length, mention.end + 90));
    const firstParticle = tail.match(/^\s*(은|는|이|가|께서|을|를|에게|한테)/u)?.[1] || "";
    const speechCue = /^(?:\s*(?:은|는|이|가|께서))?[^.!?。！？\n]{0,55}(?:말했|말을\s*이었|외쳤|소리쳤|대꾸했|답했|중얼거렸|중얼댔|물었|불렀|울부짖었|속삭였|내뱉었)/u.test(tail);
    let score = mention.side === "before"
      ? 120 - Math.min(100, beforeEnd - mention.end)
      : 90 - Math.min(70, mention.index - afterStart);
    if (["은", "는", "이", "가", "께서"].includes(firstParticle)) score += 90;
    if (["을", "를", "에게", "한테"].includes(firstParticle)) score -= 100;
    if (speechCue) score += 140;
    if (!best || score > best.score) best = { canonical: mention.canonical, score };
  }
  return best?.canonical || "";
}

function inferTarget(
  source: string,
  at: number,
  speaker: string,
  variants: Array<{ value: string; canonical: string }>
) {
  const bounds = quoteBounds(source, at);
  const start = Math.max(0, (bounds.open >= 0 ? bounds.open : at) - 520);
  const end = Math.min(source.length, (bounds.close >= 0 ? bounds.close : at) + 120);
  const candidates = mentionsIn(source.slice(start, end), variants, start)
    .filter((mention) => key(mention.canonical) !== key(speaker));
  let best: { canonical: string; score: number } | null = null;
  for (const mention of candidates) {
    const tail = source.slice(mention.end, Math.min(source.length, mention.end + 45));
    const firstParticle = tail.match(/^\s*(은|는|이|가|을|를|에게|한테|와|과)/u)?.[1] || "";
    const distance = Math.abs(at - mention.end);
    let score = 120 - Math.min(115, distance / 3);
    if (["을", "를", "에게", "한테"].includes(firstParticle)) score += 100;
    if (["은", "는", "이", "가"].includes(firstParticle) && mention.index < at) score += 20;
    if (bounds.open >= 0 && mention.index > bounds.open && mention.index < bounds.close) score += 45;
    if (!best || score > best.score) best = { canonical: mention.canonical, score };
  }
  return best?.canonical || "";
}

function hasAnySupportedRelative(claims: Map<string, FamilyClaim>, owner: string, relation: string) {
  const allowed = compatibleRelations(relation);
  for (const claim of claims.values()) {
    if (key(claim.owner) === key(owner) && allowed.has(claim.relation)) return true;
  }
  return false;
}

function trustedUserPairClaim(
  trustedUserTexts: string[],
  owner: string,
  target: string,
  relation: string
) {
  const familyTokens = [...compatibleRelations(relation), relation]
    .flatMap((term) => {
      if (term === "자녀") return ["딸", "아들", "자녀", "아이", "애"];
      if (term === "부모") return ["아버지", "아빠", "어머니", "엄마", "부모"];
      return [term];
    });
  const ownerPattern = escapeRegex(owner);
  const targetPattern = escapeRegex(target);
  const relationPattern = familyTokens.map(escapeRegex).join("|");
  const inverseTokens = CHILD_TERMS.has(normalizeFamilyTerm(relation))
    ? ["아버지", "아빠", "어머니", "엄마", "부모"]
    : PARENT_TERMS.has(normalizeFamilyTerm(relation))
      ? ["딸", "아들", "자녀", "아이", "애"]
      : [];
  const inversePattern = inverseTokens.map(escapeRegex).join("|");
  return trustedUserTexts.some((raw) => {
    const text = String(raw || "");
    if (/[?？]|(?:아니|아니다|아닌|아니라고|착각|오해|거짓|가짜|인\s*척)/u.test(text)) return false;
    const directPatterns = [
      new RegExp(`${ownerPattern}(?:이|가)?(?:의)?\\s*(?:${relationPattern})(?:은|는|이|가|인)?\\s*${targetPattern}`, "u"),
      new RegExp(`${targetPattern}(?:은|는|이|가)?[^.!?。！？\\n]{0,30}${ownerPattern}(?:이|가)?(?:의)?\\s*(?:${relationPattern})`, "u"),
      new RegExp(`${ownerPattern}(?:은|는|이|가)?[^.!?。！？\\n]{0,30}${targetPattern}(?:을|를)\\s*(?:자기|자신|본인)?(?:의)?\\s*(?:${relationPattern})(?:로|라고|이다|야|다)`, "u"),
    ];
    if (inversePattern) {
      directPatterns.push(
        new RegExp(`${ownerPattern}(?:은|는|이|가)?[^.!?。！？\\n]{0,30}${targetPattern}(?:이|가)?(?:의)?\\s*(?:${inversePattern})`, "u")
      );
    }
    return directPatterns.some((pattern) => pattern.test(text));
  });
}

function restoreOuterNarrationMarkers(original: string, value: string) {
  let output = String(value || "").trim();
  if (!output) return "";
  const source = String(original || "").trim();
  if (source.startsWith("*") && !output.startsWith("*")) output = `*${output}`;
  if (source.endsWith("*") && !output.endsWith("*")) output = `${output}*`;
  return output;
}

function neutralFamilyReference(rawTerm: unknown) {
  return CHILD_TERMS.has(normalizeFamilyTerm(rawTerm)) ? "그 아이" : "그 사람";
}

function repairNameReferenceArtifacts(
  text: string,
  variants: Array<{ value: string; canonical: string }>
) {
  let output = text;
  let rewritten = 0;
  const labels = new Set<string>();
  const seenValues = new Set<string>();
  for (const variant of variants) {
    if (seenValues.has(variant.value)) continue;
    seenValues.add(variant.value);
    const name = escapeRegex(variant.value);
    const boundary = "(?<![가-힣A-Za-z0-9])";
    const coordinated = new RegExp(
      `${boundary}${name}(?:이?랑|와|과)\\s*${name}(?=(?:은|는|이|가|을|를|의|에게|한테|에서|으로|로|부터|까지|만|도|\\s|[,，.!?。！？]|$))`,
      "gu"
    );
    output = output.replace(coordinated, () => {
      rewritten += 1;
      labels.add(`중복 인물명: ${variant.canonical}`);
      return variant.value;
    });

    const repeated = new RegExp(
      `${boundary}${name}(?:(?:한테|에게|에서)(?:서)?|으로부터|은|는|이|가|을|를|의|와|과)?\\s*[,，]\\s*${name}(?=(?:은|는|이|가|을|를|의|에게|한테|에서|으로|로|부터|까지|만|도|\\s|[,，.!?。！？]|$))`,
      "gu"
    );
    output = output.replace(repeated, () => {
      rewritten += 1;
      labels.add(`중복 인물명: ${variant.canonical}`);
      return variant.value;
    });

    const pluralized = new RegExp(
      `${boundary}${name}들(?=(?:은|는|이|가|을|를|의|에게|한테|에서|으로|로|부터|까지|만|도))`,
      "gu"
    );
    output = output.replace(pluralized, () => {
      rewritten += 1;
      labels.add(`고유명사 복수화: ${variant.canonical}`);
      return "그들";
    });
  }
  return { text: output, rewritten, labels: [...labels] };
}

function splitLineSentences(line: string) {
  return String(line || "")
    .replace(/([.!?。！？](?:["”']|\*+)?)(\s+)/gu, "$1\u0000")
    .split("\u0000")
    .map((part) => part.trim())
    .filter(Boolean);
}

function explicitClaims(
  sentence: string,
  variants: Array<{ value: string; canonical: string }>
) {
  const names = [...new Set(variants.map((item) => item.value))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  if (!names) return [] as Array<{ owner: string; target: string; relation: string }>;
  const resolve = (raw: string) =>
    variants.find((variant) => key(variant.value) === key(raw))?.canonical || clean(raw, 80);
  const term = "(?:친|양)?(?:딸|아들|자녀|아이|애|아기|애기|아버지|아빠|어머니|엄마|부모|할아버지|할머니|조부모|손녀|손자|손자녀|언니|누나|오빠|형|동생|여동생|남동생|자매|형제|형제자매|배우자|남편|아내)";
  const found: Array<{ owner: string; target: string; relation: string }> = [];
  const patterns = [
    {
      regex: new RegExp(`(${names})(?:은|는|이|가)\\s*(${names})(?:의)?\\s*(${term})(?:이|가|였|인|이다|입니다|라고|라는|로)?`, "gu"),
      map: (m: RegExpMatchArray) => ({ owner: resolve(m[2]), target: resolve(m[1]), relation: normalizeFamilyTerm(m[3]) }),
    },
    {
      regex: new RegExp(`(${names})(?:의)\\s*(${term})\\s*(?:인|인\\s*아이인)?\\s*(${names})`, "gu"),
      map: (m: RegExpMatchArray) => ({ owner: resolve(m[1]), target: resolve(m[3]), relation: normalizeFamilyTerm(m[2]) }),
    },
    {
      regex: new RegExp(`(${names})(?:은|는|이|가)\\s*(${names})(?:을|를)\\s*(?:자기|자신|본인)(?:의)?\\s*(${term})(?:로|라고)?\\s*(?:인식|여기|생각|착각|불렀|소개)`, "gu"),
      map: (m: RegExpMatchArray) => ({ owner: resolve(m[1]), target: resolve(m[2]), relation: normalizeFamilyTerm(m[3]) }),
    },
  ];
  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern.regex)) found.push(pattern.map(match));
  }
  return found;
}

/**
 * Removes explicit family assertions between already-known characters when
 * the relationship is absent from user/manual/identity canon. Ambiguous
 * possessive dialogue such as "우리 애" is rewritten to the referenced name,
 * preventing an affectionate phrase from becoming a new parent-child edge.
 */
export function removeUnsupportedRelationshipClaims(input: {
  text: unknown;
  contextText?: unknown;
  trustedUserTexts?: string[];
  identities?: RelationshipClaimIdentity[];
  relations?: RelationshipCanonRelation[];
}): RelationshipClaimGuardResult {
  const source = String(input.text || "");
  if (!source.trim()) return { text: source, removed: 0, rewritten: 0, claims: [] };
  const identities = input.identities || [];
  const variants = buildIdentityLookup(identities);
  if (variants.length < 2) return { text: source, removed: 0, rewritten: 0, claims: [] };
  const claims = familyClaims(input.relations || []);
  const rejected = new Set<string>();
  let rewritten = 0;
  const contextText = String(input.contextText || "").slice(-1200);
  const inferenceSource = contextText ? `${contextText}\n${source}` : source;
  const inferenceOffset = inferenceSource.length - source.length;

  const possessive = /(?:우리|저희|내|제)\s*(?:(?:첫째|둘째|셋째|막내|친|양)\s*)?(딸|아들|자녀|아이|애|아기|애기|아버지|아빠|어머니|엄마|부모|할아버지|할머니|조부모|손녀|손자|손자녀|언니|누나|오빠|형|동생|여동생|남동생|자매|형제|형제자매|배우자|남편|아내)/gu;
  let rewrittenText = source.replace(possessive, (matched, rawTerm: string, offset: number) => {
    const relation = normalizeFamilyTerm(rawTerm);
    const inferenceAt = inferenceOffset + offset;
    const speaker = inferSpeaker(inferenceSource, inferenceAt, variants);
    if (!speaker) return matched;
    const target = inferTarget(inferenceSource, inferenceAt, speaker, variants);
    if (target) {
      if (
        claimSupported(claims, speaker, target, relation) ||
        trustedUserPairClaim(input.trustedUserTexts || [], speaker, target, relation)
      ) {
        return matched;
      }
      rewritten += 1;
      rejected.add(`${speaker} → ${relation} → ${target}`);
      // Inferring the target is useful for validation, but it is not safe for
      // text generation. Replacing "내 딸" with a nearby name produced broken
      // prose such as "박지아랑 박지아" and even changed the victim. Neutralize
      // the unsupported kinship without inventing a name.
      return neutralFamilyReference(rawTerm);
    }
    if (!hasAnySupportedRelative(claims, speaker, relation)) {
      rewritten += 1;
      rejected.add(`${speaker} → ${relation} → (미확정 대상)`);
      return neutralFamilyReference(rawTerm);
    }
    return matched;
  });

  let removed = 0;
  let inFence = false;
  const lines = rewrittenText.split(/\r?\n/u).map((line) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.trim()) return line;
    const kept = splitLineSentences(line).filter((sentence) => {
      const unsupported = explicitClaims(sentence, variants).filter((claim) =>
        !claimSupported(claims, claim.owner, claim.target, claim.relation) &&
        !trustedUserPairClaim(
          input.trustedUserTexts || [],
          claim.owner,
          claim.target,
          claim.relation
        )
      );
      if (!unsupported.length) return true;
      removed += 1;
      unsupported.forEach((claim) =>
        rejected.add(`${claim.owner} → ${claim.relation} → ${claim.target}`)
      );
      return false;
    });
    return restoreOuterNarrationMarkers(line, kept.join(" "));
  });
  rewrittenText = lines.join("\n").replace(/\n{3,}/gu, "\n\n");
  const nameArtifacts = repairNameReferenceArtifacts(rewrittenText, variants);
  rewrittenText = nameArtifacts.text;
  rewritten += nameArtifacts.rewritten;
  nameArtifacts.labels.forEach((label) => rejected.add(label));

  if (!removed && !rewritten) {
    return { text: source, removed: 0, rewritten: 0, claims: [] };
  }
  return {
    text: rewrittenText,
    removed,
    rewritten,
    claims: [...rejected],
  };
}

export function formatRelationshipCanonGuardBlock(input: {
  relations?: RelationshipCanonRelation[];
}) {
  const claims = [...familyClaims(input.relations || []).values()];
  const exact = claims
    .filter((claim) => !["부모", "자녀", "조부모", "손자녀", "형제자매"].includes(claim.relation))
    .sort((a, b) => a.owner.localeCompare(b.owner, "ko") || a.relation.localeCompare(b.relation, "ko"));
  const lines = [
    "# [FAMILY/IDENTITY CANON HARD GUARD — APPLIES TO EVERY CHAT]",
    "- 등록된 기존 인물 사이의 혈연·혼인 관계는 사용자 직접 설정, 관계도 수동값, 정체성 정본에 있는 항목만 확정 사실이다.",
    "- 아래 목록에 없는 기존 인물 둘을 부모·자녀·형제자매·조부모·배우자로 새로 묶지 않는다. 이전 AI 대사·지문·요약만으로 새 가족관계를 만들거나 기존 가족관계를 다른 인물에게 복사하지 않는다.",
    "- '우리 애/우리 아이/내 딸/내 아들/우리 엄마/우리 아빠' 같은 소유형 가족 표현도 실제 화자와 실제 대상을 먼저 실명으로 해석한 뒤 아래 정사와 일치할 때만 쓴다. 애칭·보호 본능·친근감은 혈연 증거가 아니다.",
    "- 보정 과정에서도 모호한 가족 호칭을 주변 인물의 이름으로 추측 치환하지 않는다. 같은 인물명을 나열하거나 같은 이름·조사구를 연달아 반복하지 않으며, 한 사람의 고유명사에 '들'을 붙여 집단처럼 쓰지 않는다.",
    "- 관계가 불확실하면 가족 호칭을 쓰지 말고 대상의 이름이나 중립 표현을 쓴다. 새 관계가 필요하면 사용자가 설정하기 전까지 확정하지 않는다.",
  ];
  if (exact.length) {
    lines.push("- 현재 확정 가족·혼인 관계:");
    for (const claim of exact.slice(0, 80)) {
      lines.push(`- ${claim.owner} → ${claim.relation} → ${claim.target}`);
    }
  } else {
    lines.push("- 현재 확정 가족·혼인 관계: 없음. 기존 인물끼리 임의 생성 금지.");
  }
  return lines.join("\n");
}
