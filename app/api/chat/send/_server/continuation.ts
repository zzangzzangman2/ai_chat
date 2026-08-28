import { splitTrailingFenceBlockAtEnd } from "./textPolicy";

type ContinuationAnchorOptions = {
  maxChars?: number;
  maxParagraphs?: number;
};

function trimParagraphTailAtBoundary(raw: string, maxChars: number) {
  const text = String(raw || "").trim();
  if (text.length <= maxChars) return text;

  const sliced = text.slice(-maxChars);
  // Do not start the anchor in the middle of a sentence when a nearby sentence
  // boundary exists. Keeping the end is more important than filling maxChars.
  const boundary = sliced.match(/[.!?。！？]["”’']?\s+/u);
  const boundaryEnd = boundary?.index == null ? -1 : boundary.index + boundary[0].length;
  return (boundaryEnd >= 0 ? sliced.slice(boundaryEnd) : sliced).trimStart();
}

/**
 * Manual continuation is anchored to the visible endpoint, not to an arbitrary
 * character window. A long character slice can contain an earlier unfinished-
 * looking beat (for example, "주문."), which makes the model backtrack and
 * replay events that the answer has already moved past.
 */
export function selectManualContinuationAnchor(
  baseRaw: string,
  options: ContinuationAnchorOptions = {}
) {
  const maxChars = Math.max(
    400,
    Math.min(2000, Math.floor(options.maxChars ?? 1200))
  );
  const maxParagraphs = Math.max(
    1,
    Math.min(6, Math.floor(options.maxParagraphs ?? 2))
  );
  const body = splitTrailingFenceBlockAtEnd(String(baseRaw || "")).body.trim();
  if (!body) return "";

  const paragraphs = body
    // Models occasionally omit the blank line between novel paragraphs. Each
    // rendered line is still a safer endpoint unit than a 4,000-character tail.
    .split(/\r?\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (!paragraphs.length) return trimParagraphTailAtBoundary(body, maxChars);

  const selected: string[] = [];
  for (
    let index = paragraphs.length - 1;
    index >= 0 && selected.length < maxParagraphs;
    index -= 1
  ) {
    const paragraph = paragraphs[index];
    const nextLength =
      paragraph.length + (selected.length ? 2 : 0) + selected.join("\n\n").length;
    if (selected.length && nextLength > maxChars) break;
    selected.unshift(
      selected.length === 0 && paragraph.length > maxChars
        ? trimParagraphTailAtBoundary(paragraph, maxChars)
        : paragraph
    );
  }

  return selected.join("\n\n").trim();
}

export function buildManualContinuationPrompt(params: {
  continueTail: string;
  targetChars: number;
}) {
  const continueTail = String(params.continueTail || "").trim();
  const targetChars = Math.max(200, Math.floor(Number(params.targetChars) || 0));
  const minimumChars = Math.max(200, Math.floor(targetChars * 0.9));

  return [
    `다음은 직전 어시스턴트 출력에서 실제 화면에 표시된 마지막 문단들이다. 반드시 마지막 문단의 사건이 끝난 직후부터 이어서 작성하라.`,
    `- 이것은 직전 사용자 행동에 다시 답하는 새 턴이 아니다. 직전 질문·명령·행동을 재현하거나 다시 반응하지 않는다.`,
    `- 아래 기준점의 모든 사건·대사·감정 반응은 이미 완료됐다. 표현만 바꾼 재묘사, 같은 인물의 같은 반응, 요약, 복사, 재시작을 모두 금지한다.`,
    `- 앞부분에 미완성처럼 보이는 사건이나 생략된 중간 단계가 있었더라도 되돌아가 보충하지 않는다. 화면의 마지막 문단을 유일한 시간적 끝점으로 취급한다.`,
    `- 첫 문장부터 새 행동·새 대사·시간 경과·상황 변화 중 하나를 발생시켜 장면을 최소 한 단계 앞으로 이동한다.`,
    `- 장면/시점/말투는 유지하되 이미 나온 신체 특징·인물 소개·감정 결론을 다시 열거하지 않는다.`,
    `- 이번 추가 본문도 약 ${targetChars}자(최소 약 ${minimumChars}자)로 충분히 전개하고 문장을 완결한다.`,
    `- 메타/STATUS/INFO/코드블록/설명문 금지.`,
    `[이어쓰기 기준점 — 이미 출력 완료된 마지막 문단들]\n${continueTail}`,
    ``,
    `기준점의 마지막 문장 다음에 붙을 새로운 본문만 출력하라.`,
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
