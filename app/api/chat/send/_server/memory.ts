import { postprocessLongMemorySummary, stripUrlsAndMediaMarkdown } from "@/lib/memory_sanitize";
import { normalizeStoredMemorySummary } from "./summaryStored";

/**
 * Normalizes the tail sentence ending to reduce "cut-off" 느낌.
 * - Leaves heading lines (##/###) unchanged
 */
export function normalizeSummaryTail(summaryText: string): string {
  const t = String(summaryText || "").trimEnd();
  if (!t) return t;

  const lines = t.split(/\r?\n/);

  // Heuristic: in long-memory we strongly prefer sentences that end cleanly.
  // Avoid appending '.' to obviously incomplete Korean fragments like "...에게 이".
  const looksLikeGoodKoreanEnding = (s: string) => {
    const x = String(s || "").trim();
    if (!x) return false;
    if (/[.!?…。]$/.test(x)) return true;
    return /(다|요|함|됨|했다|하였다|된다|됐다|있다|없다|였다|이었다|한다)$/.test(x);
  };

  const trimDanglingTailToken = (s: string) => {
    let x = String(s || "").trimEnd();
    if (!x) return x;
    // Drop trailing connectors that indicate continuation.
    x = x.replace(/\s+(그리고|하지만|또는|및|그래서|즉|때문에)\s*$/g, "").trimEnd();
    // Drop trailing one-char determiners/pronouns that are very unlikely to be a sentence end.
    x = x.replace(/\s+([이그저내네제또])\s*$/g, "").trimEnd();
    return x;
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const lnRaw = lines[i];
    const ln = String(lnRaw || "").trim();
    if (!ln) continue;

    // 헤더 라인은 그대로 둔다.
    if (/^#{2,4}\s+/.test(ln)) break;

    // 문장부호로 끝나면 OK
    if (/[.!?…。]$/.test(ln)) break;

    // 1) Trim obviously dangling last token(s)
    let fixed = trimDanglingTailToken(ln);
    if (fixed !== ln) {
      lines[i] = fixed;
    }
    const ln2 = String(lines[i] || "").trim();

    // 2) If we can safely add a period to a proper Korean ending, do it.
    if (looksLikeGoodKoreanEnding(ln2) && !/[.!?…。]$/.test(ln2)) {
      lines[i] = ln2 + ".";
      break;
    }

    // 3) If still not a good ending, try dropping a few trailing tokens until it becomes one.
    // This keeps the summary shorter but avoids awkward endings like "...에게 이.".
    let tmp = ln2;
    for (let k = 0; k < 5 && tmp && !looksLikeGoodKoreanEnding(tmp); k++) {
      const parts = tmp.split(/\s+/);
      if (parts.length <= 1) break;
      parts.pop();
      tmp = parts.join(" ").trim();
    }
    if (tmp && looksLikeGoodKoreanEnding(tmp) && !/[.!?…。]$/.test(tmp)) {
      lines[i] = tmp + ".";
      break;
    }
    if (tmp && /[.!?…。]$/.test(tmp)) {
      lines[i] = tmp;
      break;
    }

    // 4) If the remaining fragment is too short, drop it as noise.
    if (!tmp || tmp.length <= 12) {
      lines.splice(i, 1);
      break;
    }

    // Otherwise keep the trimmed text as-is (do NOT force a period).
    lines[i] = tmp;
    break;
  }

  return lines.join("\n").trimEnd();
}

/**
 * Sanitizes and normalizes the stored long-memory summary.
 *
 * Storage format is "요약.txt" style with a single H2 header and H3 sections.
 * We keep headings in storage, and rely on summaryStored.ts for normalization.
 */
export function sanitizeLongMemorySummary(input: string, summaryEvery: number): string {
  if (!input) return "";

  // 1) Strip URLs/media markdown while preserving headings.
  let s = stripUrlsAndMediaMarkdown(String(input), { keepHeadings: true });

  // 2) Remove common meta/boilerplate + light cleanup + mask sensitive tokens.
  s = postprocessLongMemorySummary(s);

  // 3) Enforce canonical ordering/contiguity.
  s = normalizeStoredMemorySummary(s, summaryEvery);

  return s.trim();
}

function normalizeRangeLabel(st: number, ed: number): string {
  if (st === ed) return `${st}턴`;
  return `${st}-${ed}턴`;
}

function sanitizeTitleLocal(t: string): string {
  const s = String(t || "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "요약";
  return s.length > 28 ? s.slice(0, 28).trim() : s;
}

function coerceFirstSectionToRange(rawSection: string, st: number, ed: number): string {
  const raw = String(rawSection || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  // Keep ONLY the first section if multiple were returned.
  const firstNl = raw.indexOf("\n");
  const headerLine = (firstNl >= 0 ? raw.slice(0, firstNl) : raw).trim();
  let rest = firstNl >= 0 ? raw.slice(firstNl + 1) : "";

  // Cut off any accidental extra sections.
  const nextHeaderIdx = rest.search(/^\s*###\s+/m);
  if (nextHeaderIdx >= 0) rest = rest.slice(0, nextHeaderIdx);
  rest = rest.trim();

  // Extract a clean title (strip the old range label if present).
  const core = headerLine.replace(/^\s*###\s*/, "").trim();
  const titleOnly = core.replace(/\(\s*\d+\s*(?:[-–—~]\s*\d+\s*)?턴\s*\)\s*$/u, "").trim();
  const title = sanitizeTitleLocal(titleOnly);

  const rangeLabel = normalizeRangeLabel(st, ed);
  return `### ${title} (${rangeLabel})\n${rest}`.trim();
}

function toSection(blockOrBody: string, st: number, ed: number): string {
  const raw = String(blockOrBody || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  // Already a section header
  if (/^###\s+/.test(raw)) return coerceFirstSectionToRange(raw, st, ed);

  // Legacy: "## 장기 기억 (a-b턴)" block -> convert to a section.
  const legacyHeaderRe = /^##\s*장기\s*기억\s*\(.*\)\s*\n+/;
  const body = raw.replace(legacyHeaderRe, "").trim();
  const rangeLabel = normalizeRangeLabel(st, ed);
  return (`### 요약 (${rangeLabel})\n${body}`.trim());
}

function removeExistingRange(summary: string, st: number, ed: number): string {
  const src = String(summary || "").replace(/\r\n/g, "\n");
  if (!src.trim()) return "";

  const range = normalizeRangeLabel(st, ed);
  // Remove new sections: ### ... (a-b턴)
  const reSection = new RegExp(
    String.raw`(^###\s+[^\n]*\(\s*${range.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\s*\)\s*\n[\s\S]*?)(?=^###\s|\s*$)`,
    "m"
  );
  let out = src.replace(reSection, "");

  // Remove legacy blocks: ## 장기 기억 (a-b턴)
  const reLegacy = new RegExp(
    String.raw`(^##\s*장기\s*기억\s*\(\s*${st}\s*[-–~]\s*${ed}\s*턴\s*\)[\s\S]*?)(?=^##\s*장기\s*기억\s*\(|\s*$)`,
    "m"
  );
  out = out.replace(reLegacy, "");

  return out.replace(/\n{4,}/g, "\n\n\n").trim();
}

/**
 * Upsert a single window (st-ed) into the stored long-memory summary.
 *
 * Accepts either:
 * - a new-format section (### ... (a-b턴) ...)
 * - a legacy block (## 장기 기억 (a-b턴) ...)
 * - a plain body
 */
export function upsertSummaryRangeBlock(prev: string, block: string, st: number, ed: number): string {
  const p0 = String(prev || "").trim();
  const section = toSection(block, st, ed);
  if (!section) return p0;

  const cleanedPrev = removeExistingRange(p0, st, ed);
  if (!cleanedPrev) return section;
  return `${cleanedPrev}\n\n${section}`.trim();
}
