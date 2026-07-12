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
  "기억",
  "요약",
  "블록",
]);

function searchTokens(text: string) {
  const hits = String(text || "").toLowerCase().match(/[가-힣a-z0-9]{2,}/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hits) {
    const token = raw.trim();
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue;
    if (/^\d+$/.test(token) && token.length > 4) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 80) break;
  }
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

  const tokens = searchTokens(params.queryText);
  const ranges = explicitTurnRanges(params.queryText);
  const scored = older
    .map((section) => {
      const hay = `${section.title}\n${section.body}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        const first = hay.indexOf(token);
        if (first < 0) continue;
        score += token.length >= 3 ? 4 : 2;
        if (first < 120) score += 1;
        const occurrences = hay.split(token).length - 1;
        if (occurrences > 1) score += Math.min(3, occurrences - 1);
      }
      for (const range of ranges) {
        if (rangesOverlap(range, section)) score += 100;
      }
      return { section, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.section.endTurn - a.section.endTurn);

  const picked: Array<{ section: StoredSummarySection; score: number; fallback: boolean }> = [];
  let relatedChars = 0;
  for (const item of scored) {
    if (picked.length >= maxRelatedSections) break;
    const chars = sectionChars(item.section) + 2;
    if (relatedChars > 0 && relatedChars + chars > maxRelatedChars) continue;
    picked.push({ ...item, fallback: false });
    relatedChars += chars;
  }

  if (!picked.length && fallbackSections > 0 && maxRelatedSections > 0 && maxRelatedChars > 0) {
    for (let i = older.length - 1; i >= 0 && picked.length < fallbackSections; i--) {
      const section = older[i];
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
