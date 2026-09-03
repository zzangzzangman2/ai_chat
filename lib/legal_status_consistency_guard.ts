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

function hasContextualSubjectReference(text: string) {
  return /(?:그놈|그\s*자|그\s*사람|그는|그가|그에게|범인은|용의자는|놈은|자는)/u.test(text);
}

function isBareStatusPredicate(text: string) {
  return /^[\s"“”'‘’*]*(?:1급\s*)?(?:피의자|피고인|수배자|수배\s*중|구속\s*(?:상태|중)|수형자|복역\s*중)/u.test(
    text
  );
}

function lastMentionedIdentity(text: string, identities: LegalStatusIdentity[]) {
  let result: LegalStatusIdentity | undefined;
  let resultIndex = -1;
  for (const identity of identities) {
    for (const name of identityNames(identity)) {
      if (name.length < 2) continue;
      const index = text.lastIndexOf(name);
      if (index > resultIndex) {
        result = identity;
        resultIndex = index;
      }
    }
  }
  return result;
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
  trustedTexts: string[],
  identities: LegalStatusIdentity[]
) {
  return trustedTexts.some((source) => {
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

/// 법적 신분 주장의 근거로 인정할 텍스트를 모은다.
///
/// 사용자가 쓴 문장뿐 아니라 **이미 확정된 서술**도 근거다. 롤플레이에서 사건은
/// 대부분 서술로 일어난다. 사용자가 "구속"이라고 타이핑한 적이 없어도, 앞선 턴에서
/// 구속이 서술되어 저장됐다면 그건 이야기의 사실이다. 근거를 사용자 입력으로만
/// 좁히면 서술로 성립한 사건이 요약 단계에서 통째로 지워지고, 장기기억에는 더 약한
/// 표현(예: 조사)만 남는다. 실제로 그 사고가 났다.
///
/// 없는 신분을 새로 지어내는 것은 생성 시점 가드가 막는다. 그 시점의 in-flight
/// 텍스트는 스스로의 근거가 될 수 없으므로 여기 넘기지 않는다.
function collectTrustedTexts(input: {
  trustedUserTexts?: string[];
  trustedNarrationTexts?: string[];
}) {
  return [
    ...(input.trustedUserTexts || []).filter(
      (value) =>
        !/(?:하지도\s*않|한\s*적(?:이|도)?\s*없|아닌데|아니라고|지어내|잘못(?:된|했|됐)|오류|날조)/u.test(
          String(value || "")
        ) &&
        !/(?:수배자|피의자|피고인|구속|기소|유죄|복역)[^.!?。！？\n]{0,40}(?:라고\s*(?:말|해)|설명(?:해|하라)|말(?:해|하라)|알려(?:줘|달라)|나열(?:해|하라))/u.test(
          String(value || "")
        )
    ),
    ...(input.trustedNarrationTexts || []),
  ]
    .map((value) => String(value || ""))
    .filter((value) => value.trim());
}

export function removeUnsupportedLegalStatusClaims(input: {
  text: unknown;
  trustedUserTexts: string[];
  /// 이미 저장된 서술(assistant 턴). 확정 사실로 취급한다.
  trustedNarrationTexts?: string[];
  identities: LegalStatusIdentity[];
}): LegalStatusGuardResult {
  const source = String(input.text || "");
  if (!source.trim()) {
    return { text: source, removed: 0, statuses: [], characterNames: [] };
  }

  const trustedTexts = collectTrustedTexts(input);
  const identities = input.identities.filter((identity) => clean(identity.name));
  const removedStatuses = new Set<string>();
  const removedCharacters = new Set<string>();
  let removed = 0;
  let contextIdentity: LegalStatusIdentity | undefined;

  const lines = source.split(/\r?\n/u).map((line) => {
    if (/^\s*```/u.test(line)) {
      return line;
    }
    if (!line.trim()) return line;

    const kept = splitLineSentences(line).filter((sentence) => {
      const mentionedInSentence = lastMentionedIdentity(sentence, identities);
      const definitions = LEGAL_STATUSES.filter((definition) =>
        definition.claim.test(sentence)
      );
      if (definitions.length === 0) {
        if (mentionedInSentence) contextIdentity = mentionedInSentence;
        return true;
      }

      let targets = identities.filter((identity) => mentionsIdentity(sentence, identity));
      if (targets.length === 0 && hasSecondPersonReference(sentence)) {
        targets = identities.filter((identity) => identity.isPersona);
      }
      if (
        targets.length === 0 &&
        contextIdentity &&
        (hasContextualSubjectReference(sentence) || isBareStatusPredicate(sentence))
      ) {
        targets = [contextIdentity];
      }
      if (targets.length === 0 && isBareStatusPredicate(sentence)) {
        const personas = identities.filter((identity) => identity.isPersona);
        if (personas.length === 1) targets = personas;
      }
      if (targets.length === 0) return true;

      const unsupported = definitions.some((definition) =>
        targets.some(
          (identity) =>
            !hasTrustedEvidence(definition, identity, trustedTexts, identities)
        )
      );
      if (!unsupported) {
        if (mentionedInSentence) contextIdentity = mentionedInSentence;
        return true;
      }

      removed += 1;
      for (const definition of definitions) removedStatuses.add(definition.id);
      for (const identity of targets) removedCharacters.add(identity.name);
      if (mentionedInSentence) contextIdentity = mentionedInSentence;
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
