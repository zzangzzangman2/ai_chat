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

// Streaming responses are shown append-only while tokens arrive, so the strict
// novel formatter cannot safely rewrite them mid-stream. Normalize only the
// completed body and leave the trailing STATUS/INFO fence byte-for-byte intact.
export function normalizeNovelParagraphMarkers(value: unknown) {
  const text = String(value || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return { text, changed: false };

  const splitAt = trailingFenceStart(text);
  const body = text.slice(0, splitAt);
  const tail = text.slice(splitAt);
  const normalizedBody = body
    .split(/(\n{2,})/)
    .map((part) => {
      if (!part.trim() || /^\n{2,}$/.test(part)) return part;
      const leading = part.match(/^\s*/)?.[0] || "";
      const trailing = part.match(/\s*$/)?.[0] || "";
      const trimmed = part.trim();
      if (
        trimmed.startsWith("*") ||
        /^(?:[^"“\n]{1,50}\|\s*)?["“]/u.test(trimmed) ||
        trimmed.startsWith("```") ||
        isNovelImageParagraph(trimmed)
      ) {
        return part;
      }
      return `${leading}*${trimmed}*${trailing}`;
    })
    .join("");
  const normalized = normalizedBody + tail;
  return { text: normalized, changed: normalized !== text };
}

export function repairUnbalancedNovelBodyMarkers(value: unknown): NovelOutputBalanceResult {
  const text = String(value || "");
  const splitAt = trailingFenceStart(text);
  const body = text.slice(0, splitAt);
  const tail = text.slice(splitAt);
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
  const added = open.map((item) => item.marker).join("");
  if (!added) return { text, repaired: false, added: "" };

  const repairedBody = body.replace(/\s*$/, (whitespace) => `${added}${whitespace}`);
  return { text: repairedBody + tail, repaired: true, added };
}
