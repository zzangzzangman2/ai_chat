"use strict";

/**
 * Transient UI state only: never append progress to the story or send history.
 * A retry notice is shown only when the server announces an actual new attempt.
 * @param {string} current
 * @param {any} event
 * @returns {string}
 */
function generationProgressAfterEvent(current, event) {
  if (event?.type === "retry") {
    const attempt = Number(event.attempt);
    const maxAttempts = Number(event.maxAttempts);
    if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts) ||
        attempt < 1 || maxAttempts < attempt) return current;
    return `응답 생성 실패 · 재시도 중… (${attempt}/${maxAttempts})`;
  }
  if (event?.type === "done" || event?.type === "error") return "";
  if ((event?.type === "delta" || event?.type === "replace") &&
      typeof event.text === "string" && event.text.trim()) return "";
  return current;
}

/**
 * 버퍼드(비스트리밍) 응답의 재시도 진행 표시.
 *
 * (2026-09-04) 스트리밍은 서버가 `retry` 이벤트를 흘려보내므로 회차가 실시간으로 보인다.
 * 버퍼드는 응답이 JSON 한 번이라 도중에 알릴 채널이 없다. 그래서 서버가 최종 응답에
 * 리롤 회차를 실어 보내고, 클라이언트가 결과와 함께 한 줄로 알린다.
 * 이게 없으면 5회 리롤(실측 29초) 동안 화면에 아무 변화가 없어서 "재시도를 안 한다"로 보인다.
 *
 * @param {{refusalRerolls?: number, refusalBlocked?: boolean}} payload
 * @returns {string} 표시할 문구. 재시도가 없었으면 빈 문자열.
 */
function refusalRerollNotice(payload) {
  const attempts = Number(payload?.refusalRerolls);
  if (!Number.isInteger(attempts) || attempts < 1) return "";
  const blocked = payload?.refusalBlocked === true;
  return blocked
    ? `거부 응답이 감지되어 ${attempts}회 다시 생성했지만 모두 거부되었습니다. 이 응답은 저장되지 않습니다.`
    : `거부 응답이 감지되어 ${attempts}회 다시 생성했습니다.`;
}

module.exports = { generationProgressAfterEvent, refusalRerollNotice };
