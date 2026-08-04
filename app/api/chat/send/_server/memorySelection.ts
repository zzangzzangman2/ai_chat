import { extractSummarySections, type StoredSummarySection } from "./summaryStored";

type TurnRange = { startTurn: number; endTurn: number };

export type HybridMemorySelection = {
  currentArcText: string;
  relatedArchiveText: string;
  currentRanges: TurnRange[];
  relatedRanges: Array<TurnRange & { score: number; fallback: boolean }>;
  totalSections: number;
};

const STOPWORDS = new Set([
  "그리고",
  "하지만",
  "그러나",
  "그래서",
  "이번",
  "지금",
  "다음",
  "계속",
  "상대",
  "사용자",
  "어시스턴트",
  "채팅",
  "대화",
  "장기",
  "블록",
]);

const SEMANTIC_SEARCH_GROUPS: Array<{ pattern: RegExp; tokens: string[] }> = [
  {
    pattern: /(약속|맹세|서약|다짐|합의|정했|하기로|지키기로)/u,
    tokens: ["약속", "맹세", "서약", "다짐", "합의", "하기로", "지키기로"],
  },
  {
    pattern: /(관계|사이|인연|친구|동료|연인|부부|가족|상사|부하|선배|후배)/u,
    tokens: ["관계", "사이", "인연", "친구", "동료", "연인", "부부", "가족", "상사", "부하"],
  },
  {
    pattern: /(결혼|혼인|부부|배우자|남편|아내)/u,
    tokens: ["결혼", "혼인", "부부", "배우자", "남편", "아내"],
  },
  {
    pattern: /(이별|헤어|결별|이혼|절교)/u,
    tokens: ["이별", "헤어", "결별", "이혼", "절교"],
  },
  {
    pattern: /(구조|구출|구해|살려|도왔|도움)/u,
    tokens: ["구조", "구출", "구해", "살려", "도움"],
  },
  {
    pattern: /(사망|죽었|숨졌|살해|목숨)/u,
    tokens: ["사망", "죽었", "숨졌", "살해", "목숨"],
  },
  {
    pattern: /(실종|사라졌|행방|찾기로|찾아야)/u,
    tokens: ["실종", "사라졌", "행방", "찾기로", "찾아야"],
  },
  {
    pattern: /(부상|다쳤|병원|입원|수술|치료)/u,
    tokens: ["부상", "다쳤", "병원", "입원", "수술", "치료"],
  },
  {
    pattern: /(비밀|숨겼|고백|밝혔|정체)/u,
    tokens: ["비밀", "숨겼", "고백", "밝혔", "정체"],
  },
  {
    pattern: /(배신|속였|거짓말|기만)/u,
    tokens: ["배신", "속였", "거짓말", "기만"],
  },
  {
    pattern: /(사진|촬영|찍어|찍은|찍었|카메라|녹화|캡처)/u,
    tokens: ["사진", "촬영", "찍어", "찍은", "찍었", "카메라", "녹화", "캡처"],
  },
  {
    pattern: /(싸움|다툼|갈등|화해|용서)/u,
    tokens: ["싸움", "다툼", "갈등", "화해", "용서"],
  },
];

function stripKoreanParticle(token: string) {
  const stripped = token.replace(
    /(?:에게서|한테서|으로부터|이랑|하고|에게|한테|부터|까지|으로|에서|처럼|보다|랑|와|과|은|는|이|가|을|를|도|만)$/u,
    ""
  );
  return stripped.length >= 2 ? stripped : token;
}

export function memorySearchTokens(text: string) {
  const src = String(text || "").toLowerCase();
  const hits = src.match(/[가-힣a-z0-9]{2,}/g) || [];
  const primaryLine = src.split("\n", 1)[0] || "";
  const primaryHits = primaryLine.match(/[가-힣a-z0-9]{2,}/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const token = String(raw || "").trim();
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) return;
    if (/^\d+$/.test(token) && token.length > 4) return;
    seen.add(token);
    out.push(token);
  };
  const addHits = (items: string[]) => {
    for (const raw of items) {
      const token = raw.trim();
      add(token);
      add(stripKoreanParticle(token));
      if (out.length >= 80) break;
    }
  };

  // queryText is ordered as current user input followed by recent context.
  // Reserve the front of the token budget for the current request and its
  // semantic expansions before recent dialogue can consume all 80 slots.
  addHits(primaryHits);
  for (const group of SEMANTIC_SEARCH_GROUPS) {
    if (!group.pattern.test(src)) continue;
    for (const token of group.tokens) {
      add(token);
      if (out.length >= 80) break;
    }
    if (out.length >= 80) break;
  }
  if (out.length < 80) addHits(hits);
  return out;
}

function explicitTurnRanges(text: string): Array<{ start: number; end: number }> {
  const src = String(text || "");
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of src.matchAll(/(\d{1,6})\s*(?:[-~–—]|부터|에서)\s*(\d{1,6})\s*턴/g)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    ranges.push({ start: Math.min(a, b), end: Math.max(a, b) });
  }
  for (const match of src.matchAll(/(\d{1,6})\s*턴/g)) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) ranges.push({ start: n, end: n });
  }
  return ranges;
}

function rangesOverlap(a: { start: number; end: number }, b: TurnRange) {
  return a.start <= b.endTurn && b.startTurn <= a.end;
}

export type MemoryRetrievalCandidate = {
  startTurn: number;
  endTurn: number;
  text: string;
  boost?: number;
};

export type RankedMemoryRetrievalCandidate<T extends MemoryRetrievalCandidate> = T & {
  score: number;
  primaryMatches: number;
  primaryScore: number;
  contextScore: number;
  explicitMatch: boolean;
};

/**
 * Ranks stored events without allowing a long recent-context tail to drown out
 * the user's current request. A strong current-input match also reserves one
 * slot for the earliest equally relevant event, so foundational events remain
 * retrievable hundreds or thousands of turns later.
 */
export function rankMemoryRetrievalCandidates<T extends MemoryRetrievalCandidate>(params: {
  candidates: T[];
  primaryQueryText: string;
  contextQueryText?: string;
  maxItems: number;
  maxChars: number;
}): Array<RankedMemoryRetrievalCandidate<T>> {
  const primaryTokens = memorySearchTokens(params.primaryQueryText);
  const primaryTokenSet = new Set(primaryTokens);
  const contextTokens = memorySearchTokens(params.contextQueryText || "").filter(
    (token) => !primaryTokenSet.has(token)
  );
  const explicitRanges = explicitTurnRanges(
    [params.primaryQueryText, params.contextQueryText || ""].filter(Boolean).join("\n")
  );

  const ranked = params.candidates
    .map((candidate): RankedMemoryRetrievalCandidate<T> => {
      const hay = String(candidate.text || "").toLowerCase();
      let primaryMatches = 0;
      let primaryScore = 0;
      let contextScore = 0;

      for (const token of primaryTokens) {
        const first = hay.indexOf(token);
        if (first < 0) continue;
        primaryMatches += 1;
        primaryScore += token.length >= 3 ? 12 : 8;
        if (first < 120) primaryScore += 2;
        const occurrences = hay.split(token).length - 1;
        if (occurrences > 1) primaryScore += Math.min(4, occurrences - 1);
      }
      for (const token of contextTokens) {
        const first = hay.indexOf(token);
        if (first < 0) continue;
        contextScore += token.length >= 3 ? 3 : 1;
        if (first < 120) contextScore += 1;
      }

      const explicitMatch = explicitRanges.some((range) =>
        rangesOverlap(range, candidate)
      );
      const score =
        (explicitMatch ? 10_000 : 0) +
        primaryScore +
        contextScore +
        Math.max(0, Number(candidate.boost || 0));
      return {
        ...candidate,
        score,
        primaryMatches,
        primaryScore,
        contextScore,
        explicitMatch,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        Number(b.explicitMatch) - Number(a.explicitMatch) ||
        b.primaryMatches - a.primaryMatches ||
        b.primaryScore - a.primaryScore ||
        b.contextScore - a.contextScore ||
        b.score - a.score ||
        b.endTurn - a.endTurn
    );

  const maxItems = Math.max(0, Math.floor(Number(params.maxItems) || 0));
  const maxChars = Math.max(0, Math.floor(Number(params.maxChars) || 0));
  if (maxItems <= 0 || maxChars <= 0 || ranked.length === 0) return [];

  const picked: Array<RankedMemoryRetrievalCandidate<T>> = [];
  let usedChars = 0;
  const add = (candidate: RankedMemoryRetrievalCandidate<T>) => {
    if (picked.some((item) => item.startTurn === candidate.startTurn && item.endTurn === candidate.endTurn)) {
      return;
    }
    const nextChars = String(candidate.text || "").length + 2;
    if (picked.length >= maxItems) return;
    if (usedChars > 0 && usedChars + nextChars > maxChars) return;
    picked.push(candidate);
    usedChars += nextChars;
  };

  const explicitAnchor = ranked.find((candidate) => candidate.explicitMatch);
  if (explicitAnchor) add(explicitAnchor);

  // Two or more current-input token matches indicate a concrete event lookup.
  // Among equally strong matches, keep the earliest event as the origin anchor.
  // An explicit "N턴" request remains absolute and takes this reserved slot.
  const strongMatches = explicitAnchor
    ? []
    : ranked.filter((candidate) => candidate.primaryMatches >= 2);
  if (strongMatches.length > 0) {
    const bestMatchCount = Math.max(...strongMatches.map((candidate) => candidate.primaryMatches));
    const originMatchFloor = Math.max(2, bestMatchCount - 1);
    const originAnchor = strongMatches
      .filter((candidate) => candidate.primaryMatches >= originMatchFloor)
      .sort(
        (a, b) =>
          a.startTurn - b.startTurn ||
          a.endTurn - b.endTurn ||
          b.primaryMatches - a.primaryMatches ||
          b.primaryScore - a.primaryScore
      )[0];
    if (originAnchor) add(originAnchor);
  }

  for (const candidate of ranked) add(candidate);
  return picked.sort((a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn);
}

function formatSection(section: StoredSummarySection) {
  return `### ${section.title} (${section.startTurn}-${section.endTurn}턴)\n${section.body}`.trim();
}

function sectionChars(section: StoredSummarySection) {
  return formatSection(section).length;
}

/**
 * Builds a bounded hybrid-memory prompt from the full stored summary archive.
 *
 * - The latest story arc is always included, so retrieval failure cannot cause amnesia.
 * - Older sections are selected by lexical/range relevance.
 * - When nothing matches, the two most recent older sections are included as continuity fallback.
 * - The full archive remains in storage and is never deleted by this selector.
 */
export function selectHybridMemory(params: {
  historySummary: string;
  queryText: string;
  primaryQueryText?: string;
  currentArcTurns?: number;
  currentArcMaxChars?: number;
  maxRelatedSections?: number;
  maxRelatedChars?: number;
  fallbackSections?: number;
}): HybridMemorySelection {
  const sections = extractSummarySections(String(params.historySummary || "")).sort(
    (a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn
  );
  const currentArcTurns = Math.max(3, Math.min(60, Math.floor(Number(params.currentArcTurns ?? 15) || 15)));
  const currentArcMaxChars = Math.max(600, Math.min(8000, Math.floor(Number(params.currentArcMaxChars ?? 3200) || 3200)));
  const maxRelatedSections = Math.max(0, Math.min(12, Math.floor(Number(params.maxRelatedSections ?? 6) || 6)));
  const maxRelatedChars = Math.max(0, Math.min(6000, Math.floor(Number(params.maxRelatedChars ?? 2400) || 2400)));
  const fallbackSections = Math.max(0, Math.min(4, Math.floor(Number(params.fallbackSections ?? 2) || 2)));

  if (!sections.length) {
    const legacy = String(params.historySummary || "").trim();
    return {
      currentArcText: legacy ? `# 현재 서사 기억\n${legacy.slice(-currentArcMaxChars)}` : "",
      relatedArchiveText: "",
      currentRanges: [],
      relatedRanges: [],
      totalSections: 0,
    };
  }

  const latestEndTurn = sections[sections.length - 1].endTurn;
  const arcStartTurn = Math.max(1, latestEndTurn - currentArcTurns + 1);
  const current: StoredSummarySection[] = [];
  let currentChars = 0;
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (section.endTurn < arcStartTurn && current.length > 0) break;
    const chars = sectionChars(section) + 2;
    if (current.length > 0 && currentChars + chars > currentArcMaxChars) break;
    current.push(section);
    currentChars += chars;
  }
  current.reverse();
  const currentKeys = new Set(current.map((section) => `${section.startTurn}:${section.endTurn}`));
  const older = sections.filter((section) => !currentKeys.has(`${section.startTurn}:${section.endTurn}`));

  const ranked = rankMemoryRetrievalCandidates({
    candidates: older.map((section) => {
      const text = formatSection(section);
      return {
        section,
        startTurn: section.startTurn,
        endTurn: section.endTurn,
        text,
        boost: /(?:사망|사살|숨졌|죽었|목숨을\s*잃|생존|부활|되살아|실종|행방불명|결혼|이혼|임신|출산)/u.test(text)
          ? 20
          : 0,
      };
    }),
    primaryQueryText: params.primaryQueryText ?? params.queryText,
    contextQueryText: params.queryText,
    maxItems: maxRelatedSections,
    maxChars: maxRelatedChars,
  });
  const picked: Array<{ section: StoredSummarySection; score: number; fallback: boolean }> = ranked.map(
    (item) => ({ section: item.section, score: item.score, fallback: false })
  );
  let relatedChars = ranked.reduce((sum, item) => sum + item.text.length + 2, 0);

  if (!picked.length && fallbackSections > 0 && maxRelatedSections > 0 && maxRelatedChars > 0) {
    // The current arc already contains the latest story. A no-hit fallback must
    // preserve foundational history too, not duplicate only the newest archive.
    const fallbackCandidates =
      fallbackSections <= 1
        ? older.slice(0, 1)
        : [...older.slice(0, fallbackSections - 1), older[older.length - 1]].filter(
            (section, index, all) =>
              section &&
              all.findIndex(
                (item) =>
                  item.startTurn === section.startTurn &&
                  item.endTurn === section.endTurn
              ) === index
          );
    for (const section of fallbackCandidates) {
      if (picked.length >= fallbackSections) break;
      const chars = sectionChars(section) + 2;
      if (relatedChars > 0 && relatedChars + chars > maxRelatedChars) continue;
      picked.push({ section, score: 0, fallback: true });
      relatedChars += chars;
    }
  }

  picked.sort((a, b) => a.section.startTurn - b.section.startTurn);
  const currentArcText = current.length
    ? [
        "# 현재 서사 기억",
        "- 아래 구간은 검색 여부와 관계없이 항상 유지되는 최근 이야기다.",
        current.map(formatSection).join("\n\n"),
      ].join("\n")
    : "";
  const relatedArchiveText = picked.length
    ? [
        "# 관련 과거 사건 기억",
        "- 현재 대화와 관련된 오래된 사건이다. 현재 서사와 충돌하면 더 최근 구간을 우선한다.",
        picked.map((item) => formatSection(item.section)).join("\n\n"),
      ].join("\n")
    : "";

  return {
    currentArcText,
    relatedArchiveText,
    currentRanges: current.map(({ startTurn, endTurn }) => ({ startTurn, endTurn })),
    relatedRanges: picked.map(({ section, score, fallback }) => ({
      startTurn: section.startTurn,
      endTurn: section.endTurn,
      score,
      fallback,
    })),
    totalSections: sections.length,
  };
}
