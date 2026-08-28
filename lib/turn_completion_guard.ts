export type TrailingPanel = {
  before: string;
  fence: string;
  label: string;
  lines: string[];
};

export type TurnCompletionAssessment = {
  body: string;
  panels: TrailingPanel[];
  narrativeChars: number;
  dialogueCount: number;
  reasons: string[];
  needsRecovery: boolean;
};

const PLURAL_ADDRESS_PATTERN = /(?:둘\s*다|둘이|두\s*명|각자|모두|너네|너희(?:들)?|얘들아)/u;
const RESPONSE_REQUEST_PATTERN = /(?:대답|답해|말해|말해줘|알려|골라|선택|판단|평가|누구|뭐야|무엇|어때|할래)/u;

function charLength(value: unknown) {
  return Array.from(String(value || "")).length;
}

function peelTrailingPanel(value: unknown): TrailingPanel | null {
  const text = String(value || "").replace(/\r\n/g, "\n").trimEnd();
  const close = /```[ \t]*$/u.exec(text);
  if (!close || close.index == null) return null;

  const closeStart = close.index;
  const prefix = text.slice(0, closeStart);
  const openPattern = /```[ \t]*([^\n`]*)\n/gu;
  let open: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = null;
  while ((match = openPattern.exec(prefix)) !== null) open = match;
  if (!open || open.index == null) return null;

  const label = String(open[1] || "").trim().split(/\s+/u)[0] || "";
  if (!label) return null;

  const openStart = open.index;
  const innerStart = openStart + String(open[0] || "").length;
  const inner = text.slice(innerStart, closeStart).replace(/\n$/, "");
  return {
    before: text.slice(0, openStart).trimEnd(),
    fence: text.slice(openStart).trim(),
    label,
    lines: inner.split("\n"),
  };
}

// Accepts a panel whose opening fence is glued directly to the preceding
// dialogue (for example: `"answer"```상태`). It also peels duplicate trailing
// panels so callers can retain one authoritative panel.
export function splitTrailingPanels(value: unknown): { body: string; panels: TrailingPanel[] } {
  let body = String(value || "").replace(/\r\n/g, "\n").trimEnd();
  const panels: TrailingPanel[] = [];

  for (let i = 0; i < 8; i += 1) {
    const panel = peelTrailingPanel(body);
    if (!panel) break;
    panels.unshift(panel);
    body = panel.before;
  }

  return { body: body.trimEnd(), panels };
}

function countDialogueBlocks(body: string) {
  const matches = String(body || "").match(/"[^"\n]{1,1200}"/gu);
  return matches?.length || 0;
}

function hasUnbalancedNovelMarkers(body: string) {
  const quoteCount = (String(body || "").match(/"/gu) || []).length;
  const starCount = (String(body || "").match(/\*/gu) || []).length;
  return quoteCount % 2 !== 0 || starCount % 2 !== 0;
}

function hasUnbalancedInlineCode(body: string) {
  let count = 0;
  const text = String(body || "");
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") count += 1;
  }
  return count % 2 !== 0;
}

export function assessTurnCompletion(params: {
  text: unknown;
  currentUserText?: unknown;
  minNarrativeChars: number;
  finishReason?: unknown;
}): TurnCompletionAssessment {
  const split = splitTrailingPanels(params.text);
  const body = split.body.trim();
  const narrativeChars = charLength(body);
  const dialogueCount = countDialogueBlocks(body);
  const userText = String(params.currentUserText || "");
  const reasons: string[] = [];
  const minNarrativeChars = Math.max(0, Math.floor(Number(params.minNarrativeChars) || 0));

  if (/MAX_TOKENS/i.test(String(params.finishReason || ""))) reasons.push("MAX_TOKENS");
  if (!body) reasons.push("EMPTY_BODY");
  if (narrativeChars > 0 && minNarrativeChars - narrativeChars > 50) reasons.push("SHORT_BODY");
  if (body && hasUnbalancedNovelMarkers(body)) reasons.push("UNBALANCED_MARKER");
  if (body && hasUnbalancedInlineCode(body)) reasons.push("UNBALANCED_INLINE_CODE");

  const pluralResponseRequested =
    PLURAL_ADDRESS_PATTERN.test(userText) && RESPONSE_REQUEST_PATTERN.test(userText);
  if (pluralResponseRequested && dialogueCount < 2) reasons.push("PLURAL_RESPONSE_INCOMPLETE");

  return {
    body,
    panels: split.panels,
    narrativeChars,
    dialogueCount,
    reasons,
    needsRecovery: Boolean(reasons.length),
  };
}
