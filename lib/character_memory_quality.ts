export type CoreMemoryType =
  | "identity"
  | "relationship"
  | "commitment"
  | "major_event"
  | "status_change"
  | "unresolved"
  | "none";

export type CoreMemoryCandidate = {
  memoryType?: unknown;
  importance?: unknown;
  summary?: unknown;
  evidence?: unknown;
};

export type CharacterMemoryQualityRow = {
  rosterId?: unknown;
  turnNo?: unknown;
  summary?: unknown;
  evidence?: unknown;
};

const MEMORY_TYPES = new Set<CoreMemoryType>([
  "identity",
  "relationship",
  "commitment",
  "major_event",
  "status_change",
  "unresolved",
  "none",
]);

const TYPE_SIGNAL_PATTERNS: Record<Exclude<CoreMemoryType, "none">, RegExp> = {
  identity:
    /(이름|본명|성명|나이|\d+\s*살|\d+\s*세|생일|학교(?:에|는|가|를)|\d+\s*학년|\d+\s*반|학급|직업|소속|전공|고향|가족\s*관계|아버지|아빠|어머니|엄마|부모|딸|아들|자녀|손녀|손자|언니|누나|오빠|형|동생|남편|아내|배우자)/u,
  relationship:
    /(관계|부부|배우자|결혼|혼인|이혼|연인|애인|사귀|교제|헤어|결별|친구|절친|소꿉친구|원수|동료|상사|부하|선배|후배|스승|제자|보호자|신뢰|배신|용서|화해|절교|접근\s*금지)/u,
  commitment:
    /(약속|맹세|비밀|계약|거래|빚|은혜|의무|책임|보답|복수|신고하기로|돕기로|지켜주|기다리기로|함께하기로|하지\s*않기로)/u,
  major_event:
    /(사망|죽었|살해|납치|감금|폭행|범행|사고|부상|다쳤|출혈|입원|수술|임신|출산|유산|체포|구속|기소|재판|판결|선고|신고|실종|발견|구조|구출|탈출|해고|퇴학|전학|졸업|입학|취업|퇴직|승진|파혼)/u,
  status_change:
    /(되었|됐어|되기로|시작했|끝났|종료|바뀌|변했|떠났|돌아왔|이사|전학|퇴학|졸업|입학|취업|퇴직|해고|승진|입원|퇴원|체포|구속|석방|결혼|이혼|사귀|헤어|임신|출산|사망|실종|발견)/u,
  unresolved:
    /(아직|계속|미해결|해결되지|찾아야|밝혀야|갚아야|지켜야|기다리|추적|수사|조사|재판|위험|위협|갈등|냉전|오해|의심|행방|약속을\s*남|과제로\s*남)/u,
};

const TRANSIENT_REACTION_PATTERNS: Array<[string, RegExp]> = [
  [
    "hostility",
    /(욕|독설|비난|저주|경멸|분노|화냈|소리쳤|외쳤|고함|노려|째려|모욕|불쾌|차갑게|냉담|적개심|거부|반항|저항)/u,
  ],
  [
    "fear",
    /(공포|두려|무서|겁에|떨며|울먹|오열|비명|애원|빌었|살려\s*달|신음|괴로워)/u,
  ],
  [
    "routine",
    /(인사|물었|질문|대답|답했|설명했|알려줬|칭찬|농담|웃었|고개를|바라봤|외면|침묵|당황)/u,
  ],
];

const DURABLE_THEMES: Array<[string, RegExp]> = [
  ["relationship-transition", /(결혼했|부부가\s*되|배우자가\s*되|이혼했|사귀기\s*시작|연인이\s*되|헤어졌|결별했|친구가\s*되|절교했|화해했|원수가\s*되)/u],
  ["identity-family", /(이름(?:은|이)\s*|나이(?:는|가)\s*|만\s*\d+\s*세|\d+\s*살|직업(?:은|이)\s*|소속(?:은|이)\s*|전공(?:은|이)\s*|(?:아버지|어머니|아빠|엄마|딸|아들|손녀|손자)(?:였|이었|이다|이야|라고\s*밝))/u],
  ["commitment-secret", /(약속했|맹세했|비밀을\s*(?:알려|밝혀|지키)|계약을\s*맺|거래를\s*하기로|빚을\s*갚|보답하기로)/u],
  ["legal-consequence", /(체포|구속|기소|재판|판결|선고|접근\s*금지|수사가\s*시작|신고가\s*접수|경찰에\s*신고했)/u],
  ["medical-status", /(부상을\s*입|다쳤|출혈|입원|퇴원|수술|임신|출산|유산|마비|진단을\s*받)/u],
  ["captivity-violence", /(납치|감금|폭행|범행|살해|구조|구출|탈출)/u],
  ["school-work-status", /(전학했|퇴학|졸업|입학했|취업|퇴직|해고|승진)/u],
  ["location-status", /(이사했|떠났|돌아왔|실종|발견됐|행방을\s*찾)/u],
];

const TOKEN_STOP_WORDS = new Set([
  "그리고",
  "하지만",
  "그러나",
  "그래서",
  "하며",
  "하면서",
  "에게",
  "한테",
  "대한",
  "대해",
  "자신",
  "상대",
  "말했어",
  "대답했어",
  "보였어",
  "드러냈어",
  "나에게",
  "내가",
  "나는",
  "그는",
  "그녀는",
]);

function cleanText(value: unknown, max = 600) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeCoreMemoryType(value: unknown): CoreMemoryType {
  const type = cleanText(value, 40).toLowerCase() as CoreMemoryType;
  return MEMORY_TYPES.has(type) ? type : "none";
}

export function clampMemoryImportance(value: unknown) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(3, parsed));
}

export function hasDurableMemorySignal(value: unknown) {
  const text = cleanText(value, 1200);
  return Object.values(TYPE_SIGNAL_PATTERNS).some((pattern) => pattern.test(text));
}

export function transientReactionTheme(value: unknown) {
  const text = cleanText(value, 1200);
  for (const [theme, pattern] of TRANSIENT_REACTION_PATTERNS) {
    if (pattern.test(text)) return theme;
  }
  return "";
}

export function isCoreMemoryCandidate(candidate: CoreMemoryCandidate) {
  const memoryType = normalizeCoreMemoryType(candidate.memoryType);
  const importance = clampMemoryImportance(candidate.importance);
  const summary = cleanText(candidate.summary, 600);
  const source = `${summary} ${cleanText(candidate.evidence, 600)}`;
  if (memoryType === "none" || importance < 2 || summary.length < 12) return false;

  const typePattern = TYPE_SIGNAL_PATTERNS[memoryType];
  const hasTypeSignal = typePattern.test(source);
  const durable = hasDurableMemorySignal(source);
  const transient = Boolean(transientReactionTheme(source));

  // A repeated emotional reaction is not long-term memory unless the text also
  // contains a durable fact, relationship transition, commitment, or consequence.
  if (transient && !durable) return false;
  if (memoryType === "major_event" || memoryType === "unresolved") {
    return hasTypeSignal || (importance >= 3 && durable);
  }
  return hasTypeSignal;
}

function normalizedMemoryText(value: unknown) {
  return cleanText(value, 1000)
    .toLocaleLowerCase("ko-KR")
    .replace(/[^가-힣a-z0-9]+/giu, " ")
    .trim();
}

function memoryTokens(value: unknown) {
  const tokens =
    normalizedMemoryText(value).match(/[가-힣a-z0-9]{2,}/giu) || [];
  return new Set(tokens.filter((token) => !TOKEN_STOP_WORDS.has(token)));
}

export function memorySimilarity(leftRaw: unknown, rightRaw: unknown) {
  const leftText = normalizedMemoryText(leftRaw);
  const rightText = normalizedMemoryText(rightRaw);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  const left = memoryTokens(leftText);
  const right = memoryTokens(rightText);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, containment * 0.86);
}

export function isNearDuplicateMemory(
  candidate: unknown,
  previous: unknown[],
  threshold = 0.56
) {
  const value = cleanText(candidate, 1000);
  if (!value) return true;
  return previous.some((item) => memorySimilarity(value, item) >= threshold);
}

export function durableMemoryTheme(value: unknown) {
  const text = cleanText(value, 1200);
  for (const [theme, pattern] of DURABLE_THEMES) {
    if (pattern.test(text)) return theme;
  }
  return "";
}

export function isSaturatedMemoryTheme(
  candidate: unknown,
  previous: unknown[],
  maxOccurrences = 2
) {
  const theme = durableMemoryTheme(candidate);
  if (!theme) return false;
  let count = 0;
  for (const item of previous) {
    if (durableMemoryTheme(item) !== theme) continue;
    count += 1;
    if (count >= Math.max(1, maxOccurrences)) return true;
  }
  return false;
}

/**
 * Compresses legacy and newly curated memories before prompt injection.
 * It keeps the newest distinct milestones, at most two per durable theme and
 * one current transient reaction per character.
 */
export function selectCoreMemoryRows<T extends CharacterMemoryQualityRow>(
  rows: T[],
  maxPerRoster = 6
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const rosterId = cleanText(row.rosterId, 120);
    const summary = cleanText(row.summary, 600);
    if (!rosterId || !summary) continue;
    const list = grouped.get(rosterId) || [];
    list.push(row);
    grouped.set(rosterId, list);
  }

  const selected: T[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group].sort(
      (a, b) => Number(b.turnNo || 0) - Number(a.turnNo || 0)
    );
    const kept: T[] = [];
    const themeCounts = new Map<string, number>();
    let genericCount = 0;
    const latestTurn = Math.max(0, Number(sorted[0]?.turnNo || 0));

    for (const row of sorted) {
      if (kept.length >= Math.max(1, maxPerRoster)) break;
      const summary = cleanText(row.summary, 600);
      const evidence = cleanText(row.evidence, 500);
      const combined = `${summary} ${evidence}`;
      if (
        isNearDuplicateMemory(
          summary,
          kept.map((item) => cleanText(item.summary, 600))
        )
      ) {
        continue;
      }

      const theme = durableMemoryTheme(combined);
      const transientTheme = transientReactionTheme(combined);
      const turnNo = Math.max(0, Number(row?.turnNo || 0));
      // Non-durable reactions are useful only as the character's current
      // emotional residue. Never revive an old greeting or ordinary exchange.
      if (!theme && latestTurn - turnNo > 8) continue;

      if (theme) {
        const count = themeCounts.get(theme) || 0;
        if (count >= 2) continue;
        themeCounts.set(theme, count + 1);
      } else if (transientTheme) {
        const key = `transient:${transientTheme}`;
        if ((themeCounts.get(key) || 0) >= 1) continue;
        themeCounts.set(key, 1);
      } else {
        if (genericCount >= 1) continue;
        genericCount += 1;
      }
      kept.push(row);
    }
    selected.push(...kept);
  }

  return selected.sort(
    (a, b) =>
      Number(a.turnNo || 0) - Number(b.turnNo || 0) ||
      cleanText(a.rosterId, 120).localeCompare(cleanText(b.rosterId, 120), "ko")
  );
}
