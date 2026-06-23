// Character-based budgeting helpers.
// Uses Array.from to count unicode codepoints consistently.

export function strlen(s: string): number {
  return Array.from(String(s || "")).length;
}

export function sliceChars(s: string, n: number): string {
  return Array.from(String(s || "")).slice(0, n).join("");
}

export function truncateToCharBudget(text: string, budget: number, hardLimit = budget + 120): string {
  let s = (text ?? "").trimEnd();
  if (!budget || budget <= 0) return s;

  if (s.length <= budget) return s;

  const max = Math.min(s.length, Math.max(budget, hardLimit));
  const slice = s.slice(0, max);

  // We prefer cutting at a "clean" boundary even if it ends slightly earlier than budget.
  const minGood = Math.max(0, Math.floor(budget * 0.65));

  const searchStart = Math.max(0, budget - 280);
  const searchEnd = Math.min(max, budget + 180);
  const window = slice.slice(searchStart, searchEnd);

  let best = -1;
  const consider = (absPos: number) => {
    if (absPos >= minGood && absPos <= max && absPos > best) best = absPos;
  };

  // 1) Paragraph / line boundaries (Korean novel-style outputs often have \n)
  const p2 = window.lastIndexOf("\n\n");
  if (p2 !== -1) consider(searchStart + p2 + 2);

  const p1 = window.lastIndexOf("\n");
  if (p1 !== -1) consider(searchStart + p1 + 1);

  const endsWithTrailingEllipsis = (value: string) => {
    const t = String(value || "")
      .trimEnd()
      .replace(/["'”’\)\]\}\*〉》」』]+$/g, "")
      .trimEnd();
    return /(?:\.{2,}|…+|⋯+|。。。+)$/.test(t);
  };

  // 2) Sentence-ending punctuation (include Korean/JP punctuation, but not ellipsis)
  //    Also allow an optional closing quote right after the punctuation.
  const endRe = /(?:[.!?]+|[。！？]+)(?:["'”’\)]{0,2})/g;
  let m: RegExpExecArray | null;
  while ((m = endRe.exec(window))) {
    const nextCut = searchStart + m.index + m[0].length;
    if (endsWithTrailingEllipsis(slice.slice(0, nextCut))) continue;
    consider(nextCut);
  }

  // 3) Common Korean sentence endings even without explicit punctuation
  //    e.g., "...했다" / "...한다" / "...이다" etc. (cut AFTER the ending)
  const koEndRe = /(?:다|요|죠|니다|습니다)(?:\s*["'”’\)]{0,2})/g;
  while ((m = koEndRe.exec(window))) {
    // only accept if it's followed by whitespace/newline/end within window
    const endIdx = m.index + m[0].length;
    const next = window[endIdx] ?? "";
    if (next === "" || next === " " || next === "\n") consider(searchStart + endIdx);
  }

  if (best !== -1) return slice.slice(0, best).trimEnd();

  // 4) Fallback: last space before budget (avoid mid-word cuts)
  const fallback = slice.lastIndexOf(" ", budget);
  if (fallback >= minGood) return slice.slice(0, fallback).trimEnd();

  // 5) Hard fallback
  return s.slice(0, budget).trimEnd();
}

export type SendOutputBudgetParams = {
  maxOut: number;
  isGemini3: boolean;
  modelForBudget: string;
  g3ProDoneOnly: boolean;
  authorWantsStatus: boolean;
  statusTemplateClosedFenceLenGuess: number;
  statusTemplateOpenFenceLenGuess: number;
  noTruncateOutput: boolean;
};

export type SendOutputBudget = {
  targetChars: number;
  bodyBudgetChars: number;
  promptMinChars: number;
  tailBudgetChars: number;
  promptMaxChars: number;
  minChars: number;
  maxChars: number;
  maxOutputTokensForCall: number;
};

export function computeSendOutputBudget(params: SendOutputBudgetParams): SendOutputBudget {
  const maxOut = Number(params.maxOut);
  const isGemini3 = Boolean(params.isGemini3);
  const modelForBudget = String(params.modelForBudget || "");
  const g3ProDoneOnly = Boolean(params.g3ProDoneOnly);
  const authorWantsStatus = Boolean(params.authorWantsStatus);
  const statusTemplateClosedFenceLenGuess = Number(params.statusTemplateClosedFenceLenGuess) || 0;
  const statusTemplateOpenFenceLenGuess = Number(params.statusTemplateOpenFenceLenGuess) || 0;
  const noTruncateOutput = Boolean(params.noTruncateOutput);

  const targetChars = Math.max(200, Math.min(20000, Math.floor(maxOut))); // 슬라이더 값 = 권장 글자수

  const bodySlackChars = g3ProDoneOnly ? 0 : Math.min(160, Math.floor(targetChars * 0.08));
  const bodyBudgetChars = Math.max(200, Math.floor(targetChars + bodySlackChars));

  // 본문 최소 힌트(모델이 너무 짧게 끝내지 않도록): 목표의 90%
  const promptMinChars = Math.max(200, Math.floor(targetChars * 0.9));

  // 상태창/INFO fence tail budget (C)
  // - 기본: targetChars의 35% (min 450, max 1000)
  // - 제작 프롬프트에 "닫힌 fenced 템플릿"이 있으면, 템플릿 길이 기반으로 최소치를 상향(650~1400)
  //   → Gemini 3 Pro에서 상태창이 중간에 끊기거나 open fence가 잘리는 현상 완화
  const defaultTailBudgetChars = Math.max(450, Math.min(1000, Math.floor(targetChars * 0.35)));

  // If the author wants a status/meta panel but no *closed* template fence was found,
  // reserve a larger floor so the panel doesn't get clipped mid-line.
  const statusTailFloorChars = authorWantsStatus
    ? Math.max(650, Math.min(2000, Math.floor(targetChars * 0.75)))
    : 0;

  const statusTemplateAnyFenceLenGuess = Math.max(statusTemplateClosedFenceLenGuess, statusTemplateOpenFenceLenGuess);
  const tailByTemplateChars =
    authorWantsStatus && statusTemplateAnyFenceLenGuess > 0
      ? Math.max(650, Math.min(2400, Math.floor(statusTemplateAnyFenceLenGuess * 1.35) + 80))
      : 0;

  const tailBudgetChars = Math.max(defaultTailBudgetChars, statusTailFloorChars, tailByTemplateChars);
  // 총 출력 상한(본문+tail). 본문이 tail을 먹지 않도록 downstream에서 bodyMaxChars를 사용한다.
  const promptMaxChars = bodyBudgetChars + tailBudgetChars;

  // 로직 판단용(안전장치): "너무 짧다" 판단 기준(목표의 90%)
  const logicMinChars = Math.max(120, Math.floor(targetChars * 0.9));
  const minChars = logicMinChars; // always enforce "too short" detection even when we skip truncation
  const maxChars = noTruncateOutput ? promptMaxChars : Math.max(minChars + 40, targetChars);

  // 생성 단계 토큰 예산(폭주 방지 + 끊김 완화)
  const isGemini3ProForBudget = /gemini-3(?:\.\d+)?-pro/i.test(modelForBudget);
  const cap = isGemini3 ? 12288 : 6000;

  const boostMul = isGemini3
    ? (isGemini3ProForBudget
        ? (targetChars <= 2000 ? 1.3 : targetChars <= 2600 ? 1.45 : 2.0)
        : (targetChars <= 1600 ? 1.35 : targetChars <= 2600 ? 1.55 : 2.0))
    : 2.2;

  const rawBoost = Math.floor(promptMaxChars * boostMul);
  const minBoost = isGemini3
    ? (isGemini3ProForBudget
        ? (targetChars >= 3200 ? 4096 : targetChars >= 2000 ? 3072 : 1536)
        : targetChars >= 3200 ? 3072 : 1536)
    : 512;

  const boostedMaxOutputTokens = Math.max(minBoost, Math.min(cap, rawBoost));
  const proTokenCapFromChars = isGemini3ProForBudget
    ? Math.max(1024, Math.min(cap, Math.floor(promptMaxChars * 2.4)))
    : 0;

  const maxOutputTokensForCall = isGemini3ProForBudget
    ? Math.max(64, Math.min(cap, Math.min(proTokenCapFromChars, boostedMaxOutputTokens)))
    : Math.max(64, Math.min(cap, boostedMaxOutputTokens));

  return {
    targetChars,
    bodyBudgetChars,
    promptMinChars,
    tailBudgetChars,
    promptMaxChars,
    minChars,
    maxChars,
    maxOutputTokensForCall,
  };
}
