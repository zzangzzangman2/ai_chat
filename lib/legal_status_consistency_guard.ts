export type LegalStatusIdentity = {
  name: string;
  aliases?: string[];
  isPersona?: boolean;
};

export type LegalStatusGuardResult = {
  text: string;
  removed: number;
  statuses: string[];
  characterNames: string[];
};

type LegalStatusDefinition = {
  id: string;
  claim: RegExp;
  evidence: RegExp;
};

const LEGAL_STATUSES: LegalStatusDefinition[] = [
  {
    id: "suspect",
    claim: /피의자(?:\s*신분)?/u,
    evidence:
      /(?:피의자(?:로\s*(?:입건|전환)|\s*신분(?:이|으로)?\s*(?:되|됐|확정)|\s*(?:이다|였다|임))|입건(?:되|됐|됨|했다))/u,
  },
  {
    id: "defendant",
    claim: /(?:피고인|기소된\s*(?:사람|인물|자))/u,
    evidence: /(?:피고인(?:이|으로|신분)|기소(?:되|됐|됨|했다))/u,
  },
  {
    id: "wanted",
    claim: /(?:수배자|수배\s*중)/u,
    evidence: /수배(?:되|됐|됨|령|중)/u,
  },
  {
    id: "detained",
    claim: /(?:구속\s*(?:상태|중|피의자)|구속된\s*(?:사람|인물|자))/u,
    evidence: /구속(?:되|됐|됨|영장|상태|중)/u,
  },
  {
    id: "convicted",
    claim: /(?:수형자|복역\s*중|유죄가\s*확정된)/u,
    evidence: /(?:유죄\s*(?:판결|확정)|수형자|복역\s*중)/u,
  },
];

function clean(value: unknown, max = 100) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function identityNames(identity: LegalStatusIdentity) {
  return [...new Set([identity.name, ...(identity.aliases || [])].map((name) => clean(name)).filter(Boolean))];
}

function mentionsIdentity(text: string, identity: LegalStatusIdentity) {
  return identityNames(identity).some((name) => name.length >= 2 && text.includes(name));
}

function hasSecondPersonReference(text: string) {
  return /(?:당신|너는|네가|넌|너를|너에게|자네|그쪽)/u.test(text);
}

function splitLineSentences(line: string) {
  const marked = String(line || "").replace(
    /([.!?。！？](?:["”']|\*+)?)(\s+)/gu,
    "$1\u0000"
  );
  return marked.split("\u0000").map((part) => part.trim()).filter(Boolean);
}

function restoreOuterNarrationMarkers(original: string, value: string) {
  let output = String(value || "").trim();
  if (!output) return "";
  const source = String(original || "").trim();
  if (source.startsWith("*") && !output.startsWith("*")) output = `*${output}`;
  if (source.endsWith("*") && !output.endsWith("*")) output = `${output}*`;
  return output;
}

function hasTrustedEvidence(
  definition: LegalStatusDefinition,
  identity: LegalStatusIdentity,
  trustedUserTexts: string[],
  identities: LegalStatusIdentity[]
) {
  return trustedUserTexts.some((source) => {
    const text = String(source || "");
    const evidenceMatch = text.match(definition.evidence);
    if (!evidenceMatch) return false;
    const evidenceIndex = Number(evidenceMatch.index || 0);
    const mentioned = identities
      .map((candidate) => {
        let distance = Number.POSITIVE_INFINITY;
        for (const name of identityNames(candidate)) {
          const index = name.length >= 2 ? text.indexOf(name) : -1;
          if (index >= 0) distance = Math.min(distance, Math.abs(index - evidenceIndex));
        }
        return { candidate, distance };
      })
      .filter((item) => Number.isFinite(item.distance))
      .sort((a, b) => a.distance - b.distance);
    if (mentioned.length > 0) {
      const closestDistance = mentioned[0].distance;
      return mentioned.some(
        (item) =>
          item.distance <= closestDistance + 2 && item.candidate === identity
      );
    }
    return Boolean(identity.isPersona);
  });
}

export function removeUnsupportedLegalStatusClaims(input: {
  text: unknown;
  trustedUserTexts: string[];
  identities: LegalStatusIdentity[];
}): LegalStatusGuardResult {
  const source = String(input.text || "");
  if (!source.trim()) {
    return { text: source, removed: 0, statuses: [], characterNames: [] };
  }

  const identities = input.identities.filter((identity) => clean(identity.name));
  const removedStatuses = new Set<string>();
  const removedCharacters = new Set<string>();
  let removed = 0;
  let inFence = false;

  const lines = source.split(/\r?\n/u).map((line) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.trim()) return line;

    const kept = splitLineSentences(line).filter((sentence) => {
      const definitions = LEGAL_STATUSES.filter((definition) =>
        definition.claim.test(sentence)
      );
      if (definitions.length === 0) return true;

      let targets = identities.filter((identity) => mentionsIdentity(sentence, identity));
      if (targets.length === 0 && hasSecondPersonReference(sentence)) {
        targets = identities.filter((identity) => identity.isPersona);
      }
      if (targets.length === 0) return true;

      const unsupported = definitions.some((definition) =>
        targets.some(
          (identity) =>
            !hasTrustedEvidence(
              definition,
              identity,
              input.trustedUserTexts,
              identities
            )
        )
      );
      if (!unsupported) return true;

      removed += 1;
      for (const definition of definitions) removedStatuses.add(definition.id);
      for (const identity of targets) removedCharacters.add(identity.name);
      return false;
    });
    return restoreOuterNarrationMarkers(line, kept.join(" "));
  });

  if (removed === 0) {
    return { text: source, removed: 0, statuses: [], characterNames: [] };
  }

  return {
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n"),
    removed,
    statuses: [...removedStatuses],
    characterNames: [...removedCharacters],
  };
}
