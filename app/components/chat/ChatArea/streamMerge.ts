import { splitTrailingMetaFenceBlocksAtEndClient } from "./textUtils";

export type StreamMergeSource = "server" | "buffered" | "merged";

export function normalizeMetaLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const set = new Set<string>();
  for (const x of labels) {
    const v = String(x ?? "").trim();
    if (v) set.add(v.toUpperCase());
  }
  return Array.from(set);
}

export function mergeAppendOnly(a: string, b: string): string {
  const A = String(a || "");
  const B = String(b || "");
  if (!A) return B;
  if (!B) return A;
  if (B.startsWith(A)) return B;
  if (A.startsWith(B)) return A;

  const max = Math.min(800, A.length, B.length);
  for (let k = max; k >= 24; k--) {
    if (A.slice(-k) === B.slice(0, k)) return A + B.slice(k);
  }

  let lcp = 0;
  const lim = Math.min(A.length, B.length);
  while (lcp < lim && A.charCodeAt(lcp) === B.charCodeAt(lcp)) lcp++;
  if (lcp >= Math.floor(lim * 0.7)) return A + B.slice(lcp);

  return A.length >= B.length ? A : B;
}

export function mergeStreamFinalContent(args: {
  buffered: string;
  fromServer: string;
  metaLabels?: unknown;
}): { content: string; source: StreamMergeSource; body: string; meta: string } {
  const metaAllowed = normalizeMetaLabels(args.metaLabels);
  const splitForMeta = (s: string) => splitTrailingMetaFenceBlocksAtEndClient(s, metaAllowed);

  const buffered = String(args.buffered || "");
  const fromServer = String(args.fromServer || "");
  let content = mergeAppendOnly(buffered, fromServer);
  let source: StreamMergeSource =
    content === buffered ? "buffered" : content === fromServer ? "server" : "merged";

  const serverMeta = splitForMeta(fromServer).meta.trimEnd();
  if (serverMeta && !splitForMeta(content).meta.trim()) {
    content = String(content || "").replace(/\s*$/g, "") + `\n\n${serverMeta}\n`;
    source = "merged";
  }

  const split = splitForMeta(content);
  return { content, source, body: split.body, meta: split.meta };
}
