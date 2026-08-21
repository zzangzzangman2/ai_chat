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
