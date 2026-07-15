export function hasUnclosedFence(text: string): boolean {
  // Count line-start fences only (more reliable than counting every ``` substring).
  const fences = String(text || "").match(/(^|\n)[ \t]*```/g) || [];
  return fences.length % 2 === 1;
}

function isBalancedNovelPrefix(prefix: string): boolean {
  const t = String(prefix || "");
  // Keep this window relatively small: a single unmatched quote/star far earlier should not
  // block a clean sentence-ending cut near the tail (common with creator templates / meta).
  const tail = t.slice(-Math.min(1200, t.length));
  const stars = (tail.match(/\*/g) || []).length;
  const dquotes = (tail.match(/["“”]/g) || []).length;
  return stars % 2 === 0 && dquotes % 2 === 0;
}

export function findCleanBoundaryForStream(text: string, minPos: number, isG3Pro: boolean): number {
  const s = String(text || "");
  const tailStart = Math.max(0, Math.min(s.length, minPos));
  const accept = (pos: number) => {
    const pre = s.slice(0, pos);
    return isBalancedNovelPrefix(pre) ? pos : -1;
  };

  // Look back to the last non-whitespace char before a boundary.
  const lastNonWsCharBefore = (pos: number) => {
    for (let j = pos - 1; j >= 0; j--) {
      const c = s[j];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      return c;
    }
    return "";
  };

  // Require a "complete looking" line ending for newline/blank-line cuts.
  // This prevents cuts like "...그 열정\n```" where the last line is a fragment.
  const endsWithGoodMarkerBefore = (pos: number) => {
    const c = lastNonWsCharBefore(pos);
    return /[\.\!\?\u3002\uFF01\uFF1F\u2026\*"\"”\'\’\)\]\}]/.test(c);
  };

  for (let i = s.length; i >= tailStart; i--) {
    const ch = s[i - 1];
    if (!ch) continue;

    // 1) closing fence
    if (i >= 3 && s.slice(i - 3, i) === "```") {
      const p = accept(i);
      if (p >= 0) return p;
      continue;
    }

    // 2) sentence end punctuation (incl. full-width / ellipsis)
    if (/[\.\!\?\u3002\uFF01\uFF1F\u2026]/.test(ch)) {
      const p = accept(i);
      if (p >= 0) return p;
      continue;
    }

    // 3) closing quote / bracket
    if (ch === '"' || ch === "”" || ch === "'" || ch === "’" || ch === ")" || ch === "]" || ch === "}") {
      const p = accept(i);
      if (p >= 0) return p;
      continue;
    }

    // 4) narration closer
    if (ch === "*") {
      const p = accept(i);
      if (p >= 0) return p;
      continue;
    }

    // 5) blank line (only if the line above ends cleanly)
    if (i >= 2 && s.slice(i - 2, i) === "\n\n") {
      if (!endsWithGoodMarkerBefore(i - 2)) continue;
      const p = accept(i);
      if (p >= 0) return p;
      continue;
    }

    // 6) hard line break (only if the previous line ends cleanly)
    if (ch === "\n") {
      if (!endsWithGoodMarkerBefore(i - 1)) continue;
      const p = accept(i);
      if (p >= 0) return p;
      continue;
    }

  }

  // Fallback: avoid whitespace cuts (they frequently produce mid-sentence breaks in Korean).
  // Prefer a newline that follows a "good ending" marker.
  const hardStart = Math.max(0, s.length - (isG3Pro ? 4200 : 2600));
  for (let i = s.length; i >= hardStart; i--) {
    if (s[i - 1] === "\n") {
      if (!endsWithGoodMarkerBefore(i - 1)) continue;
      const p = accept(i);
      if (p >= 0) return p;
    }
  }

  // Second pass (loose): if balance checks prevented selecting an obvious sentence end,
  // allow a punctuation/fence cut anyway. This avoids fragments like "...이미\n".
  for (let i = s.length; i >= hardStart; i--) {
    const ch = s[i - 1];
    if (!ch) continue;
    if (i >= 3 && s.slice(i - 3, i) === "```") return i;
    if (/[\.\!\?\u3002\uFF01\uFF1F\u2026]/.test(ch)) return i;
    if (ch === '"' || ch === "”" || ch === "'" || ch === "’" || ch === ")" || ch === "]" || ch === "}" || ch === "*")
      return i;
  }

  return -1;
}

export function findFirstCompleteBoundaryAfter(text: string, minPos: number, maxPos?: number): number {
  const s = String(text || "");
  const start = Math.max(0, Math.min(s.length, Math.floor(minPos)));
  const limit = Math.max(start, Math.min(s.length, Math.floor(maxPos ?? s.length)));

  for (let i = start; i < limit; i++) {
    const ch = s[i];
    if (!/[.!?\u3002\uFF01\uFF1F\u2026]/.test(ch)) continue;

    // Do not mistake the dot in a decimal/version number for a sentence ending.
    if (ch === "." && /\d/.test(s[i - 1] || "") && /\d/.test(s[i + 1] || "")) continue;

    let end = i + 1;
    while (end < limit && /[.!?\u3002\uFF01\uFF1F\u2026]/.test(s[end])) end += 1;
    while (end < limit && /[\*"'\u2019\u201D)\]}]/.test(s[end])) end += 1;

    // A sentence marker embedded in a word is not a safe streaming boundary.
    const next = s[end] || "";
    if (next && !/\s/.test(next)) continue;
    while (end < limit && /[ \t\r\n]/.test(s[end])) end += 1;
    return end;
  }

  return -1;
}

export function computeMetaStreamBudgets(metaMaxChars: number): { metaFenceMaxChars: number; metaScanGraceChars: number } {
  const metaFenceMaxChars = (() => {
    const env = parseInt(process.env.CHAT_META_FENCE_MAX_CHARS || "0", 10);
    const def = metaMaxChars > 0 ? Math.max(900, metaMaxChars * 4) : 1200;
    const base = Number.isFinite(env) && env > 0 ? env : def;
    return Math.max(200, Math.min(2400, Math.floor(base)));
  })();
  const metaScanGraceChars = (() => {
    const env = parseInt(process.env.CHAT_META_SCAN_GRACE_CHARS || "0", 10);
    const def = metaMaxChars > 0 ? Math.max(320, metaMaxChars * 3) : 900;
    const base = Number.isFinite(env) && env > 0 ? env : def;
    return Math.max(120, Math.min(2400, Math.floor(base)));
  })();
  return { metaFenceMaxChars, metaScanGraceChars };
}

export type BuildStreamLoopConfigParams = {
  bodyMaxChars: number;
  modelName: string;
  metaMaxChars: number;
  authorWantsMetaPanel: boolean;
  metaRequired: string;
  metaFenceTemplateHint: string;
  metaLabelHint: string;
};

export type StreamLoopConfig = {
  bodyCapChars: number;
  fenceReserve: number;
  capForText: number;
  isG3Pro: boolean;
  cleanWindow: number;
  metaFenceMaxChars: number;
  metaScanGraceChars: number;
  allowMetaAfterCap: boolean;
  metaOpenRe: RegExp;
  holdbackChars: number;
  bodyOverflowMaxChars: number;
};

export function buildStreamLoopConfig(params: BuildStreamLoopConfigParams): StreamLoopConfig {
  const bodyCapChars = Math.max(0, Math.floor(params.bodyMaxChars)); // body-only cap
  const fenceReserve = bodyCapChars > 24 ? 4 : 0; // minimal reserve for "\n```"
  const capForText = Math.max(0, bodyCapChars - fenceReserve);
  const isG3Pro = /gemini-3(?:\.\d+)?-pro/i.test(String(params.modelName || ""));
  const cleanWindow = isG3Pro ? 1200 : 420;
  const { metaFenceMaxChars, metaScanGraceChars } = computeMetaStreamBudgets(params.metaMaxChars);
  const allowMetaAfterCap =
    Boolean(params.authorWantsMetaPanel) ||
    params.metaRequired === "YES" ||
    Boolean(params.metaFenceTemplateHint) ||
    Boolean(params.metaLabelHint);
  // Label-agnostic: treat ANY fenced block (```<anything>) as the status/meta block.
  // NOTE: We intentionally do NOT require whitespace after ``` because creators may use arbitrary labels like ```on.
  const metaOpenRe = /(^|\n)\s*```[^\n]*/i;

  // Keep the tail private until the server knows whether the body is complete.
  // This lets us retract an unfinished final sentence without changing text already sent.
  const holdbackChars = (() => {
    if (!isG3Pro) return 0;
    const env = parseInt(process.env.AI_G3PRO_STREAM_HOLDBACK_CHARS || "", 10);
    const value = Number.isFinite(env) && env >= 0 ? env : 600;
    return Math.max(0, Math.min(1200, value));
  })();

  // bodyMaxChars is a soft target. Preserve the generated continuation through the
  // next complete sentence before switching to the trailing meta panel.
  const bodyOverflowMaxChars = (() => {
    const env = parseInt(process.env.AI_STREAM_BODY_OVERFLOW_CHARS || "", 10);
    const fallback = isG3Pro ? 800 : 480;
    const value = Number.isFinite(env) && env > 0 ? env : fallback;
    return Math.max(128, Math.min(2000, value));
  })();

  return {
    bodyCapChars,
    fenceReserve,
    capForText,
    isG3Pro,
    cleanWindow,
    metaFenceMaxChars,
    metaScanGraceChars,
    allowMetaAfterCap,
    metaOpenRe,
    holdbackChars,
    bodyOverflowMaxChars,
  };
}
