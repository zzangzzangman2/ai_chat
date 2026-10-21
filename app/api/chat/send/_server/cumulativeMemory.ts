import { extractSummarySections } from "./summaryStored";

function sectionKey(section: ReturnType<typeof extractSummarySections>[number]) {
  return JSON.stringify([
    section.startTurn, section.endTurn, section.title,
    section.body.replace(/\s+/gu, " ").trim(),
  ]);
}

/** Stored summaries already compress the raw dialogue. They are the baseline
 * on every request, not retrieval candidates. Never sample ranges or slice a
 * sentence here: doing so can lose an event or detach its negation.
 *
 * Retrieval adds details; it cannot replace this baseline. This is a pure,
 * per-request view with no model call, storage write or cross-chat cache.
 */
export function buildCumulativeMemoryPrompt(params: {
  historySummary: string;
  currentArcText?: string;
  relatedArchiveText?: string;
  recallSummaryText?: string;
  rosterText?: string;
  rawEvidenceText?: string;
}) {
  const summary = String(params.historySummary || "").trim();
  const sections = extractSummarySections(summary);
  const seenSections = new Set(sections.map(sectionKey));
  const seenBlocks = new Set([summary].filter(Boolean));
  const supplements: string[] = [];
  for (const value of [
    // Without a stored archive (new/legacy chats), preserve the existing fallback.
    summary ? "" : params.currentArcText,
    params.recallSummaryText,
    params.relatedArchiveText,
  ]) {
    const text = String(value || "").trim();
    if (!text || seenBlocks.has(text) || summary.includes(text)) continue;
    seenBlocks.add(text);
    const pieces = text.split(/(?=^\s*###\s+)/mu);
    const kept = pieces.filter((piece) => {
      const parsed = extractSummarySections(piece);
      if (parsed.length !== 1) return true;
      const key = sectionKey(parsed[0]);
      if (seenSections.has(key)) return false;
      seenSections.add(key);
      return true;
    });
    // Do not leave an empty retrieval heading after removing duplicate sections.
    if (extractSummarySections(text).length && !kept.some(piece => extractSummarySections(piece).length)) continue;
    const extra = kept.join("").trim();
    if (extra) supplements.push(extra);
  }
  const cumulativeBlock = summary ? [
    "# 전체 이야기 누적 요약 — 매 응답의 기본 기억",
    "- 아래 저장된 요약은 검색어와 무관하게 처음부터 최근까지 모두 참고한다. 관련 검색은 세부 근거의 보충이며 이 누적 흐름을 대체하지 않는다.",
    "- 과거 사건과 현재 상태를 구분한다. 명시적인 정정·상태 변화는 시간순으로 반영하며, 최신 원문에서 확정한 생사·관계·지속 상태가 요약의 오기보다 우선한다.",
    "- 세계관 기록이 모든 NPC의 지식은 아니다. 각 인물은 실제 목격·전달·확인 근거가 있는 사실만 알고 행동한다.",
    summary,
  ].join("\n") : "";
  const text = [
    cumulativeBlock,
    ...supplements,
    params.rosterText,
    params.rawEvidenceText,
  ].filter(value => String(value || "").trim()).join("\n\n");
  return {
    text,
    summaryChars: summary.length,
    ranges: sections.map(({ startTurn, endTurn }) => ({ startTurn, endTurn })),
    supplementChars: supplements.join("\n\n").length,
  };
}
