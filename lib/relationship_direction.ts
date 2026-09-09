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

function isNameAddress(term: string, names: string[]) {
  const value = key(term).replace(/\s+/gu, "");
  return names.some((name) =>
    nameVariants(name).some((variant) =>
      ["", "아", "야", "씨", "님", "군", "양"].some(
        (suffix) => value === key(variant + suffix).replace(/\s+/gu, "")
      )
    )
  );
}

function namePattern(name: string, knownNames: string[]) {
  const variants = nameVariants(name).filter((variant) =>
    !knownNames.some((other) =>
      key(other) !== key(name) && nameVariants(other).some((alias) => key(alias) === key(variant))
    )
  );
  // A shared short name (two different people named 도훈) is not an identity.
  // An empty pattern must never match a standalone Korean subject particle.
  if (!variants.length) return null;
  // A short name may follow punctuation/whitespace, not another name's prefix.
  return `(?<![\\p{L}\\p{N}_])(?:${variants.map(escapeRegExp).join("|")})`;
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
    "- 각 기록은 해당 두 인물 사이의 방향만 뜻한다. 다른 인물도 같은 이름·호칭을 사용할 수 있으며, 모든 대사의 수신자가 주인공인 것은 아니다.",
    "- 이름·이름+아/야/씨/님은 불리는 사람을 가리킨다. 다른 인물이 사용했다는 이유로 주인공이나 발화자의 이름으로 치환하지 않는다.",
    ...directions.map(
      (direction) =>
        `- ${direction.speakerName} → ${direction.targetName}: “${direction.term}” (${isNameAddress(direction.term, [direction.targetName]) ? "이름 호명; 다른 인물도 같은 대상을 부를 수 있음" : "이 두 인물 사이의 역방향 사용 금지"})`
    ),
  ].join("\n");
}

/**
 * Deterministic output backstop for directed titles.
 *
 * Prompt instructions and structured-memory conflict checks keep the canon
 * clean, but a provider can still emit a reversed title in the live prose.
 * Correct only locally explicit speaker AND listener pairs. A bare vocative,
 * a speaker-only label, or attribution lost across streaming chunks is not
 * proof of a reversed direction. In particular, a persona-owned address row
 * does not reserve that name/title exclusively for the persona's use.
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
  const knownNames = directions.flatMap((direction) => [direction.speakerName, direction.targetName]);

  for (const direction of directions) {
    const term = clean(direction.term, 40);
    const replacement = clean(direction.speakerName, 80);
    if (!term || !replacement || isNameAddress(term, knownNames)) continue;

    // In a proven reversal, the canonical target speaks to the canonical
    // speaker. Require both names in one local attribution, never a 260-char
    // proximity window that can include another character's separate action.
    const reversedSpeaker = namePattern(direction.targetName, knownNames);
    const reversedListener = namePattern(direction.speakerName, knownNames);
    if (!reversedSpeaker || !reversedListener) continue;
    const recordReplacement = () => {
      replaced += 1;
      replacedTerms.add(term);
      reversedSpeakers.add(direction.targetName);
      return replacement;
    };

    text = sanitizeOutsideFences(text, (outside) => {
      let value = outside;
      const explicitProse = new RegExp(
        `(${reversedSpeaker}(?:은|는|이|가|도)\\s+${reversedListener}(?:을|를)\\s+)${escapeRegExp(term)}(?=\\s*(?:이?라고|이라)\\s*(?:부르|불렀|호칭))`,
        "gu"
      );
      value = value.replace(explicitProse, (_match, prefix: string) => `${prefix}${recordReplacement()}`);

      const attributedDialogue = new RegExp(
        `(${reversedSpeaker}(?:은|는|이|가|도)\\s+${reversedListener}(?:에게|한테|께)\\s+(?:말했다|물었다|대답했다|외쳤다|소리쳤다|속삭였다)[.!?。！？]?\\*?\\s*)("[^"\\r\\n]*"|“[^”\\r\\n]*”)`,
        "gu"
      );
      value = value.replace(attributedDialogue, (_match, attribution: string, dialogue: string) => {
        const vocative = new RegExp(
          `(^["“]\\s*|[.!?。！？…]\\s+)${escapeRegExp(term)}(?=\\s*[,，.!?。！？…~～:：])`,
          "gu"
        );
        return attribution + dialogue.replace(vocative, (_term, prefix: string) => `${prefix}${recordReplacement()}`);
      });
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
