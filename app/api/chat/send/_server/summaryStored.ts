// Utilities for working with the stored long-memory summary text.
// Pure helpers only (no DB/network), so they can be reused safely.
//
// Storage format ("요약.txt" style):
//
// ## 장기 기억 (1-N턴)
//
// ### <짧은 제목> (a-b턴)
// <body>
//
// ... repeated for each window.
//
// Backward compatibility:
// - Older builds stored blocks as repeated "## 장기 기억 (a-b턴)" headers.
//   We still parse those and convert them into sections.

export type SummaryRangeBlock = { startTurn: number; endTurn: number };

export type StoredSummarySection = {
  startTurn: number;
  endTurn: number;
  title: string;
  body: string;
};

export function strlenSummary(x: any): number {
  return String(x || "").length;
}

const RE_TOP = /^\s*##\s*장기\s*기억\s*\(\s*(\d+)\s*[-–—~]\s*(\d+)\s*턴\s*\)\s*$/gm;

const RE_SECTION =
  /^\s*###\s*(.*?)\s*\(\s*(\d+)\s*(?:[-–—~]\s*(\d+)\s*)?턴\s*\)\s*$/gm;

// Legacy blocks: "## 장기 기억 (a-b턴)" repeated.
const RE_LEGACY_BLOCK = /^\s*##\s*장기\s*기억\s*\(\s*(\d+)\s*[-–—~]\s*(\d+)\s*(?:턴)?\s*\)\s*$/gm;

function clampInt(n: any, min: number, max: number): number {
  const x = Math.floor(Number(n) || 0);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function normRange(a: number, b?: number): { st: number; ed: number } {
  const aa = Math.max(1, Math.floor(a));
  const bb = b == null ? aa : Math.max(1, Math.floor(b));
  return { st: Math.min(aa, bb), ed: Math.max(aa, bb) };
}

function sanitizeTitle(t: string): string {
  const s = String(t || "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  if (!s) return "요약";
  return s.length > 28 ? s.slice(0, 28).trim() : s;
}

function sanitizeBody(t: string): string {
  let s = String(t || "").trim();

  // Remove obvious meta echoes
  s = s
    .split(/\r?\n/)
    .filter((ln) => {
      const x = (ln || "").trim();
      if (!x) return true;
      if (/^start_thought\b/i.test(x)) return false;
      if (/(사용자\s*:|어시스턴트\s*:|User\s*:|Assistant\s*:)/i.test(x)) return false;
      if (/Long[- ]term Memory Summary Writer/i.test(x)) return false;
      if (/Dialogue Context/i.test(x)) return false;
      return true;
    })
    .join("\n");

  // Prevent markdown-ish noise in stored memory
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/[\*＊]/g, "");
  s = s.replace(/["“”]/g, "");

  // Remove any heading lines accidentally echoed into the body
  let lines = s.split(/\r?\n/).map((ln) => String(ln || "").trimEnd());
  lines = lines.filter((ln) => {
    const x = ln.trim();
    if (!x) return true;
    if (/^#{1,6}\s+/.test(x)) return false;
    if (/^##\s*장기\s*기억\b/.test(x)) return false;
    return true;
  });

  // De-dupe consecutive identical lines (non-empty)
  const out: string[] = [];
  let prev = "";
  let prevBlank = false;
  for (const ln of lines) {
    const x = ln.trim();
    if (!x) {
      if (prevBlank) continue;
      out.push("");
      prevBlank = true;
      continue;
    }
    if (x === prev) continue;
    out.push(ln);
    prev = x;
    prevBlank = false;
  }

  s = out.join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

export function extractSummarySections(summary: string): StoredSummarySection[] {
  const src = String(summary || "");
  const hits: { idx: number; title: string; st: number; ed: number }[] = [];

  // Primary: ### sections
  for (const m of src.matchAll(RE_SECTION)) {
    const idx = (m.index ?? 0) as number;
    const title = sanitizeTitle(m[1] || "");
    const a = Number(m[2] || 0);
    const b = m[3] != null ? Number(m[3] || 0) : undefined;
    if (!Number.isFinite(a) || a <= 0) continue;
    const r = normRange(a, b);
    hits.push({ idx, title, st: r.st, ed: r.ed });
  }

  if (hits.length) {
    hits.sort((x, y) => x.idx - y.idx);
    const out: StoredSummarySection[] = [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const startIdx = h.idx;
      const nextIdx = i + 1 < hits.length ? hits[i + 1].idx : src.length;
      // body begins after the header line
      const headerLineEnd = src.indexOf("\n", startIdx);
      const bodyStart = headerLineEnd >= 0 ? headerLineEnd + 1 : nextIdx;
      const bodyRaw = src.slice(bodyStart, nextIdx);
      const body = sanitizeBody(bodyRaw);
      if (body.replace(/\s/g, "").length < 10) continue;
      out.push({ startTurn: h.st, endTurn: h.ed, title: h.title, body });
    }
    return out;
  }

  // Fallback: legacy repeated ## blocks
  const legacyHits: { idx: number; st: number; ed: number }[] = [];
  for (const m of src.matchAll(RE_LEGACY_BLOCK)) {
    const idx = (m.index ?? 0) as number;
    const a = Number(m[1] || 0);
    const b = Number(m[2] || 0);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const r = normRange(a, b);
    legacyHits.push({ idx, st: r.st, ed: r.ed });
  }
  legacyHits.sort((x, y) => x.idx - y.idx);

  const out: StoredSummarySection[] = [];
  for (let i = 0; i < legacyHits.length; i++) {
    const h = legacyHits[i];
    const nextIdx = i + 1 < legacyHits.length ? legacyHits[i + 1].idx : src.length;
    const headerLineEnd = src.indexOf("\n", h.idx);
    const bodyStart = headerLineEnd >= 0 ? headerLineEnd + 1 : nextIdx;
    const bodyRaw = src.slice(bodyStart, nextIdx);
    const body = sanitizeBody(bodyRaw);
    if (body.replace(/\s/g, "").length < 10) continue;
    out.push({ startTurn: h.st, endTurn: h.ed, title: "요약", body });
  }
  return out;
}

// Compatibility: some older callers treat each stored window as a "range block".
// In the new format, each section corresponds to a range block.
export function extractSummaryRangeBlocks(summary: string): SummaryRangeBlock[] {
  const src = String(summary || "");
  const secs = extractSummarySections(src);
  if (secs.length) {
    return secs
      .map((s) => ({ startTurn: s.startTurn, endTurn: s.endTurn }))
      .filter((b) => b.startTurn >= 1 && b.endTurn >= b.startTurn);
  }
  const out: SummaryRangeBlock[] = [];
  for (const m of src.matchAll(RE_LEGACY_BLOCK)) {
    const a = Number(m[1] || 0);
    const b = Number(m[2] || 0);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const r = normRange(a, b);
    out.push({ startTurn: r.st, endTurn: r.ed });
  }
  return out;
}

// Ensures stored memory contains only valid window sections, ordered, with a single top header.
export function normalizeStoredMemorySummary(summary: string, every: number): string {
  const src = String(summary || "").trim();
  if (!src) return "";

  const sections = extractSummarySections(src);
  if (!sections.length) return "";

  const ev = Math.max(1, Math.floor(Number(every) || 1));

  // Keep only properly aligned windows.
  const filtered = sections
    .map((s) => {
      const r = normRange(s.startTurn, s.endTurn);
      return { ...s, startTurn: r.st, endTurn: r.ed };
    })
    .filter((s) => {
      const size = s.endTurn - s.startTurn + 1;
      // Accept both normal windows (e.g. 46-48턴) and rolled-up blocks (e.g. 1-300턴).
      // A valid stored section must be aligned to the window size (`ev`).
      if (size < ev) return false;
      if (size % ev !== 0) return false;
      if ((s.startTurn - 1) % ev !== 0) return false;
      // endTurn should also align (for ev=3, ends are 3,6,9,...)
      if (s.endTurn % ev !== 0) return false;
      return true;
    });

  if (!filtered.length) return "";

  // De-dupe by range; last wins.
  const byKey = new Map<string, StoredSummarySection>();
  for (const s of filtered) byKey.set(`${s.startTurn}-${s.endTurn}`, s);

  const ordered = [...byKey.values()].sort((a, b) => a.startTurn - b.startTurn);

  // Keep only contiguous windows from 1.
  const kept: StoredSummarySection[] = [];
  let expectedStart = 1;
  for (const s of ordered) {
    if (s.startTurn !== expectedStart) break;
    kept.push(s);
    expectedStart = s.endTurn + 1;
  }
  if (!kept.length) return "";

  const maxEnd = Math.max(...kept.map((s) => s.endTurn));
  const header = `## 장기 기억 (1-${maxEnd}턴)`;
  const body = kept
    .map((s) => {
      const title = sanitizeTitle(s.title);
      const b = sanitizeBody(s.body);
      return `### ${title} (${s.startTurn}-${s.endTurn}턴)\n${b}`.trim();
    })
    .join("\n\n");
  return `${header}\n\n${body}`.trim();
}

export function getSummarizedEndTurn(summary: string): number {
  const src = String(summary || "");
  const sections = extractSummarySections(src);
  const ends = sections.map((s) => s.endTurn).filter((n) => Number.isFinite(n) && n > 0);
  if (ends.length) return Math.max(...ends);

  // Fallback to top header if present.
  let best = 0;
  for (const m of src.matchAll(RE_TOP)) {
    const a = Number(m[1] || 0);
    const b = Number(m[2] || 0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    best = Math.max(best, Math.max(a, b));
  }
  return best;
}

export function hasRangeBlock(summary: string, startTurn: number, endTurn: number): boolean {
  const s = String(summary || "");
  if (!s.trim()) return false;
  const st = clampInt(startTurn, 1, 1_000_000_000);
  const ed = clampInt(endTurn, st, 1_000_000_000);

  // New format: ### ... (st-ed턴)
  const reSection = new RegExp(
    `^\\s*###\\s*.*?\\(\\s*${st}\\s*[-–—~]\\s*${ed}\\s*턴\\s*\\)\\s*$`,
    "m"
  );
  if (reSection.test(s)) return true;

  // Legacy format: ## 장기 기억 (st-ed턴)
  const reLegacy = new RegExp(
    `^\\s*##\\s*장기\\s*기억\\s*\\(\\s*${st}\\s*[-–—~]\\s*${ed}\\s*(?:턴)?\\s*\\)\\s*$`,
    "m"
  );
  return reLegacy.test(s);
}

// Backward-friendly alias (some callers use this name)
export const hasSummaryRangeBlock = hasRangeBlock;
