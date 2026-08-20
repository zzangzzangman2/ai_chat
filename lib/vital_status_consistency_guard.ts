export type VitalStatusIdentity = {
  name: string;
  aliases?: string[];
};

export type VitalStatusGuardResult = {
  text: string;
  removed: number;
  subjects: string[];
};

const RELATION_SUBJECTS = [
  "아빠",
  "아버지",
  "엄마",
  "어머니",
  "남편",
  "아내",
  "오빠",
  "언니",
  "형",
  "누나",
  "동생",
  "할아버지",
  "할머니",
];

function clean(value: unknown, max = 100) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identityNames(identity: VitalStatusIdentity) {
  return [...new Set([identity.name, ...(identity.aliases || [])].map((name) => clean(name)).filter(Boolean))];
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

function hasConfirmedDeathClaim(text: string, rawSubject: string) {
  const subject = escapeRegex(rawSubject);
  const attached = `${subject}(?:은|는|이|가|도|의)?`;
  return new RegExp(
    `(?:${attached}\\s*(?:(?:이미|결국|끝내|현장에서|그\\s*자리에서)\\s*)?(?:죽었|사망했|숨졌|사살됐|살해당했|목숨을\\s*잃었|돌아가셨|시신으로\\s*발견)|(?:죽은|숨진|사망한|사살된|살해당한|목숨을\\s*잃은)\\s*${subject}|${subject}(?:의)?\\s*(?:(?:참혹한|끔찍한|갑작스러운|비극적인|억울한)\\s*)?(?:죽음|사망|시신|사체)|${subject}(?:은|는|이|가)?\\s*돌아가시고\\s*나서)`,
    "u"
  ).test(String(text || ""));
}

function isHypotheticalOrNegated(text: string, subject: string) {
  const at = String(text || "").indexOf(subject);
  const nearby = at >= 0
    ? String(text || "").slice(Math.max(0, at - 50), at + subject.length + 100)
    : String(text || "");
  return /(?:죽을|죽으면|죽일|죽여|자살하|사망할|목숨을\s*잃을|돌아가실)[^.!?。！？\n]{0,35}(?:지도|수도|까봐|경우|가정|위협|협박|싫|원치|않|못)|(?:안\s*죽|죽지\s*않|사망하지\s*않|살아\s*있)/u.test(nearby);
}

function hasTrustedUserDeathEvidence(subject: string, trustedUserTexts: string[]) {
  return trustedUserTexts.some((source) => {
    const text = String(source || "");
    if (!text.includes(subject) || isHypotheticalOrNegated(text, subject)) return false;
    return hasConfirmedDeathClaim(text, subject);
  });
}

/**
 * Removes factual death claims that were not established by the user or by
 * the already-derived continuity ledger. Threats, guesses and counterfactuals
 * must never be promoted into a character death by a generated response or
 * a long-memory summary.
 */
export function removeUnsupportedVitalStatusClaims(input: {
  text: unknown;
  trustedUserTexts: string[];
  identities?: VitalStatusIdentity[];
  establishedDeceasedNames?: string[];
}): VitalStatusGuardResult {
  const source = String(input.text || "");
  if (!source.trim()) return { text: source, removed: 0, subjects: [] };

  const identitySubjects = (input.identities || []).flatMap(identityNames);
  const subjects = [...new Set([...identitySubjects, ...RELATION_SUBJECTS])]
    .filter((subject) => subject.length >= 2)
    .sort((a, b) => b.length - a.length);
  const deceased = new Set(
    (input.establishedDeceasedNames || []).map((name) => clean(name).toLocaleLowerCase("ko-KR"))
  );
  const removedSubjects = new Set<string>();
  let removed = 0;
  let inFence = false;

  const lines = source.split(/\r?\n/u).map((line) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.trim()) return line;

    const kept = splitLineSentences(line).filter((sentence) => {
      const claimed = subjects.filter(
        (subject) =>
          sentence.includes(subject) &&
          hasConfirmedDeathClaim(sentence, subject) &&
          !isHypotheticalOrNegated(sentence, subject)
      );
      if (!claimed.length) return true;

      const unsupported = claimed.filter((subject) => {
        const established = deceased.has(subject.toLocaleLowerCase("ko-KR"));
        return !established && !hasTrustedUserDeathEvidence(subject, input.trustedUserTexts || []);
      });
      if (!unsupported.length) return true;

      removed += 1;
      unsupported.forEach((subject) => removedSubjects.add(subject));
      return false;
    });
    return restoreOuterNarrationMarkers(line, kept.join(" "));
  });

  if (!removed) return { text: source, removed: 0, subjects: [] };
  return {
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n"),
    removed,
    subjects: [...removedSubjects],
  };
}
