"use strict";

function maintenanceRetryDetails(payload, attempts = 1) {
  const graph = String(payload?.reason || "").startsWith("pending_graph") ||
    (payload?.structuredGraphParsed === false && Boolean(payload?.structuredGraphFailure));
  const failure = payload?.structuredGraphFailure;
  const names = {
    rate_limited: "Google API 429(Resource exhausted)",
    timeout: "Google API 응답 시간 초과",
    provider_error: "Google API 요청 실패",
    invalid_response: "인물·관계 응답 형식 검증 실패",
    aborted: "요청 중단",
  };
  const seconds = Math.ceil(Math.min(300_000, Math.max(30_000, Number(failure?.retryAfterMs) || 30_000) *
    2 ** Math.min(4, Math.max(0, Number(attempts || 1) - 1))) / 1000);
  const summary = graph && Number.isFinite(payload?.summarizedEndTurn)
    ? `장기요약 본문은 ${payload.summarizedEndTurn}턴까지 저장됨. ` : "";
  const reason = names[failure?.code] || ({
    stale_source_changed: "대화 변경으로 최신 원문 재확인 필요",
    bad_output: "요약 품질 검증 실패",
    archive_shrink_blocked: "기존 요약 보존 검사에서 저장 보류",
    pending_graph_retry: "인물·관계 정보 추출 재시도 필요",
  })[payload?.reason] || "미완료 작업 재시도 필요";
  return { label: graph ? "인물·관계" : "장기요약", reason: `${summary}${reason}; ${seconds}초 뒤 재시도`, delayMs: seconds * 1000 };
}

module.exports = { maintenanceRetryDetails };
