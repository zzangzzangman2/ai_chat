// Selects message slices by assistant-turn ranges.
// A "turn" here means one assistant response (completed). The slice includes
// user+assistant messages around those turns.

export function selectMessagesForAssistantTurnRange(msgs: any[], startTurn: number, endTurn: number) {
  const st = Math.max(1, Math.floor(startTurn));
  const ed = Math.max(st, Math.floor(endTurn));

  const firstUserPos = msgs.findIndex((m: any) => m?.role === "user");

  const asstIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if ((msgs[i]?.role === "assistant" || msgs[i]?.role === "model") && (firstUserPos < 0 || i > firstUserPos)) asstIdx.push(i);
  }
  if (!asstIdx.length) return [];

  const endAsstPos = asstIdx[ed - 1] ?? asstIdx[asstIdx.length - 1];

  // 시작 구간은 "직전 assistant 다음"부터 잡아서 해당 턴의 user 입력을 포함시킨다.
  let startPos = 0;
  // 1턴은 "첫 user 입력"부터 시작 (프롤로그 assistant 메시지 제외)
  if (st === 1 && firstUserPos >= 0) startPos = firstUserPos;
  if (st > 1 && asstIdx[st - 2] != null) startPos = asstIdx[st - 2] + 1;
  if (firstUserPos >= 0) startPos = Math.max(firstUserPos, startPos);

  // endPos는 해당 턴의 assistant까지 포함
  const endPos = Math.min(msgs.length - 1, endAsstPos);

  if (startPos < 0) startPos = 0;
  if (startPos > endPos) startPos = 0;

  return msgs.slice(startPos, endPos + 1);
}

// 위 함수와 동일하되, 메시지 인덱스 상한(maxExclusive) 이전까지만 포함하도록 캡핑한다.
// - tail(최근 K턴 원문)과 요약 입력이 중복되는 것을 줄이기 위한 용도.
// - maxExclusive는 msgs 배열에서 '포함하지 않을 첫 인덱스'이다. (slice end-exclusive)
export function selectMessagesForAssistantTurnRangeCapped(
  msgs: any[],
  startTurn: number,
  endTurn: number,
  maxExclusive: number
) {
  const cap = Math.max(0, Math.floor(Number(maxExclusive) || 0));
  if (cap <= 0) return [];

  const st = Math.max(1, Math.floor(startTurn));
  const ed = Math.max(st, Math.floor(endTurn));

  const firstUserPos = msgs.findIndex((m: any) => m?.role === "user");

  const asstIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if ((msgs[i]?.role === "assistant" || msgs[i]?.role === "model") && (firstUserPos < 0 || i > firstUserPos)) asstIdx.push(i);
  }
  if (!asstIdx.length) return [];

  const endAsstPos = asstIdx[ed - 1] ?? asstIdx[asstIdx.length - 1];

  // 시작 구간은 "직전 assistant 다음"부터 잡아서 해당 턴의 user 입력을 포함시킨다.
  let startPos = 0;
  // 1턴은 "첫 user 입력"부터 시작 (프롤로그 assistant 메시지 제외)
  if (st === 1 && firstUserPos >= 0) startPos = firstUserPos;
  if (st > 1 && asstIdx[st - 2] != null) startPos = asstIdx[st - 2] + 1;
  if (firstUserPos >= 0) startPos = Math.max(firstUserPos, startPos);

  // endPos는 해당 턴의 assistant까지 포함하되, cap 이전까지만
  const endPos0 = Math.min(msgs.length - 1, endAsstPos);
  const endPos = Math.min(endPos0, cap - 1);

  if (startPos < 0) startPos = 0;
  if (startPos >= cap) return [];
  if (startPos > endPos) return [];

  return msgs.slice(startPos, endPos + 1);
}
