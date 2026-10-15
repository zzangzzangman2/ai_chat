import { findMentionedCharacterIds } from "./character_mentions";

export type ActiveCharacterIdentity = {
  id: string;
  name: string;
  aliases?: string | string[] | null;
};

export type ActiveCharacterFocus = {
  ids: string[];
  names: string[];
  anchorText: string;
  reason: "current-explicit" | "pronoun-nearest-user" | "none";
  locked: boolean;
};

function cleanStoryText(value: unknown) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/g, " ");
}

function mentionedIdentities(text: unknown, identities: ActiveCharacterIdentity[]) {
  const source = cleanStoryText(text);
  if (!source.trim()) return [];
  const ids = findMentionedCharacterIds(identities, source);
  return identities.filter((identity) => ids.has(identity.id));
}

export function usesSecondPersonReference(text: unknown) {
  const source = cleanStoryText(text);
  return /(?:^|[\s,.!?~…"'“”‘’()\[\]{}<>:;|/\\])(?:너(?:는|가|를|랑|와|도|만|에게|한테|보고|의|로|야|냐|지|네|니|였|라)?|넌|널|네가|니가|네게|니게|당신)(?=$|[\s,.!?~…"'“”‘’()\[\]{}<>:;|/\\])/u.test(
    source
  );
}

export function resolveActiveCharacterFocus(params: {
  identities: ActiveCharacterIdentity[];
  currentUserText: unknown;
  previousUserTexts?: unknown[];
  maxPreviousTurns?: number;
}): ActiveCharacterFocus {
  const identities = (params.identities || []).filter(
    (identity) => String(identity?.id || "").trim() && String(identity?.name || "").trim()
  );
  const currentMatches = mentionedIdentities(params.currentUserText, identities);
  if (currentMatches.length) {
    return {
      ids: currentMatches.map((identity) => identity.id),
      names: currentMatches.map((identity) => identity.name),
      anchorText: cleanStoryText(params.currentUserText).trim(),
      reason: "current-explicit",
      locked: true,
    };
  }

  if (usesSecondPersonReference(params.currentUserText)) {
    const maxPreviousTurns = Math.max(1, Math.min(30, Math.floor(params.maxPreviousTurns ?? 12)));
    for (const previous of (params.previousUserTexts || []).slice(0, maxPreviousTurns)) {
      const matches = mentionedIdentities(previous, identities);
      if (!matches.length) continue;
      return {
        ids: matches.map((identity) => identity.id),
        names: matches.map((identity) => identity.name),
        anchorText: cleanStoryText(previous).trim(),
        reason: "pronoun-nearest-user",
        locked: true,
      };
    }
  }

  return { ids: [], names: [], anchorText: "", reason: "none", locked: false };
}
