import { splitTrailingFenceBlockAtEnd } from "./textPolicy";

export function buildManualContinuationPrompt(params: {
  continueTail: string;
  targetChars: number;
}) {
  const continueTail = String(params.continueTail || "").trim();
  const targetChars = Math.max(200, Math.floor(Number(params.targetChars) || 0));
  const minimumChars = Math.max(200, Math.floor(targetChars * 0.9));

  return [
    `다음은 직전 어시스턴트 출력의 마지막 부분이다. 반드시 이 내용의 '다음 문장'부터 이어서 작성하라.`,
    `- 이것은 직전 사용자 행동에 다시 답하는 새 턴이 아니다. 직전 질문·명령·행동을 재현하거나 다시 반응하지 않는다.`,
    `- 아래 직전 출력은 참고 문맥이며 다시 출력할 본문이 아니다. 마지막 문장까지 한 번도 복사하지 않는다.`,
    `- 이미 쓴 문장 반복/요약/재시작 금지.`,
    `- 장면/시점/말투를 유지하고, 전개만 자연스럽게 이어간다.`,
    `- 이번 추가 본문도 약 ${targetChars}자(최소 약 ${minimumChars}자)로 충분히 전개하고 문장을 완결한다.`,
    `- 메타/STATUS/INFO/코드블록/설명문 금지.`,
    `[직전 어시스턴트 출력 끝부분]\n${continueTail}`,
    ``,
    `바로 다음 문장부터 새로운 본문만 출력하라.`,
  ].join("\n");
}

export function mergeManualContinuationBase(baseRaw: string, deltaRaw: string): string {
  const baseParts = splitTrailingFenceBlockAtEnd(String(baseRaw || ""));
  const deltaParts = splitTrailingFenceBlockAtEnd(String(deltaRaw || ""));
  const baseBody = baseParts.body.trimEnd();
  let deltaBody = deltaParts.body.trim();
  const finalMeta = deltaParts.meta.trim() || baseParts.meta.trim();

  if (!baseBody) return [deltaBody, finalMeta].filter(Boolean).join("\n\n").trim();
  if (!deltaBody) return [baseBody, finalMeta].filter(Boolean).join("\n\n").trim();

  // A model can replay all or part of the supplied tail before continuing.
  // Remove only an exact suffix/prefix overlap; never delete new prose by a
  // fuzzy similarity guess.
  if (deltaBody.startsWith(baseBody)) {
    deltaBody = deltaBody.slice(baseBody.length).trimStart();
  } else if (baseBody.startsWith(deltaBody) && deltaBody.length >= Math.floor(baseBody.length * 0.7)) {
    deltaBody = "";
  } else {
    const max = Math.min(4000, baseBody.length, deltaBody.length);
    for (let size = max; size >= 8; size -= 1) {
      if (baseBody.slice(-size) === deltaBody.slice(0, size)) {
        deltaBody = deltaBody.slice(size).trimStart();
        break;
      }
    }
  }

  const mergedBody = deltaBody ? `${baseBody}\n${deltaBody}`.trim() : baseBody;
  // Status/meta belongs at the very end. Keeping the old panel between the
  // original answer and its continuation made the second half look like a new
  // turn and encouraged repeated user reactions.
  return [mergedBody, finalMeta].filter(Boolean).join("\n\n").trim();
}
