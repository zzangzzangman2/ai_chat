export function mergeStreamUsage(base: any, add: any) {
  if (!add) return base;
  if (!base) return { ...add };
  const out: any = { ...base };
  for (const k of ["promptTokens", "outputTokens", "reasoningTokens", "totalTokens", "latencyMs"]) {
    out[k] = Number(out[k] || 0) + Number(add[k] || 0);
  }
  // keep the last model / finishReason for observability
  if (add.model) out.model = add.model;
  if (add.finishReason) out.finishReason = add.finishReason;
  if (add.tokenBreakdown) out.tokenBreakdown = add.tokenBreakdown;
  return out;
}

export function makeContinueUserPrompt(context: string, combined: string) {
  const tailLen = 800;
  const tail = combined.slice(Math.max(0, combined.length - tailLen));
  return [
    context ? `[최근 대화]\n${context}` : "",
    "",
    "[CONTINUE] 직전 출력이 MAX_TOKENS로 중단되었다.",
    "- 이미 출력한 내용은 절대 반복/요약/재진술하지 말고, 바로 다음 문장부터 그대로 이어서만 써라.",
    '- 형식은 헌법을 그대로 유지한다: 지문=*...*, 대사="...".',
    "- (중요) 이어쓰기에서도 fenced 코드블록(```...```) 출력은 절대 금지한다. 상태/INFO/STATUS 같은 메타 블록도 다시 출력하지 마라(상태창은 첫 호출의 맨 끝 1회만).",
    "- 마지막 문장이 미완이면 자연스럽게 이어서 완결까지 마무리하라.",
    "",
    "[직전 출력의 마지막 부분(참고, 반복 금지)]",
    tail,
    "",
    "출력은 곧바로 이어서 시작하라.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function awaitFinalFast<T>(p: Promise<T>, ms: number): Promise<T | null> {
  try {
    return await Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), Math.max(0, ms)))]);
  } catch {
    return null;
  }
}
