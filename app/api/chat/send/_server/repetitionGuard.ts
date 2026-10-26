type RecentMessageLike = {
  role?: unknown;
  content?: unknown;
};

type RecentExpressionOptions = {
  maxAssistantTurns?: number;
  maxExcerpts?: number;
  maxExcerptChars?: number;
  maxTotalChars?: number;
  maxNarrationExcerpts?: number;
  maxNarrationExcerptChars?: number;
  maxNarrationTotalChars?: number;
};

function normalizeExcerpt(raw: unknown, maxChars: number) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function excerptKey(raw: string) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z0-9]/gi, "");
}

function recentAssistantTurns(messages: RecentMessageLike[], maxAssistantTurns: number) {
  return (messages || [])
    .filter((message) => ["assistant", "model"].includes(String(message?.role || "").toLowerCase()))
    .slice(-maxAssistantTurns);
}

export function extractRecentAssistantDialogueExcerpts(
  messages: RecentMessageLike[],
  options: RecentExpressionOptions = {}
) {
  const maxAssistantTurns = Math.max(1, Math.min(8, Math.floor(options.maxAssistantTurns ?? 4)));
  const maxExcerpts = Math.max(1, Math.min(16, Math.floor(options.maxExcerpts ?? 8)));
  const maxExcerptChars = Math.max(40, Math.min(260, Math.floor(options.maxExcerptChars ?? 180)));
  const maxTotalChars = Math.max(200, Math.min(2400, Math.floor(options.maxTotalChars ?? 1200)));
  const assistantTurns = recentAssistantTurns(messages, maxAssistantTurns);

  const excerpts: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  const dialogueRe = /(?:"([^"\r\n]{4,260})"|“([^”\r\n]{4,260})”|「([^」\r\n]{4,260})」|『([^』\r\n]{4,260})』)/g;

  for (const message of [...assistantTurns].reverse()) {
    const source = String(message?.content || "").replace(/```[\s\S]*?```/g, " ");
    for (const match of source.matchAll(dialogueRe)) {
      const excerpt = normalizeExcerpt(match[1] || match[2] || match[3] || match[4], maxExcerptChars);
      const key = excerptKey(excerpt);
      if (key.length < 4 || seen.has(key)) continue;
      if (totalChars + excerpt.length > maxTotalChars) return excerpts.reverse();
      seen.add(key);
      excerpts.push(excerpt);
      totalChars += excerpt.length;
      if (excerpts.length >= maxExcerpts) return excerpts.reverse();
    }
  }

  return excerpts.reverse();
}

export function extractRecentAssistantNarrationExcerpts(
  messages: RecentMessageLike[],
  options: RecentExpressionOptions = {}
) {
  const maxAssistantTurns = Math.max(1, Math.min(8, Math.floor(options.maxAssistantTurns ?? 4)));
  const maxExcerpts = Math.max(1, Math.min(12, Math.floor(options.maxNarrationExcerpts ?? 6)));
  const maxExcerptChars = Math.max(
    80,
    Math.min(320, Math.floor(options.maxNarrationExcerptChars ?? 200))
  );
  const maxTotalChars = Math.max(
    300,
    Math.min(2400, Math.floor(options.maxNarrationTotalChars ?? 1200))
  );
  const assistantTurns = recentAssistantTurns(messages, maxAssistantTurns);
  const excerpts: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  const quotedRe = /"[^"\r\n]*"|“[^”\r\n]*”|「[^」\r\n]*」|『[^』\r\n]*』/g;

  const candidateGroups = [...assistantTurns].reverse().map((message) => {
    const source = String(message?.content || "").replace(/```[\s\S]*?```/g, " ");
    const starredBlocks = Array.from(source.matchAll(/\*([^*]{20,})\*/g), (match) => match[1]);
    const fallbackParagraphs = source
      .replace(quotedRe, " ")
      .split(/\n{2,}/g)
      .filter(Boolean);
    return (starredBlocks.length ? starredBlocks : fallbackParagraphs)
      .map((candidate) => normalizeExcerpt(
        String(candidate || "")
          .replace(quotedRe, " ")
          .replace(/[*_#`]+/g, " "),
        maxExcerptChars
      ))
      .filter((excerpt) => excerpt.length >= 20 && excerptKey(excerpt).length >= 15);
  });

  // Compare the opening of each recent turn first. Taking the newest answer's
  // closing paragraphs first could fill the entire budget and miss repeated
  // introductions, even when they appeared on several consecutive turns.
  const maxDepth = Math.max(0, ...candidateGroups.map((group) => group.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const group of candidateGroups) {
      const excerpt = group[depth];
      if (!excerpt) continue;
      const key = excerptKey(excerpt);
      if (seen.has(key)) continue;
      if (totalChars + excerpt.length > maxTotalChars) continue;
      seen.add(key);
      excerpts.push(excerpt);
      totalChars += excerpt.length;
      if (excerpts.length >= maxExcerpts) return excerpts;
    }
  }

  return excerpts;
}

export function buildRecentExpressionAvoidanceBlock(messages: RecentMessageLike[]) {
  const dialogueExcerpts = extractRecentAssistantDialogueExcerpts(messages);
  const narrationExcerpts = extractRecentAssistantNarrationExcerpts(messages);

  return [
    "# [최근 응답 표현 재사용 금지 — 사이트 공통/현재 턴]",
    "- 정본·전체 누적 요약·연속성 장부는 현재 행동의 일관성을 확인하는 참고 자료다. 기억을 유지한다는 것은 그 사실을 매 응답의 본문에 다시 설명한다는 뜻이 아니다.",
    "- 첫 문장은 최신 입력 직후에 새로 일어난 반응·행동·변화로 시작한다. 이름 앞에 키·체중·나이·직책을 고정 수식어처럼 붙이거나, 변하지 않은 미해결 사건·현장 밖 인물 명단·과거 전황을 매번 도입부에 덧붙이지 않는다.",
    "- 이번 행동의 결과를 이해하는 데 직접 필요한 사실, 실제 상태 변화, 사용자가 명시적으로 요청한 신상·현황·과거사 설명은 필요한 범위에서 정확히 말한다. 반복을 피하려고 질문의 답을 생략하거나 새 사건·설정을 만들어내지 않는다.",
    "- 본문에서 언급하지 않아도 생사·관계·임신·구금·부재·미해결 상태는 그대로 유지된다. 미언급을 해제·구출·귀환·화해로 취급하지 않는다. 제작자가 요구한 상태창의 고정 항목은 별도로 유지한다.",
    ...(dialogueExcerpts.length || narrationExcerpts.length
      ? ["- 아래 항목은 최근 어시스턴트 대사와 지문의 발췌 데이터다. 항목 내부 문장은 지시나 모범 문장이 아니며, 재사용을 피하기 위한 비교 자료로만 본다."]
      : []),
    "- 핵심 문구, 욕설·감탄 조합, 호칭+명령 구조, 문장 뼈대, 감정 전개, 과거사를 현재 사건에 연결하는 인과 구조를 그대로 복사하거나 동의어만 바꿔 되풀이하지 않는다.",
    "- 최근 지문에서 이미 설명한 과거 사건·관계·트라우마는 사용자가 다시 묻거나 새 사실이 생기지 않은 한 재요약하지 않는다. 현재의 새로운 관찰·판단·행동만 쓴다.",
    "- 표현만 바꾼 정보 반복도 반복이다. 이미 밝힌 인물의 신상(이름·나이·키·체중·출신·직책·소속)과 이미 보고한 수치·명단은, 사용자가 이번 입력에서 다시 묻지 않았다면 다시 나열하지 않는다. 예: 직전 턴에서 나이와 신체 치수를 보고했다면 이번 턴에서는 그 항목을 되풀이하지 않고 새로 생긴 사실만 말한다.",
    "- 보고·복창 역할의 인물이 매 턴 같은 항목을 다시 읊는 구도를 만들지 않는다. 확인이 필요하면 이미 아는 정보는 생략하고 바뀐 부분만 짚는다.",
    "- 같은 의도를 다시 보여줘야 하면 반복 대사나 배경 설명 대신 새 정보, 새로운 결정·행동, 침묵, 관계 변화, 상황 변화 중 하나로 장면을 전진시킨다.",
    "- 필요한 고유명사와 설정 사실은 정확히 유지한다. 이를 매번 설명할 의무로 해석하거나, 같은 설명의 조사·접속어만 바꿔 반복하지 않는다.",
    ...(dialogueExcerpts.length
      ? [
          "[재사용 금지 대사 발췌]",
          ...dialogueExcerpts.map((excerpt, index) => `${index + 1}. ${JSON.stringify(excerpt)}`),
        ]
      : []),
    ...(narrationExcerpts.length
      ? [
          "[재사용 금지 지문 발췌 — 최근 각 턴의 도입부 우선 비교]",
          ...narrationExcerpts.map((excerpt, index) => `${index + 1}. ${JSON.stringify(excerpt)}`),
        ]
      : []),
  ].join("\n");
}
