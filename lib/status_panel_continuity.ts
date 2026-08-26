import { splitTrailingPanels } from "./turn_completion_guard";

export type StatusPanelMessage = { role?: string; content?: string };

type TrailingPanel = {
  before: string;
  fence: string;
  label: string;
  lines: string[];
};

function trailingPanel(value: unknown): TrailingPanel | null {
  const split = splitTrailingPanels(value);
  const current = split.panels[0];
  if (!current) return null;
  return {
    before: split.body,
    fence: current.fence,
    label: current.label,
    lines: current.lines,
  };
}

function keyOfLine(line: string) {
  const match = String(line || "").match(/^\s*([^:\n]{1,48})\s*:\s*(.*)$/u);
  if (!match) return null;
  return { display: match[1].trim(), key: match[1].replace(/\s+/g, "").toLocaleLowerCase("ko-KR"), value: match[2].trim() };
}

function affinityEntryKey(value: string) {
  const text = String(value || "").trim();
  const match = text.match(/^(.*?)(?:\s+|^)[+\-]?\d+(?:\s*\/\s*100)?\s*$/u);
  return (match?.[1] || text).replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
}

function mergeAffinityValues(current: string, previous: string, maxEntries: number) {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...current.split("|"), ...previous.split("|")]) {
    const cleaned = entry.trim();
    const key = affinityEntryKey(cleaned);
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    values.push(cleaned);
    if (values.length >= maxEntries) break;
  }
  return values.join(" | ");
}

function isAffinityKey(key: string) {
  return /호감도|친밀도|affinity|favor|relationshipscore/u.test(key);
}

function mergePanelFences(currentFence: string, previousFence: string, maxAffinityEntries: number) {
  const current = trailingPanel(currentFence);
  const previous = trailingPanel(previousFence);
  if (!current || !previous) return currentFence;
  if (current.label.toLocaleUpperCase("ko-KR") !== previous.label.toLocaleUpperCase("ko-KR")) return currentFence;

  const currentByKey = new Map<string, { display: string; value: string }>();
  const currentLoose: string[] = [];
  for (const line of current.lines) {
    const parsed = keyOfLine(line);
    if (parsed) currentByKey.set(parsed.key, { display: parsed.display, value: parsed.value });
    else if (line.trim()) currentLoose.push(line);
  }

  const output: string[] = [];
  const used = new Set<string>();
  for (const line of previous.lines) {
    const prior = keyOfLine(line);
    if (!prior) {
      if (line.trim()) output.push(line);
      continue;
    }
    const next = currentByKey.get(prior.key);
    if (!next) {
      output.push(`${prior.display}: ${prior.value}`);
    } else {
      const value = isAffinityKey(prior.key)
        ? mergeAffinityValues(next.value, prior.value, maxAffinityEntries)
        : next.value;
      output.push(`${next.display}: ${value}`);
      used.add(prior.key);
    }
  }
  for (const [key, entry] of currentByKey) {
    if (used.has(key)) continue;
    output.push(`${entry.display}: ${entry.value}`);
  }
  for (const line of currentLoose) {
    if (!output.includes(line)) output.push(line);
  }
  return `\`\`\`${current.label}\n${output.join("\n")}\n\`\`\``;
}

export function mergeStatusPanelContinuity(params: {
  currentText: unknown;
  previousPanel: unknown;
  maxAffinityEntries?: number;
  appendWhenMissing?: boolean;
}) {
  const currentText = String(params.currentText || "");
  const current = trailingPanel(currentText);
  const previous = trailingPanel(params.previousPanel);
  if (!previous) return { text: currentText, changed: false, panel: current?.fence || "", appended: false };
  if (!current) {
    if (!params.appendWhenMissing) {
      return { text: currentText, changed: false, panel: "", appended: false };
    }
    const body = currentText.trimEnd();
    const text = `${body}${body ? "\n\n" : ""}${previous.fence}`;
    return { text, changed: text !== currentText, panel: previous.fence, appended: true };
  }
  const mergedFence = mergePanelFences(
    current.fence,
    previous.fence,
    Math.max(1, Math.min(20, Math.floor(params.maxAffinityEntries ?? 5)))
  );
  const text = `${current.before}${current.before ? "\n\n" : ""}${mergedFence}`;
  return { text, changed: text !== currentText.trimEnd(), panel: mergedFence, appended: false };
}

export function buildPreviousStatusPanelSnapshot(messages: StatusPanelMessage[], maxPanels = 20) {
  const panels: string[] = [];
  for (let i = messages.length - 1; i >= 0 && panels.length < maxPanels; i -= 1) {
    if (String(messages[i]?.role || "").toLowerCase() !== "assistant") continue;
    const panel = trailingPanel(messages[i]?.content);
    if (panel) panels.unshift(panel.fence);
  }
  let snapshot = "";
  for (const panel of panels) {
    snapshot = snapshot
      ? mergeStatusPanelContinuity({ currentText: panel, previousPanel: snapshot }).panel
      : panel;
  }
  return snapshot;
}
