export type AddressDirection = {
  id?: string;
  speakerKey: string;
  speakerName: string;
  targetKey: string;
  targetName: string;
  term: string;
  sourceRole?: string;
  isManual?: boolean;
  lastSeenTurn?: number;
};

export type AddressDirectionOutputGuardResult = {
  text: string;
  replaced: number;
  terms: string[];
  reversedSpeakers: string[];
};

function clean(value: unknown, max = 80) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function key(value: unknown) {
  return clean(value, 120).toLocaleLowerCase("ko-KR");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameVariants(value: unknown) {
  const name = clean(value, 80);
  const variants = new Set<string>();
  if (name) variants.add(name);
  // Korean full names in stored relationship rows normally include a one-
  // syllable family name, while novel prose commonly omits it (박도훈 → 도훈).
  if (/^[가-힣]{3,4}$/u.test(name)) variants.add(name.slice(1));
  return Array.from(variants)
    .filter((item) => item.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function sanitizeOutsideFences(source: string, sanitize: (text: string) => string) {
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(/```[\s\S]*?(?:```|$)/gu)) {
    const index = Number(match.index || 0);
    output += sanitize(source.slice(cursor, index));
    output += String(match[0] || "");
    cursor = index + String(match[0] || "").length;
  }
  output += sanitize(source.slice(cursor));
  return output;
}

function priority(direction: AddressDirection) {
  if (direction.isManual) return 4;
  if (clean(direction.sourceRole, 20) === "user") return 3;
  if (!clean(direction.sourceRole, 20)) return 2;
  return 1;
}

export function normalizeAddressDirection(value: Partial<AddressDirection>) {
  const direction: AddressDirection = {
    id: clean(value.id, 120),
    speakerKey: clean(value.speakerKey, 120),
    speakerName: clean(value.speakerName, 80),
    targetKey: clean(value.targetKey, 120),
    targetName: clean(value.targetName, 80),
    term: clean(value.term, 40).replace(/^["'“”]+|["'“”]+$/g, ""),
    sourceRole: clean(value.sourceRole, 20),
    isManual: Boolean(value.isManual),
    lastSeenTurn: Math.max(0, Math.trunc(Number(value.lastSeenTurn || 0))),
  };
  if (
    !direction.speakerKey ||
    !direction.speakerName ||
    !direction.targetKey ||
    !direction.targetName ||
    !direction.term ||
    key(direction.speakerKey) === key(direction.targetKey)
  ) {
    return null;
  }
  return direction;
}

export function addressDirectionsConflict(left: AddressDirection, right: AddressDirection) {
  return (
    key(left.term) === key(right.term) &&
    key(left.speakerKey) === key(right.targetKey) &&
    key(left.targetKey) === key(right.speakerKey)
  );
}

export function selectCanonicalAddressDirections(values: Array<Partial<AddressDirection>>) {
  const selected = new Map<string, AddressDirection>();
  for (const value of values) {
    const direction = normalizeAddressDirection(value);
    if (!direction) continue;
    const endpoints = [key(direction.speakerKey), key(direction.targetKey)].sort();
    const conflictKey = `${endpoints[0]}\u0000${endpoints[1]}\u0000${key(direction.term)}`;
    const previous = selected.get(conflictKey);
    if (!previous) {
      selected.set(conflictKey, direction);
      continue;
    }
    const nextRank = [priority(direction), Number(direction.lastSeenTurn || 0)];
    const previousRank = [priority(previous), Number(previous.lastSeenTurn || 0)];
    if (
      nextRank[0] > previousRank[0] ||
      (nextRank[0] === previousRank[0] && nextRank[1] > previousRank[1])
    ) {
      selected.set(conflictKey, direction);
    }
  }
  return Array.from(selected.values());
}

export function formatAddressDirectionGuard(values: Array<Partial<AddressDirection>>) {
  const directions = selectCanonicalAddressDirections(values);
  if (!directions.length) return "";
  return [
    "# [호칭 발화 방향 정사 — 관계 자유문장보다 우선]",
    "- `A → B: 호칭`은 A가 B를 그 호칭으로 부른다는 뜻이다. B가 A를 그렇게 부르는 것이 아니다.",
    "- 호칭은 발화자와 수신자를 뒤집거나 실제 혈연·혼인 관계로 자동 승격하지 않는다.",
    ...directions.map(
      (direction) =>
        `- ${direction.speakerName} → ${direction.targetName}: “${direction.term}” (역방향 사용 금지)`
    ),
  ].join("\n");
}

/**
 * Deterministic output backstop for directed titles.
 *
 * Prompt instructions and structured-memory conflict checks keep the canon
 * clean, but a provider can still emit a reversed vocative in the live prose.
 * The stream path calls this function only after a complete sentence/newline
 * is buffered, so a bad title is replaced before it reaches the client or DB.
 * Fenced INFO/STATUS metadata is left untouched because a relationship label
 * there is not necessarily spoken dialogue.
 */
export function sanitizeAddressDirectionOutput(input: {
  text: unknown;
  directions: Array<Partial<AddressDirection>>;
}): AddressDirectionOutputGuardResult {
  const source = String(input.text || "");
  const directions = selectCanonicalAddressDirections(input.directions || []);
  if (!source || directions.length === 0) {
    return { text: source, replaced: 0, terms: [], reversedSpeakers: [] };
  }

  const replacedTerms = new Set<string>();
  const reversedSpeakers = new Set<string>();
  let replaced = 0;
  let text = source;

  for (const direction of directions) {
    const term = clean(direction.term, 40);
    const replacement = clean(direction.speakerName, 80);
    if (!term || !replacement) continue;

    const sameTermCanAddressPersona = directions.some(
      (candidate) =>
        key(candidate.term) === key(term) &&
        key(candidate.targetKey) === "persona" &&
        key(candidate.speakerKey) !== "persona"
    );

    text = sanitizeOutsideFences(text, (outside) => {
      let value = outside;

      // The assistant must not write dialogue/actions for the persona. When a
      // title whose only canonical speaker is the persona appears as a live
      // vocative, it is necessarily being spoken in the reverse direction.
      // This also works on a small held streaming chunk such as
      // "장인어른... ", where the speaker-attribution prose was emitted earlier.
      if (key(direction.speakerKey) === "persona" && !sameTermCanAddressPersona) {
        const vocative = new RegExp(
          `(^|[\\n\\r]|["“'‘]\\s*|[.!?。！？…]\\s+)(${escapeRegExp(term)})(?=\\s*(?:[,，.!?。！？…~～:：]|$))`,
          "gmu"
        );
        value = value.replace(vocative, (_match, prefix: string) => {
          replaced += 1;
          replacedTerms.add(term);
          reversedSpeakers.add(direction.targetName);
          return `${prefix}${replacement}`;
        });
      }

      // Catch explicit prose/label attribution for every pair, including
      // third-party relationships: "B는 A를 T라고 불렀다" and
      // `B | "T, ..."` are invalid when the canon is A → B → T.
      for (const targetName of nameVariants(direction.targetName)) {
        const target = escapeRegExp(targetName);
        const speakerVariants = nameVariants(direction.speakerName);
        const subjectPattern = new RegExp(`${target}(?:은|는|이|가|도)`, "gu");
        let subjectMatch: RegExpExecArray | null;
        while ((subjectMatch = subjectPattern.exec(value))) {
          const start = subjectMatch.index;
          const windowEnd = Math.min(value.length, start + 260);
          const window = value.slice(start, windowEnd);
          const attributedTerm = new RegExp(
            `${escapeRegExp(term)}(?=(?:\\s*(?:이?라(?:고)?|라고))?\\s*(?:부르|불렀|호칭|말하|외치))`,
            "u"
          ).exec(window);
          if (!attributedTerm) continue;
          const termAt = Number(attributedTerm.index || 0);
          const between = window.slice(subjectMatch[0].length, termAt);
          const canonicalSpeakerTakesSubject = speakerVariants.some((speakerName) =>
            new RegExp(`${escapeRegExp(speakerName)}(?:은|는|이|가|도)`, "u").test(between)
          );
          if (canonicalSpeakerTakesSubject) continue;
          const absoluteTermAt = start + termAt;
          value = `${value.slice(0, absoluteTermAt)}${replacement}${value.slice(absoluteTermAt + term.length)}`;
          replaced += 1;
          replacedTerms.add(term);
          reversedSpeakers.add(direction.targetName);
          subjectPattern.lastIndex = absoluteTermAt + replacement.length;
        }

        const labelledDialogue = new RegExp(
          `(${target}\\s*(?:[|:：-])\\s*["“]?[^\\n]{0,100}?)${escapeRegExp(term)}`,
          "gu"
        );
        value = value.replace(labelledDialogue, (_match, prefix: string) => {
          replaced += 1;
          replacedTerms.add(term);
          reversedSpeakers.add(direction.targetName);
          return `${prefix}${replacement}`;
        });
      }
      return value;
    });
  }

  return {
    text,
    replaced,
    terms: Array.from(replacedTerms),
    reversedSpeakers: Array.from(reversedSpeakers),
  };
}
