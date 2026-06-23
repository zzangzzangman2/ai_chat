import { normalizeAnyFenceOpen, repairUnclosedAnyFence } from "./textPolicy";

// Regex escape helper (module-scope). Some meta-detection code paths need this across multiple scopes.
// NOTE: This is intentionally tiny and side-effect free.
export const _reEsc = (s: string) => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Normalize a fenced code-block label ("```LABEL") token so it can be used reliably as a meta label.
// - Some presets accidentally include suffixes like ":\n" or other punctuation in the opening line.
// - Models often omit those suffixes when they reproduce the label, which breaks meta detection.
// We keep Unicode letters (Korean 포함) and digits, plus _ and -.
export function normalizeFenceLabelToken(raw: string): string {
  let t = String(raw ?? "").trim();
  if (!t) return "";
  // take first whitespace-separated token only
  t = t.split(/\s+/)[0] || "";
  // strip accidental backticks
  t = t.replace(/`+/g, "");
  if (!t) return "";
  // Prefer the leading "identifier-like" run.
  // (Hangul ranges: ㄱ-ㅎㅏ-ㅣ가-힣)
  const m = t.match(/^[A-Za-z0-9_\-ㄱ-ㅎㅏ-ㅣ가-힣]+/);
  if (m && m[0]) return m[0];
  // Fallback: split on common separators.
  const head = t.split(/[:\\/|,.]+/)[0] || "";
  return head || t;
}

export function fenceLabelCandidates(raw: string): string[] {
  const out: string[] = [];
  const a = String(raw ?? "").trim();
  if (a) out.push(a);
  const b = normalizeFenceLabelToken(a);
  if (b && b !== a) out.push(b);
  return Array.from(new Set(out.map((x) => String(x).trim()).filter(Boolean)));
}

export function extractFenceLabelFromFenceBlock(fenceBlock: string): string {
  const first = String(fenceBlock || "").replace(/\r\n/g, "\n").split("\n")[0] || "";
  const head = first.trim().replace(/^```+/, "").trim();
  return (head.split(/\s+/)[0] || "").trim();
}

export function looksLikeMetaPanelFence(fenceBlock: string): boolean {
  const s = String(fenceBlock || "");
  if (!s.startsWith("```")) return false;
  // Remove opening/closing fence lines for inspection.
  const body = s
    .replace(/^```[^\n]*\n?/i, "")
    .replace(/\n```\s*$/i, "")
    .trim();
  if (!body) return false;
  // Heuristics: status/meta panels usually include these markers.
  return (
    /\bLV\b|xp\s*\(|체력|마나|SP\s*:?|HP\s*:?|MP\s*:?|상황\s*요약|장소|위치|📆|⏲️|🌐|📜|🎒/i.test(body) ||
    // Typical "A|B|C|" header line
    /\|[^\n]*\|[^\n]*\|/.test(body)
  );
}

export function stripStandaloneSeparatorLines(s: string): string {
  // Remove noisy standalone separator lines that sometimes appear around images or status/meta blocks.
  // Keeps meaningful content intact.
  // IMPORTANT: Do not strip separators that appear inside fenced blocks (e.g., ```INFO ... --- ... ```),
  // because many 작품 use `---` as a structural delimiter inside the trailing meta fence.
  const lines = String(s ?? "").split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```")) {
      out.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      if (t.length !== 0 && /^(?:[-–—=_*]|━){3,}$/.test(t)) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function applyPromptPlaceholders(input: string, vars: { charName?: string; userName?: string }): string {
  let t = String(input ?? "");
  const cn = String(vars?.charName ?? "").trim();
  const un = String(vars?.userName ?? "").trim();
  if (cn) t = t.replace(/\{\{\s*char\s*\}\}|\{\s*char\s*\}/gi, cn);
  if (un) t = t.replace(/\{\{\s*user\s*\}\}|\{\s*user\s*\}/gi, un);
  return t;
}

export function endsWithCompleteFence(s: string): boolean {
  const t = String(s ?? "").trimEnd();

  // Must end with a fence line (allow trailing spaces)
  if (!/(^|\n)[ \t]*```[ \t]*$/.test(t)) return false;

  // Count only line-start fences to avoid false positives from inline ``` in prose.
  const fences = t.match(/(^|\n)[ \t]*```/g) || [];
  return fences.length >= 2 && fences.length % 2 === 0;
}

export function isMetaFenceClosed(s: string): boolean {
  // Meta tail blocks are delivered as fenced sections (e.g., ```INFO ... ```).
  // We consider it closed when the accumulated meta substring ends with a complete fence.
  return endsWithCompleteFence(s);
}

export function extractLastMetaContextFromMessages(
  messages: Array<{ role?: string; content?: string }>,
  allowedMetaLabels: string[]
): { bracketLine?: string; placeLine?: string } {
  try {
    // IMPORTANT:
    // Do NOT strip non-ASCII characters here.
    // Some creators use Korean/custom labels for the meta fence (e.g. ```커스텀등햔 ... ```),
    // and removing them prevents us from finding prior meta context, which then falls back to "미상".
    const labels = (allowedMetaLabels?.length ? allowedMetaLabels : ["INFO", "STATUS", "STREAM"])
      .map((x) => normalizeFenceLabelToken(String(x || "")))
      .filter(Boolean)
      .map((x) => x.toUpperCase());
    if (!labels.length) return {};
    const labelAlt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    // Allow punctuation after the label (e.g., ```커스텀등햔:n ...)
    // by using a lookahead that only forbids continuing "identifier" characters.
    const re = new RegExp(
      "```[ \\t]*(?:" +
        labelAlt +
        ")(?=[^A-Za-z0-9_\\-ㄱ-ㅎㅏ-ㅣ가-힣]|$)[^\\n]*(?:\\n|$)[\\s\\S]*?(?:\\n```|$)",
      "i"
    );

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || "") !== "assistant") continue;
      const c = String((m as any)?.content || "");
      if (!c.includes("```")) continue;
      const block = c.match(re)?.[0];
      if (!block) continue;

      const bracket = block.match(/\[([^\]]{1,80})\]/)?.[1];
      const place = block
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith("🌐"));
      return {
        bracketLine: bracket ? bracket.trim() : undefined,
        placeLine: place ? place.trim() : undefined,
      };
    }
    return {};
  } catch {
    return {};
  }
}

// If a ```STATUS ...``` fenced block exists and is closed, remove any extra output after it.
// This prevents the model from "finishing STATUS" and then continuing narrative (wasted tokens / broken UI).
export function trimAfterClosedStatusFence(s: string): { text: string; trimmed: boolean } {
  const src = String(s ?? "");

  // Find the last ```STATUS ...``` opener (models may emit multiple).
  const re = /```[ \t]*STATUS(?:\s|$)/gi;
  let openIdx = -1;
  for (const m of src.matchAll(re)) {
    if (typeof (m as any).index === "number") openIdx = (m as any).index as number;
  }
  if (openIdx < 0) return { text: src, trimmed: false };

  const closeIdx = src.indexOf("```", openIdx + 3);
  if (closeIdx < 0) return { text: src, trimmed: false };

  const end = closeIdx + 3;
  const afterRaw = src.slice(end);
  if (afterRaw.trim().length === 0) return { text: src, trimmed: false };

  // Preserve content while keeping STATUS as the final fenced block:
  // move any trailing narrative to BEFORE the STATUS block instead of deleting it.
  const before = src.slice(0, openIdx).trimEnd();
  const fenceBlock = src.slice(openIdx, end).trimEnd();
  const tail = afterRaw.trimStart();

  const moved = (before ? before + "\n\n" : "") + tail + "\n\n" + fenceBlock;
  return { text: moved, trimmed: true };
}

export function normalizeStatusFenceOpen(text: string): { normalized: boolean; text: string } {
  const s0 = String(text || "");
  const out = normalizeAnyFenceOpen(s0);
  return { normalized: out !== s0, text: out };
}

export function repairUnclosedStatusFence(text: string): { repaired: boolean; text: string } {
  const s0 = String(text || "");
  const out = repairUnclosedAnyFence(s0);
  return { repaired: out !== s0, text: out };
}

// Return the end offset (index) of the last closed ```STATUS ... ``` block.
// - If no closed STATUS block exists, returns -1.
// - The returned index points to the end of the closing fence line (exclusive).
export function findLastStatusFenceCloseEnd(text: string): number {
  const src = String(text ?? "");
  const openIdx = src.search(/```\s*STATUS\b/i);
  if (openIdx < 0) return -1;

  // Find the last line that is exactly ``` after the STATUS open.
  const re = /^```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = re.exec(src)) !== null) {
    if (m.index > openIdx) last = m.index;
  }
  if (last < 0) return -1;

  const nl = src.indexOf("\n", last);
  return nl >= 0 ? nl : src.length;
}
