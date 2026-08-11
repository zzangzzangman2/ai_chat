export type GuardedTextStream = {
  push: (text: unknown) => string;
  finish: () => string;
  output: () => string;
};

function completePrefixLength(source: string) {
  let inFence = false;
  let lastSafe = 0;

  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith("```", i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (inFence) continue;

    const ch = source[i];
    if (ch === "\n") {
      lastSafe = i + 1;
      continue;
    }
    if (!/[.!?。！？]/u.test(ch)) continue;

    let end = i + 1;
    while (end < source.length && /["”'’」』)\]*]/u.test(source[end])) end += 1;
    if (end >= source.length || !/\s/u.test(source[end])) continue;
    while (end < source.length && /\s/u.test(source[end])) end += 1;
    lastSafe = end;
    i = end - 1;
  }

  return lastSafe;
}

/**
 * Holds incomplete sentences and fenced blocks until they can be validated as
 * a whole. Every emitted chunk has already passed through `sanitize`, while
 * ordinary text and all of its whitespace remain byte-for-byte unchanged.
 */
export function createGuardedTextStream(
  sanitize: (text: string) => string
): GuardedTextStream {
  let pending = "";
  let emitted = "";
  let finished = false;
  let redactionBoundaryPending = false;

  const preserveParagraphBoundary = (raw: string, safeValue: string) => {
    let safe = safeValue;
    const changed = safe !== raw;
    if (!changed && !redactionBoundaryPending) return safe;

    const trailingNewlines = (emitted.match(/\n+$/u)?.[0] || "").length;
    const leadingNewlines = (safe.match(/^\n+/u)?.[0] || "").length;
    if (trailingNewlines + leadingNewlines > 2) {
      const keep = Math.max(0, 2 - trailingNewlines);
      safe = "\n".repeat(keep) + safe.slice(leadingNewlines);
    }

    redactionBoundaryPending = !safe.trim() && (changed || redactionBoundaryPending);
    return safe;
  };

  const flush = (all: boolean) => {
    if (!pending) return "";
    const length = all ? pending.length : completePrefixLength(pending);
    if (length <= 0) return "";
    const raw = pending.slice(0, length);
    pending = pending.slice(length);
    const safe = preserveParagraphBoundary(raw, String(sanitize(raw) || ""));
    emitted += safe;
    return safe;
  };

  return {
    push(value) {
      const text = String(value || "");
      if (!text) return "";
      if (finished) {
        const safe = preserveParagraphBoundary(text, String(sanitize(text) || ""));
        emitted += safe;
        return safe;
      }
      pending += text;
      return flush(false);
    },
    finish() {
      if (finished) return "";
      finished = true;
      return flush(true);
    },
    output() {
      return emitted;
    },
  };
}
