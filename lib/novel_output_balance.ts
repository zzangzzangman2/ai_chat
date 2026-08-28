export type NovelOutputBalanceResult = {
  text: string;
  repaired: boolean;
  added: string;
};

function trailingFenceStart(text: string) {
  const markers = Array.from(text.matchAll(/^\s*```[^\n]*$/gm));
  if (markers.length < 2 || markers.length % 2 !== 0) return text.length;
  const last = markers[markers.length - 1];
  const lastEnd = Number(last.index || 0) + String(last[0] || "").length;
  if (text.slice(lastEnd).trim()) return text.length;
  return Number(markers[markers.length - 2].index || text.length);
}

function isNovelImageParagraph(value: string) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  return lines.every(
    (line) =>
      /^!*https?:\/\/\S+$/i.test(line) ||
      /^!\[[^\]]*\]\([^)]+\)$/.test(line) ||
      /^\{\{img:/i.test(line)
  );
}

function dialogueCloseFor(open: string) {
  if (open === "“" || open === "”") return "”";
  return open === "＂" ? "＂" : '"';
}

function openingForOrphanClose(close: string) {
  if (close === "”") return "“";
  return close === "＂" ? "＂" : '"';
}

function quoteGlyphs(value: string) {
  return value.match(/["“”＂]/gu) || [];
}

function unescapedMarkerCount(value: string, marker: string) {
  let count = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === marker) count += 1;
  }
  return count;
}

function repairTrailingInlineCodeInNarration(body: string): {
  text: string;
  repaired: boolean;
  added: string;
} {
  const trailingWhitespace = body.match(/\s*$/u)?.[0] || "";
  const core = trailingWhitespace ? body.slice(0, -trailingWhitespace.length) : body;
  const paragraphBoundary = core.lastIndexOf("\n\n");
  const paragraphStart = paragraphBoundary >= 0 ? paragraphBoundary + 2 : 0;
  const paragraph = core.slice(paragraphStart);
  if (!paragraph.startsWith("*")) return { text: body, repaired: false, added: "" };

  const hasOuterClose = paragraph.length > 1 && paragraph.endsWith("*");
  const innerEnd = hasOuterClose ? paragraph.length - 1 : paragraph.length;
  const inner = paragraph.slice(1, innerEnd);
  if (unescapedMarkerCount(inner, "`") % 2 === 0) {
    return { text: body, repaired: false, added: "" };
  }

  const openTickAt = inner.lastIndexOf("`");
  if (openTickAt < 0) return { text: body, repaired: false, added: "" };
  const inlineTail = inner.slice(openTickAt + 1);
  const missingSquareClosers = Math.max(
    0,
    Math.min(4, unescapedMarkerCount(inlineTail, "[") - unescapedMarkerCount(inlineTail, "]"))
  );
  const added = `${"]".repeat(missingSquareClosers)}\``;
  const repairedParagraph = hasOuterClose
    ? `${paragraph.slice(0, -1)}${added}*`
    : `${paragraph}${added}`;
  return {
    text: `${core.slice(0, paragraphStart)}${repairedParagraph}${trailingWhitespace}`,
    repaired: true,
    added,
  };
}

function normalizeNovelBodyParagraph(part: string) {
  if (!part.trim()) return part;
  const leading = part.match(/^\s*/u)?.[0] || "";
  // Preserve structural newlines but never keep horizontal whitespace before
  // a blank paragraph boundary; it can create visible indentation and makes
  // otherwise identical normalized paragraphs non-idempotent.
  const trailing = (part.match(/\s*$/u)?.[0] || "").replace(/[^\r\n]/gu, "");
  const trimmed = part.trim();
  if (trimmed.startsWith("```") || isNovelImageParagraph(trimmed)) return part;

  // A model sometimes emits *spoken words."* — a narration wrapper with only
  // an orphan closing quote. That is a dialogue paragraph whose opening quote
  // was lost, not narration.
  if (trimmed.startsWith("*") && !trimmed.startsWith("**")) {
    // A valid narration paragraph may have acquired one stray quote after its
    // closing star. Drop that quote instead of turning the narration into
    // dialogue (for example: *그가 서류를 내려놓았다.*").
    const closedNarrationWithStrayQuote = trimmed.match(/^\*([\s\S]*?)\*["”＂]+$/u);
    if (closedNarrationWithStrayQuote) {
      const content = String(closedNarrationWithStrayQuote[1] || "")
        .replace(/\*+/gu, "")
        .trim();
      return `${leading}*${content}*${trailing}`;
    }

    let inner = trimmed.slice(1).replace(/\*+\s*$/u, "").trim();
    if (/^["“”＂]/u.test(inner) && /["”＂]$/u.test(inner)) {
      const open = inner[0];
      const close = dialogueCloseFor(open);
      const content = inner.slice(1).replace(/["”＂]+$/u, "").trim();
      return `${leading}${open}${content}${close}${trailing}`;
    }
    const quotes = quoteGlyphs(inner);
    const orphanClose = inner.match(/(["”＂])\s*$/u)?.[1] || "";
    if (orphanClose && quotes.length === 1) {
      const content = inner
        .replace(/["”＂]+\s*$/u, "")
        .replace(/\*+/gu, "")
        .trimEnd();
      return `${leading}${openingForOrphanClose(orphanClose)}${content}${orphanClose}${trailing}`;
    }
    // Nested or early-closing star fragments cannot carry role state inside a
    // paragraph. The whole paragraph is narration, so retain one outer pair.
    inner = inner.replace(/\*+/gu, "").trim();
    return `${leading}*${inner}*${trailing}`;
  }

  // Dialogue markers are paragraph-scoped. Close a missing quote at this
  // paragraph boundary and collapse duplicate closing quotes locally.
  const dialogue = trimmed.match(/^((?:[^"“”＂\n]{1,50}\|\s*)?)(["“”＂])([\s\S]*)$/u);
  if (dialogue) {
    const prefix = dialogue[1] || "";
    const open = dialogue[2] || '"';
    const close = dialogueCloseFor(open);
    const content = String(dialogue[3] || "")
      .replace(/\*+\s*$/u, "")
      .replace(/["”＂]+\s*$/u, "")
      .trim();
    return `${leading}${prefix}${open}${content}${close}${trailing}`;
  }

  // A standalone paragraph with exactly one closing quote lost its opener.
  // Repairing it here prevents the renderer from treating spoken words as
  // white narration merely because the first character went missing.
  const quotes = quoteGlyphs(trimmed);
  const orphanClose = trimmed.match(/(["”＂])\s*$/u)?.[1] || "";
  if (orphanClose && quotes.length === 1) {
    const content = trimmed.replace(/["”＂]+\s*$/u, "").trimEnd();
    return `${leading}${openingForOrphanClose(orphanClose)}${content}${orphanClose}${trailing}`;
  }

  return `${leading}*${trimmed}*${trailing}`;
}

// Streaming responses are shown append-only while tokens arrive, so the strict
// novel formatter cannot safely rewrite them mid-stream. Normalize only the
// completed body and leave the trailing STATUS/INFO fence byte-for-byte intact.
export function normalizeNovelParagraphMarkers(value: unknown) {
  const original = String(value || "").replace(/\r\n/g, "\n");
  if (!original.trim()) return { text: original, changed: false };
  // Older/provider output can glue the trailing metadata fence directly to a
  // completed dialogue. Split it before role normalization so the status panel
  // is never swallowed into dialogue or given a synthetic closing quote.
  const text = original.replace(
    /([^\n])```(?=(?:STATUS|INFO|STREAM|TEXT|상태))/giu,
    "$1\n\n```"
  );

  const splitAt = trailingFenceStart(text);
  const body = text.slice(0, splitAt);
  const tail = text.slice(splitAt);
  const normalizedBody = body
    .split(/(\n{2,})/)
    .map((part) => {
      if (!part.trim() || /^\n{2,}$/.test(part)) return part;
      return normalizeNovelBodyParagraph(part);
    })
    .join("");
  const normalized = normalizedBody + tail;
  return { text: normalized, changed: normalized !== original };
}

export function repairUnbalancedNovelBodyMarkers(value: unknown): NovelOutputBalanceResult {
  const text = String(value || "");
  const splitAt = trailingFenceStart(text);
  const originalBody = text.slice(0, splitAt);
  const tail = text.slice(splitAt);
  const inlineRepair = repairTrailingInlineCodeInNarration(originalBody);
  const body = inlineRepair.text;
  let quoteOpen = false;
  let starOpen = false;
  let quoteOpenedAt = -1;
  let starOpenedAt = -1;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoteOpen = !quoteOpen;
      quoteOpenedAt = quoteOpen ? i : -1;
    } else if (ch === "*") {
      starOpen = !starOpen;
      starOpenedAt = starOpen ? i : -1;
    }
  }

  const open = [
    quoteOpen ? { at: quoteOpenedAt, marker: '"' } : null,
    starOpen ? { at: starOpenedAt, marker: "*" } : null,
  ]
    .filter((item): item is { at: number; marker: string } => Boolean(item))
    .sort((a, b) => b.at - a.at);
  const markerAdded = open.map((item) => item.marker).join("");
  const added = `${inlineRepair.added}${markerAdded}`;
  if (!added) return { text, repaired: false, added: "" };

  const repairedBody = markerAdded
    ? body.replace(/\s*$/, (whitespace) => `${markerAdded}${whitespace}`)
    : body;
  return { text: repairedBody + tail, repaired: true, added };
}
