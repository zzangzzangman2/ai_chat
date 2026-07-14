// Remove explicit end markers ONLY.
//
// IMPORTANT:
// - This function is called on EVERY delta append (streamTarget += delta).
// - NEVER trim whitespace/newlines here (trim/trimEnd/trimStart are forbidden).
//   If we remove a chunk-boundary "\n", a following meta fence that starts with
//   ```LABEL may no longer be at line-start, and the client meta splitter will fail.
export function stripEndMarkerClient(t: string): string {
  let s = String(t || "");
  // Known end markers used across versions.
  // Remove the marker tokens only; keep surrounding whitespace/newlines intact.
  // (Do not use regex with embedded newlines to avoid build-time parsing issues.)
  s = s.replaceAll("<<<END_OF_OUTPUT>>>", "");
  s = s.replaceAll("[END]", "");
  s = s.replaceAll("<END>", "");
  return s;
}

// Server-side postprocessing treats any text after a final meta fence as garbage.
// To avoid "stream showed it, then it vanished" mismatches and to keep UI consistent with DB,
// apply the same rule on the client.
function _normAllowed(labels: readonly string[] | undefined | null): string[] {
  return Array.from(
    new Set((labels || []).map((x) => String(x || "").trim()).filter(Boolean).map((x) => x.toUpperCase()))
  );
}


function _isLineStartFenceAt(s: string, pos: number): boolean {
  if (pos < 0) return false;
  const lineStart = s.lastIndexOf("\n", pos - 1) + 1;
  const prefix = s.slice(lineStart, pos);
  return /^[\t ]*$/.test(prefix);
}

function _findLastLineStartFence(s: string, from: number): number {
  let p = Math.min(from, s.length - 1);
  while (p >= 0) {
    p = s.lastIndexOf("```", p);
    if (p < 0) return -1;
    if (_isLineStartFenceAt(s, p)) return p;
    p -= 1;
  }
  return -1;
}


export function stripTrailingTextAfterFinalMetaFenceClient(
  t: string,
  allowedLabels: readonly string[] = []
): string {
  const s = String(t || "");
  const lastClose = _findLastLineStartFence(s, s.length - 1);
  if (lastClose < 0) return s;

  const beforeClose = s.slice(0, lastClose);
  const lastOpen = _findLastLineStartFence(beforeClose, beforeClose.length - 1);
  if (lastOpen < 0) return s;

  const lineEnd = s.indexOf("\n", lastOpen + 3);
  const openLine = (lineEnd >= 0 ? s.slice(lastOpen, lineEnd) : s.slice(lastOpen)).trim();
  const label = openLine.slice(3).trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  const allowed = new Set(_normAllowed(allowedLabels));
  const allowAnyLabel = true; // label-agnostic
  const isMetaFence = allowAnyLabel || label === "STATUS" || label === "INFO" || allowed.has(label);
  if (!isMetaFence) return s;

  const afterRaw = s.slice(lastClose + 3);
  if (afterRaw.trim().length === 0) return s;

  // Preserve content while keeping the meta fence as the final block:
  // move trailing text to BEFORE the last meta fence.
  const head = s.slice(0, lastOpen).trimEnd();
  const fenceBlock = s.slice(lastOpen, lastClose + 3).trimEnd();
  const tail = afterRaw.trimStart();

  return (head ? head + "\n\n" : "") + tail + "\n\n" + fenceBlock;
}

// (길이 상한) UI에서 최종 확정 시, "목표 글자수 + 여유" 상한을 적용하되
// 문장/펜스가 중간에 끊기지 않도록 최대한 깔끔한 지점으로 뒤로 당겨 자른다.
function countTicks(s: string): number {
  const m = s.match(/```/g);
  return m ? m.length : 0;
}

function fenceLabelUpperFromOpenLine(openLine: string): string {
  return openLine.replace(/^```/, "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
}

function splitOneTrailingFenceBlock(s0: string): { body: string; fence: string; labelUpper: string } | null {
  const s = String(s0 ?? "").replace(/\r\n/g, "\n").trimEnd();
  const lastClose = _findLastLineStartFence(s, s.length - 1);
  if (lastClose < 0) return null;

  const beforeClose = s.slice(0, lastClose);
  const lastOpen = _findLastLineStartFence(beforeClose, beforeClose.length - 1);
  if (lastOpen < 0) return null;

  const fence = s.slice(lastOpen).trimEnd();
  const openLineEnd = s.indexOf("\n", lastOpen);
  const openLine = (openLineEnd >= 0 ? s.slice(lastOpen, openLineEnd) : s.slice(lastOpen)).trim();
  const labelUpper = fenceLabelUpperFromOpenLine(openLine);

  const body = s.slice(0, lastOpen).trimEnd();
  return { body, fence, labelUpper };
}
function splitTrailingOpenMetaFenceAtEndClient(
  s0: string,
  allowedLabels: readonly string[] = []
): { body: string; meta: string; labelUpper: string } | null {
  const s = String(s0 ?? "").replace(/\r\n/g, "\n").trimEnd();
  const last = _findLastLineStartFence(s, s.length - 1);
  if (last < 0) return null;

  // If there's already a closing fence after this, the closed-case splitter will handle it.
  const after = s.slice(last + 3);
  if (after.includes("```")) return null;

  const openLineEnd = s.indexOf("\n", last);
  const openLine = (openLineEnd >= 0 ? s.slice(last, openLineEnd) : s.slice(last)).trim();
  const labelUpper = fenceLabelUpperFromOpenLine(openLine);
  const allowed = new Set(_normAllowed(allowedLabels));
  const allowAnyLabel = true; // label-agnostic
  if (!allowAnyLabel && !(labelUpper === "STATUS" || labelUpper === "INFO" || allowed.has(labelUpper))) return null;

  const body = s.slice(0, last).trimEnd();
  const meta = s.slice(last).trimEnd();
  return { body, meta, labelUpper };
}



export function splitTrailingMetaFenceBlocksAtEndClient(
  s0: string,
  allowedLabels: readonly string[] = []
): { body: string; meta: string } {
  let cur = String(s0 ?? "").replace(/\r\n/g, "\n").trimEnd();
  const metas: string[] = [];

  const allowed = new Set(_normAllowed(allowedLabels));
  const allowAnyLabel = true; // label-agnostic

  while (true) {
  const one = splitOneTrailingFenceBlock(cur);
  if (one && (allowAnyLabel || one.labelUpper === "STATUS" || one.labelUpper === "INFO" || allowed.has(one.labelUpper))) {
    metas.unshift(one.fence.trimEnd());
    cur = one.body.trimEnd();
    continue;
  }

  // Accept an "open" ```STATUS / ```INFO block at the very end (no closing ``` yet),
  // so we can keep it outside the body budget and close it safely.
  const open = splitTrailingOpenMetaFenceAtEndClient(cur, allowedLabels);
  if (!open) break;

  metas.unshift(open.meta.trimEnd());
  cur = open.body.trimEnd();
}

  return { body: cur.trimEnd(), meta: metas.join("\n\n").trimEnd() };
}

function trimToCompleteForBudgetClient(s0: string): string {
  // Try to trim to a "clean" boundary (paragraph/sentence/quote/whitespace) near the end.
  const s = String(s0 ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (!s) return s;

  // 1) paragraph boundary
  const p = s.lastIndexOf("\n\n");
  if (p >= Math.max(0, s.length - 240)) return s.slice(0, p).trimEnd();

  // 2) sentence ending (KO/JA/EN)
  const tailStart = Math.max(0, s.length - 320);
  const tail = s.slice(tailStart);

  // Find last occurrence of a sentence end followed by space/newline or end.
  let best = -1;

  const reSentence = /([\.\!\?]|[。！？])(\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = reSentence.exec(tail))) {
    best = tailStart + m.index + m[0].length;
  }
  if (best >= s.length - 240) return s.slice(0, best).trimEnd();

  // 3) closing quote
  const q1 = s.lastIndexOf("\"");
  const q2 = s.lastIndexOf("”");
  const q = Math.max(q1, q2);
  if (q >= Math.max(0, s.length - 240)) return s.slice(0, q + 1).trimEnd();

  // 4) last whitespace/newline
  const ws = Math.max(s.lastIndexOf("\n"), s.lastIndexOf(" "));
  if (ws > 0) return s.slice(0, ws).trimEnd();

  return s;
}

export function capToCleanEndClient(text: string, maxChars: number, allowedLabels: readonly string[] = []): string {
  const s0 = String(text ?? "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return s0;

  const hard = Math.max(0, Math.floor(maxChars));

  // If the output ends with meta fence blocks, treat them as "out of budget":
  // - cap only the body to `hard`
  // - keep trailing ```STATUS / ```INFO blocks even if they push total chars over `hard`
  const split = splitTrailingMetaFenceBlocksAtEndClient(s0, allowedLabels);
  let body = split.body;
  let meta = split.meta;

  let s = body;


// If we need to cap the body, do it in a way that never drops an unmatched fence closer.
if (s.length > hard) {
  let t = s.slice(0, hard);

  // If we ended inside an open fence, reserve 4 chars for a closing fence by shrinking the body slice.
  if (countTicks(t) % 2 === 1) {
    const cap2 = Math.max(0, hard - 4);
    t = s.slice(0, cap2);
  }

  t = trimToCompleteForBudgetClient(t);

  // Ensure any open fence is closed (closing fence may be "out of budget" by up to 4 chars).
  if (countTicks(t) % 2 === 1) t = t.trimEnd() + "\n```";
  s = t;
} else {
  // Even without capping, ensure fence balance.
  if (countTicks(s) % 2 === 1) s = s.trimEnd() + "\n```";
}

  // If we have meta blocks, keep them (with a safety max).
  if (meta) {
    const META_HARD_MAX = 6000;
    if (meta.length > META_HARD_MAX) meta = meta.slice(0, META_HARD_MAX);

    // Ensure meta doesn't leave an unclosed fence.
    if (countTicks(meta) % 2 === 1) meta = meta.trimEnd() + "\n```";

    const bt = s.trimEnd();
    const joiner = bt ? "\n\n" : "";
    return `${bt}${joiner}${meta.trimEnd()}`.trimEnd();
  }

  return s.trimEnd();
}

// (novel) 별표(ASCII '*')와 전각/유사 별표(＊∗ 등)를 일관되게 처리하기 위한 정규화
export function normalizeStarVariants(input: string): string {
  let t = String(input || "");
  // fullwidth/variant stars -> '*'
  t = t.replace(/[＊∗﹡⁎٭✱✳✴✵✶✷✸✹✺✻✼✽✾✿❋]/g, "*");
  return t;
}

// (novel) 화면 출력에서는 별표 마커를 완전히 제거 (내부 판정은 별도 로직으로 처리)
export function stripAllStarGlyphs(input: string): string {
  const t = String(input || "");
  // normalizeStarVariants가 잡는 유사 별표는 먼저 '*'로 통일
  const n = normalizeStarVariants(t);
  // ASCII '*' 포함, 다양한 별표 변형을 폭넓게 제거
  return n.replace(/[*＊∗﹡⁎٭※✱✳✴✵✶✷✸✹✺✻✼✽✾✿❋]/g, "");
}

// (novel) '*나비의' 같은 라벨 라인이 멀티라인 지문으로 묶여 이후 색/판정이 꼬이는 문제 방지
// - 이 가드는 `startsNarr && !endsNarrSameLine` 케이스에서만 쓰인다.
export function isLikelyStarLabel(line: string): boolean {
  const s0 = normalizeStarVariants(String(line || "")).trim();
  if (!s0.startsWith("*")) return false;
  // 같은 줄에서 이미 닫힌 *...* 는 라벨 케이스가 아님
  if (s0.length >= 2 && s0.endsWith("*")) return false;

  const body = s0.slice(1).trimStart();
  if (!body) return true;

  // 너무 긴 문장은 라벨로 보지 않는다(멀티라인 지문 시작 가능)
  if (body.length > 32) return false;

  // 짧은 단어/태그 형태면 라벨로 간주
  const firstToken = (body.split(/\s+/)[0] || "").trim();
  if (!firstToken) return true;

  // 예: 나비의, SYSTEM], INFO:, 상태: 등
  if (firstToken.length <= 16) {
    if (/^(?:[A-Za-z0-9_\-\[\]📍📅🦋🛑]+|[가-힣]{1,12})(?:의|:|\]|》|〉|,|\.|!|\?)?$/.test(firstToken)) {
      return true;
    }
  }

  // 공백이 없는 매우 짧은 본문(예: *나비의)도 라벨로 처리
  if (!/\s/.test(body) && body.length <= 16) return true;

  return true; // 보수적으로 라벨로 처리하여 '열린 지문'으로 인한 UI 붕괴를 방지
}

// (novel/render) DB/NDJSON 경로에서 메시지 content가 "JSON 문자열"처럼 한 번 더 이스케이프되어
// `\\n`, `\\\"`, `\\uXXXX` 등이 그대로 들어오는 케이스가 있다.
// - 특히 code fence(````...````) 안에서 `\\n`이 그대로 노출되어 UI가 깨져 보임
// - 실제 개행/따옴표로 복원해 렌더 파이프라인(문단/대사 판정, 별표 제거)이 정상 동작하게 한다.
export function maybeUnescapeJsonEscapes(input: string): string {
  const s0 = String(input ?? "");
  if (!s0) return s0;

  // (fix) 모델/DB/NDJSON 경로에서 텍스트가 1~2회 "문자열로 이스케이프" 된 상태로 들어오면
  // `\n`, `\\n` 같은 리터럴이 남아 줄바꿈/펜스 파싱이 깨지고, 결과적으로 첫 코드펜스 이후가
  // 전부 "코드 블록"으로 오인되어 색상 규칙이 무시되는 문제가 생길 수 있다.
  // → 단, 일반 텍스트를 망가뜨리지 않도록 "이스케이프 토큰이 실제로 있을 때만" 최대 3회까지
  //    단계적으로 풀어준다(2중 이스케이프 우선).
  if (!/(\\\\n|\\n|\\\\r|\\r|\\\\t|\\t|\\\\u[0-9a-fA-F]{4}|\\u[0-9a-fA-F]{4}|\\\\"|\\"|\\\\\\\\)/.test(s0)) {
    return s0;
  }

  const decodeOnce = (s: string) => {
    let out = String(s);

    // 1) 2중 이스케이프(\\n 등) 먼저
    out = out
      .replace(/\\\\r\\\\n/g, "\n")
      .replace(/\\\\n/g, "\n")
      .replace(/\\\\r/g, "\r")
      .replace(/\\\\t/g, "\t")
      .replace(/\\\\"/g, '"')
      // \\uXXXX
      .replace(/\\\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
        try {
          return String.fromCharCode(parseInt(hex, 16));
        } catch {
          return _m;
        }
      })
      // \\\\ -> \\ (마지막)
      .replace(/\\\\\\\\/g, "\\");

    // 2) 1중 이스케이프(\n 등)
    out = out
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
        try {
          return String.fromCharCode(parseInt(hex, 16));
        } catch {
          return _m;
        }
      })
      // \\ -> \ (마지막)
      .replace(/\\\\/g, "\\");

    return out;
  };

  let cur = s0;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function isAssistantLikeRole(role: unknown): boolean {
  return role === "assistant" || role === "model";
}

export function toPromptRole(role: unknown): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

export type ReasoningLevel = "zero" | "low" | "middle" | "high";

function isGemini3ProFamily(model: string): boolean {
  return /gemini-3(?:\.\d+)?-pro/i.test(String(model || ""));
}

export function getReasoningLevelOptions(model: string): ReasoningLevel[] {
  if (isGemini3ProFamily(model)) return ["zero", "middle", "high"];
  return ["low", "middle", "high"];
}

export function getReasoningPresets(model: string): Record<ReasoningLevel, number> {
  // UI choices are stored as the numeric maxReasoningTokens setting.
  // UX 기준: 모두 LOW가 기본이며, 모델별로 기본 LOW 토큰만 다르게 둔다.
  if (isGemini3ProFamily(model)) {
    // The zero slot is shown as FAST and maps to the officially supported low level.
    return { zero: 0, low: 384, middle: 768, high: 1536 };
  }
  if (/^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(model)) {
    // Gemini 3 Flash: LOW는 latency 우선 minimal, MID/HIGH는 thinkingLevel로 매핑한다.
    return { zero: 0, low: 0, middle: 640, high: 1024 };
  }
  // gemini-2.5-pro
  return { zero: 0, low: 384, middle: 768, high: 2048 };
}

export function inferReasoningLevel(model: string, tokens: number): ReasoningLevel {
  const p = getReasoningPresets(model);
  const t = Number(tokens) || 0;
  const options = getReasoningLevelOptions(model);
  const entries: [ReasoningLevel, number][] = options.map((k) => [k, p[k]]);
  let best: ReasoningLevel = options.includes("middle") ? "middle" : "low";
  let bestDist = Infinity;
  for (const [k, v] of entries) {
    const d = Math.abs(v - t);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

export function stripLeadingTitleForDisplay(text: string): string {
  const src = String(text || "");
  if (!src) return src;
  const lines = src.split(/\r?\n/);
  // Remove up to 2 leading 'title' lines if the real content starts after a blank line
  // and the first non-empty line does NOT look like dialogue/narration/INFO/STATUS/code fence/image.
  let i = 0;
  // skip leading empties
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return src;
  const first = lines[i].trim();
  const second = (lines[i + 1] ?? "").trim();
  const third = (lines[i + 2] ?? "").trim();
  const looksLikeContent = (s: string) =>
    s.startsWith("*") ||
    s.startsWith('"') ||
    s.startsWith("```") ||
    s.startsWith("INFO") ||
    s.startsWith("STATUS") ||
    s.startsWith("[") ||
    s.startsWith("![") ||
    /^\{\{img:[^}]+\}\}/i.test(s) ||
    /^(?:!!\s*)?(?:https?:\/\/|\/\/|data:image\/|blob:)/i.test(s);
  const looksLikeTitle = (s: string) => !looksLikeContent(s) && s.length <= 60 && !/[`*_]/.test(s) && !s.startsWith("-");
  // Pattern: <title> + blank line + real content
  if (looksLikeTitle(first) && second === "" && third && looksLikeContent(third)) {
    const rest = lines.slice(i + 2).join("\n");
    return rest.replace(/^\s+/, "");
  }
  return src;
}

export function getModelDisplayLabel(rawModel: string): string {
  const m = String(rawModel || "").replace(/^google\//i, "").trim().toLowerCase();
  if (/^gemini-3\.1-pro(?:-|$)/i.test(m)) return "3.1-pro";
  if (/^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(m)) return "3.5-flash";
  if (/^gemini-3-pro(?:-|$)/i.test(m)) return "3.1-pro";
  if (/^gemini-2\.5-flash(?:-|$)/i.test(m)) return "2.5-pro";
  if (/^gemini-2\.5-pro(?:-|$)/i.test(m)) return "2.5-pro";
  return m ? m : "...";
}

export function getModelBadge(rawModel: string): { label: string; bg: string; fg: string } {
  const m = String(rawModel || "").replace(/^google\//i, "").trim().toLowerCase();
  if (/^gemini-3\.1-pro(?:-|$)/i.test(m)) {
    return { label: "3.1-pro", bg: "rgba(255, 75, 75, 0.22)", fg: "rgba(255, 165, 165, 0.98)" };
  }
  if (/^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(m)) {
    return { label: "3.5-flash", bg: "rgba(255, 120, 210, 0.18)", fg: "rgba(255, 190, 230, 0.98)" };
  }
  if (/^gemini-3-pro(?:-|$)/i.test(m)) {
    return { label: "3.1-pro", bg: "rgba(255, 75, 75, 0.18)", fg: "rgba(255, 140, 140, 0.98)" };
  }
  if (/^gemini-2\.5-flash(?:-|$)/i.test(m)) {
    return { label: "2.5-pro", bg: "rgba(180, 110, 255, 0.18)", fg: "rgba(220, 175, 255, 0.98)" };
  }
  if (/^gemini-2\.5-pro(?:-|$)/i.test(m)) {
    return { label: "2.5-pro", bg: "rgba(180, 110, 255, 0.18)", fg: "rgba(220, 175, 255, 0.98)" };
  }
  return { label: m || "...", bg: "rgba(255,255,255,0.05)", fg: "rgba(255,255,255,0.9)" };
}
