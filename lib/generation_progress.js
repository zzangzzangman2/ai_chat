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

module.exports = { generationProgressAfterEvent };
