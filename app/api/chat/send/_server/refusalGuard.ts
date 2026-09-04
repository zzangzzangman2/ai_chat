// 모델 거부/차단 응답 판정.
//
// (2026-08-16) 거부 응답이 대화에 그대로 저장되면 다음 턴 프롬프트의 [최근 대화]에 실려
// 들어간다. 모델은 그것을 "이 대화에서는 이런 요청에 거부하는 게 정상"이라는 선례로 읽고
// 거부를 반복한다(자기강화). 그래서 거부 응답은
//   1) 감지하면 최대 N회 자동 리롤하고
//   2) 끝내 실패해도 DB에 저장하지 않는다(화면에는 안내를 띄우되 기록은 남기지 않음)
//
// 판정은 "롤플레이 본문인가"를 먼저 본다. 극중 인물이 "죄송해요"라고 말하는 것은 거부가
// 아니다(실측: 저장된 어시스턴트 메시지 1117개 중 '죄송' 포함 19건은 전부 극중 대사였다).

export type RefusalReason =
  | "empty_output"
  | "blocked_output"
  | "model_refusal"
  | "";

export type RefusalCheck = {
  refused: boolean;
  reason: RefusalReason;
  detail: string;
};

const OK: RefusalCheck = { refused: false, reason: "", detail: "" };

// streamFinal.ts가 빈/차단 응답 자리에 넣는 안내 블록.
const STATUS_ERROR_RE =
  /```STATUS\s*\n[\s\S]*?\berror:\s*(empty_output|blocked_output)\b/i;

const REFUSAL_PHRASES: Array<[RegExp, string]> = [
  [/생성할\s*수\s*없/, "생성할 수 없"],
  [/만들어\s*드릴\s*수\s*없/, "만들어 드릴 수 없"],
  [/도와드릴\s*수\s*없/, "도와드릴 수 없"],
  [/도와드리기\s*(?:는\s*)?어렵/, "도와드리기 어렵"],
  [/답변(?:을|를)?\s*드릴\s*수\s*없/, "답변드릴 수 없"],
  [/응답(?:을|를)?\s*(?:드릴|할)\s*수\s*없/, "응답할 수 없"],
  [/참여할\s*수\s*없/, "참여할 수 없"],
  [/제공할\s*수\s*없/, "제공할 수 없"],
  [/계속(?:할|하기)\s*(?:는\s*)?(?:수\s*없|어렵)/, "계속할 수 없"],
  [/요청(?:을|를)?\s*(?:수행|처리)할\s*수\s*없/, "요청을 처리할 수 없"],
  [/(?:안전|콘텐츠|이용)\s*(?:정책|지침|가이드라인)/, "정책/지침 언급"],
  [/\bI(?:'m| am)\s+(?:sorry|unable|not able)\b/i, "I'm sorry/unable"],
  [/\bI\s+(?:cannot|can't|can not|won't|will not)\b/i, "I cannot"],
  [/\bcan(?:not|'t)\s+(?:help|assist|continue|create|generate|provide|fulfill)\b/i, "cannot help"],
  [/\b(?:safety|content|usage)\s+(?:policy|policies|guidelines?)\b/i, "safety policy"],
];

// 롤플레이 대사. 극중 인물의 사과/거절과 모델 자신의 거부를 가르는 핵심 신호다.
const DIALOGUE_RE = /["“「『][^"”」』\n]{2,}["”」』]/;

/** 코드펜스(INFO/STATUS 등)를 제거한 서사 본문만 남긴다. */
export function stripFencesForRefusalCheck(text: string): string {
  return String(text || "")
    .replace(/```[^\n]*\n[\s\S]*?\n```/g, " ")
    .replace(/```[^\n]*\n[\s\S]*$/g, " ")
    .replace(/```/g, " ");
}

/**
 * 거부/차단 응답인지 판정한다.
 *
 * 주의: 본문이 짧고, 롤플레이 대사가 없고, 거부 문구가 있을 때만 거부로 본다.
 * 지문 마커(*...*)는 신뢰하지 않는다 — textPolicy가 거부 문장을 *...*로 감싸는
 * 경로가 있어서, 마커 유무로는 거부와 서사를 구분할 수 없다.
 */
export function inspectRefusalOutput(text: string): RefusalCheck {
  const src = String(text || "");

  const statusMatch = src.match(STATUS_ERROR_RE);
  if (statusMatch) {
    const kind = String(statusMatch[1] || "").toLowerCase();
    return {
      refused: true,
      reason: kind === "blocked_output" ? "blocked_output" : "empty_output",
      detail: `status_fence:${kind}`,
    };
  }

  const body = stripFencesForRefusalCheck(src).trim();
  if (!body) {
    return { refused: true, reason: "empty_output", detail: "empty_body" };
  }

  // 지문 마커/장식만 걷어낸 평문
  const flat = body
    .replace(/[*_`>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 거부문은 짧다. 정상 서사(수백~수천 자)를 오탐하지 않도록 상한을 둔다.
  const REFUSAL_MAX_CHARS = Number(process.env.AI_REFUSAL_MAX_CHARS ?? 400);
  if (flat.length > Math.max(80, REFUSAL_MAX_CHARS)) return OK;

  // 극중 대사가 있으면 장면이다. (인물이 "죄송해요"라고 말하는 경우)
  if (DIALOGUE_RE.test(body)) return OK;

  for (const [re, label] of REFUSAL_PHRASES) {
    if (re.test(flat)) {
      return { refused: true, reason: "model_refusal", detail: `phrase:${label}` };
    }
  }

  return OK;
}

export function isRefusalLikeOutput(text: string): boolean {
  return inspectRefusalOutput(text).refused;
}

// ──────────────────────────────────────────────────────────────────────
// 리롤 정책 — 스트리밍/비스트리밍이 공유하는 단일 출처
// ──────────────────────────────────────────────────────────────────────
//
// (2026-09-04) 리롤 루프가 스트리밍 경로 안에만 있어서, Flash처럼 항상 버퍼드로
// 도는 모델은 거부가 나와도 한 번도 다시 굴리지 않고 그대로 저장했다.
// 실측: chat c502ce10의 gemini-3.8-flash 턴에서 "…생성할 수 없습니다."가 그대로 저장됨.
// 판정(inspectRefusalOutput)은 정상이었고, 호출하는 쪽이 없었던 게 원인이다.
// 회차 상한과 샘플링 확장 규칙을 여기 한 곳에 두고 두 경로가 같이 참조한다.

/** 거부 자동 리롤 최대 회차. */
export function refusalRerollMax(): number {
  const raw = Number(process.env.AI_REFUSAL_REROLL_MAX ?? 5);
  return Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.floor(raw))) : 5;
}

/**
 * 리롤 회차에 따라 샘플링을 넓힌다.
 * 같은 temperature로 다시 굴리면 같은 거부가 그대로 재현되므로, 회차마다 넓혀야 한다.
 */
export function widenSamplingForReroll(
  base: { temperature: number; topP: number; topK: number },
  attempt: number
): { temperature: number; topP: number; topK: number } {
  if (attempt <= 0) return base;
  const step = Math.min(4, Math.max(1, Math.floor(attempt)));
  return {
    temperature: Math.min(1.1, base.temperature + 0.2 * step),
    topP: Math.min(0.98, base.topP + 0.04 * step),
    topK: Math.min(64, base.topK + 8 * step),
  };
}

/** 비스트리밍 본생성 호출에 얹을 리롤 샘플링 오버라이드. 0회차면 아무것도 바꾸지 않는다. */
export function refusalRerollSamplingOverride(attempt: number): Record<string, number> {
  if (!(attempt > 0)) return {};
  return widenSamplingForReroll({ temperature: 0.18, topP: 0.82, topK: 32 }, attempt);
}
