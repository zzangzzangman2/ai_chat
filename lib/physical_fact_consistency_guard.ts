export type PhysicalFactIdentity = {
  name: string;
  aliases?: string[];
  isPersona?: boolean;
  gender?: string;
  heightCm?: number | null;
  weightKg?: number | null;
  buildClass?: "large" | "small" | null;
};

export type PhysicalFactGuardResult = {
  text: string;
  qualified: number;
  removed: number;
  owners: string[];
};

type PhysicalFactInput = {
  persona: {
    name?: unknown;
    gender?: unknown;
    heightCm?: number | null;
    weightKg?: number | null;
  };
  facts?: Array<{
    subjectKey?: unknown;
    subjectName?: unknown;
    factKey?: unknown;
    value?: unknown;
    sourceRole?: unknown;
  }>;
  characters?: Array<{
    name?: unknown;
    aliases?: unknown;
  }>;
};

const HEIGHT_RE = /(\d{2,3}(?:\.\d+)?)\s*(?:cm|㎝|센티미터|센티)(?![A-Za-z])/giu;
const WEIGHT_RE = /(\d{2,3}(?:\.\d+)?)\s*(?:kg|㎏|킬로그램|킬로)(?![A-Za-z])/giu;
const LARGE_BUILD_RE =
  /(?:거구(?:의\s*(?:남자|여자|사람|인물))?|(?:육중|우람|비대)한\s*(?:몸집|체구|몸|체격)|비대해진\s*(?:몸집|체구|몸|체격)|거대한\s*(?:몸집|체구|몸|체격|살덩어리))/giu;
const SMALL_BUILD_RE =
  /(?:(?:왜소한?|가냘픈|가녀린|호리호리한|마른|깡마른)\s*(?:몸집|체구|몸|체격))/giu;
const DENIAL_OR_CORRECTION_RE =
  /(?:아니(?:다|고|며|었|라)|아닌|않(?:다|은|고)|잘못|오류|오염|착각|혼동|지어내|정정|금지|적용하지)/u;

function cleanText(value: unknown, max = 120) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function normalizedKey(value: unknown) {
  return cleanText(value).toLocaleLowerCase("ko-KR");
}

function parseAliases(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean);
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => cleanText(item)).filter(Boolean);
  } catch {
    // Plain comma/newline-separated aliases are the normal legacy format.
  }
  return raw
    .split(/[\n,;\/|]+/u)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function extractMeasurement(value: unknown, kind: "height" | "weight") {
  const source = String(value ?? "");
  const match = source.match(
    kind === "height"
      ? /(\d{2,3}(?:\.\d+)?)\s*(?:cm|㎝|센티미터|센티)(?![A-Za-z])/iu
      : /(\d{2,3}(?:\.\d+)?)\s*(?:kg|㎏|킬로그램|킬로)(?![A-Za-z])/iu
  );
  if (!match) return null;
  const result = Number(match[1]);
  return Number.isFinite(result) ? result : null;
}

function identityNames(identity: PhysicalFactIdentity) {
  return [...new Set([identity.name, ...(identity.aliases || [])])]
    .map((value) => cleanText(value))
    .filter((value) => value.length >= 2);
}

function sentenceMentionsIdentity(sentence: string, identity: PhysicalFactIdentity) {
  return identityNames(identity).some((name) => sentence.includes(name));
}

function normalizeGender(value: unknown) {
  const gender = normalizedKey(value);
  if (/^(?:남|남성|남자)$/u.test(gender)) return "male";
  if (/^(?:여|여성|여자)$/u.test(gender)) return "female";
  return "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasForeignDirectAttribution(
  sentence: string,
  matchStart: number,
  owner: PhysicalFactIdentity,
  identities: PhysicalFactIdentity[]
) {
  const before = sentence.slice(Math.max(0, matchStart - 80), matchStart);
  const ownerGender = normalizeGender(owner.gender);
  if (ownerGender === "male" && /(?:그녀|그\s*여자|소녀)(?:의|는|가|에게|한테)/u.test(before)) {
    return true;
  }
  if (ownerGender === "female" && /(?:그\s*남자|소년)(?:의|는|가|에게|한테)/u.test(before)) {
    return true;
  }

  return identities.some((identity) => {
    if (normalizedKey(identity.name) === normalizedKey(owner.name)) return false;
    return identityNames(identity).some((name) => {
      const namedPhysicalSubject = new RegExp(
        `(?:${escapeRegExp(name)}\\s*(?:의|은|는|이|가)\\s*|${escapeRegExp(name)}\\s*의\\s*(?:키|신장|몸무게|체중|체구|몸집|몸|체격|거구)?[^.!?。！？\\n]{0,28}|${escapeRegExp(name)}\\s*(?:은|는|이|가)\\s*(?:키|신장|몸무게|체중|체구|몸집|몸|체격|거구|육중|비대|왜소|마른)[^.!?。！？\\n]{0,24})$`,
        "u"
      );
      return namedPhysicalSubject.test(before);
    });
  });
}

function splitLineSentences(line: string) {
  const marked = String(line || "").replace(
    /([.!?。！？](?:["”']|\*+)?)(\s+)/gu,
    "$1\u0000$2"
  );
  return marked.split("\u0000").filter(Boolean);
}

function measurementKey(kind: "height" | "weight", value: number) {
  return `${kind}:${Math.round(value * 100) / 100}`;
}

/**
 * Builds the only physical facts that are safe enough for deterministic
 * ownership checks. Persona settings and user-authored character facts are
 * trusted; repeated assistant prose is deliberately excluded so a hallucinated
 * body description cannot authenticate itself after several turns.
 */
export function buildPhysicalFactIdentities(input: PhysicalFactInput) {
  const characters = input.characters || [];
  const aliasByName = new Map<string, string[]>();
  for (const character of characters) {
    const name = cleanText(character?.name);
    if (!name) continue;
    aliasByName.set(normalizedKey(name), parseAliases(character?.aliases));
  }

  const byKey = new Map<string, PhysicalFactIdentity>();
  const ensure = (nameValue: unknown, subjectKeyValue?: unknown) => {
    const name = cleanText(nameValue);
    if (!name) return null;
    const subjectKey = cleanText(subjectKeyValue);
    const key = subjectKey === "persona" ? "persona" : normalizedKey(name);
    const existing = byKey.get(key);
    if (existing) return existing;
    const identity: PhysicalFactIdentity = {
      name,
      aliases: aliasByName.get(normalizedKey(name)) || [],
      isPersona: key === "persona",
      heightCm: null,
      weightKg: null,
      buildClass: null,
    };
    byKey.set(key, identity);
    return identity;
  };

  const persona = ensure(input.persona?.name, "persona");
  if (persona) {
    persona.isPersona = true;
    persona.gender = cleanText(input.persona?.gender, 40);
    persona.heightCm = input.persona?.heightCm !== null &&
      input.persona?.heightCm !== undefined &&
      Number.isFinite(Number(input.persona?.heightCm))
      ? Number(input.persona?.heightCm)
      : null;
    persona.weightKg = input.persona?.weightKg !== null &&
      input.persona?.weightKg !== undefined &&
      Number.isFinite(Number(input.persona?.weightKg))
      ? Number(input.persona?.weightKg)
      : null;
    if (persona.weightKg !== null && persona.weightKg >= 100) {
      persona.buildClass = "large";
    } else if (persona.weightKg !== null && persona.weightKg <= 45) {
      persona.buildClass = "small";
    }
  }

  for (const fact of input.facts || []) {
    const factKey = cleanText(fact?.factKey, 40);
    const isPersona = cleanText(fact?.subjectKey) === "persona";
    // An AI-only physical observation is not a stable identity source. This is
    // the critical break in the self-reinforcing contamination loop.
    if (fact?.sourceRole !== "user") continue;
    const identity = ensure(fact?.subjectName, fact?.subjectKey);
    if (!identity) continue;
    if (factKey === "gender" && (!isPersona || !identity.gender)) {
      identity.gender = cleanText(fact?.value, 40);
    }
    if (factKey === "height") {
      const value = extractMeasurement(fact?.value, "height");
      if (value !== null && (!isPersona || identity.heightCm === null)) {
        identity.heightCm = value;
      }
    }
    if (factKey === "weight") {
      const value = extractMeasurement(fact?.value, "weight");
      if (value !== null && (!isPersona || identity.weightKg === null)) {
        identity.weightKg = value;
        if (value >= 100 && (!isPersona || identity.buildClass === null)) {
          identity.buildClass = "large";
        }
      }
    }
    if (factKey === "body_build" || factKey === "appearance") {
      const value = String(fact?.value || "");
      if (
        (!isPersona || identity.buildClass === null) &&
        new RegExp(LARGE_BUILD_RE.source, "iu").test(value)
      ) {
        identity.buildClass = "large";
      }
      if (
        (!isPersona || identity.buildClass === null) &&
        new RegExp(SMALL_BUILD_RE.source, "iu").test(value)
      ) {
        identity.buildClass = "small";
      }
    }
  }

  return [...byKey.values()].filter(
    (identity) =>
      identity.heightCm !== null ||
      identity.weightKg !== null ||
      identity.buildClass !== null
  );
}

/**
 * Makes an exact height/weight value self-identifying before assistant prose is
 * reused as prompt memory, and rejects a direct assignment to a different
 * character in generated output. An unnamed "150kg" can therefore no longer
 * drift from its canonical owner to whichever NPC currently has scene focus.
 */
export function enforcePhysicalFactOwnership(input: {
  text: unknown;
  identities: PhysicalFactIdentity[];
}): PhysicalFactGuardResult {
  const source = String(input.text || "");
  if (!source.trim()) return { text: source, qualified: 0, removed: 0, owners: [] };

  const identities = (input.identities || []).filter((identity) =>
    cleanText(identity?.name)
  );
  const ownersByMeasurement = new Map<string, PhysicalFactIdentity[]>();
  for (const identity of identities) {
    for (const [kind, value] of [
      ["height", identity.heightCm],
      ["weight", identity.weightKg],
    ] as const) {
      if (value === null || !Number.isFinite(Number(value))) continue;
      const key = measurementKey(kind, Number(value));
      ownersByMeasurement.set(key, [...(ownersByMeasurement.get(key) || []), identity]);
    }
  }

  let qualified = 0;
  let removed = 0;
  const owners = new Set<string>();
  const lines = source.split(/(?<=\n)/u).map((line) => {
    if (!line.trim()) return line;
    return splitLineSentences(line)
      .map((sentence) => {
        if (DENIAL_OR_CORRECTION_RE.test(sentence)) return sentence;
        let shouldRemove = false;
        const qualify = (kind: "height" | "weight", pattern: RegExp) =>
          sentence.replace(pattern, (matched, numeric, offset) => {
            const value = Number(numeric);
            const candidates = ownersByMeasurement.get(measurementKey(kind, value)) || [];
            if (candidates.length !== 1) return matched;
            const owner = candidates[0];
            if (sentenceMentionsIdentity(sentence, owner)) return matched;
            if (hasForeignDirectAttribution(sentence, Number(offset), owner, identities)) {
              shouldRemove = true;
              owners.add(owner.name);
              return matched;
            }
            qualified += 1;
            owners.add(owner.name);
            return `${owner.name}의 ${matched}`;
          });

        let next = qualify("height", HEIGHT_RE);
        if (!shouldRemove) next = next.replace(WEIGHT_RE, (matched, numeric, offset) => {
          const value = Number(numeric);
          const candidates = ownersByMeasurement.get(measurementKey("weight", value)) || [];
          if (candidates.length !== 1) return matched;
          const owner = candidates[0];
          if (sentenceMentionsIdentity(sentence, owner)) return matched;
          if (hasForeignDirectAttribution(sentence, Number(offset), owner, identities)) {
            shouldRemove = true;
            owners.add(owner.name);
            return matched;
          }
          qualified += 1;
          owners.add(owner.name);
          return `${owner.name}의 ${matched}`;
        });
        if (!shouldRemove) {
          const qualifyBuild = (
            buildClass: "large" | "small",
            pattern: RegExp
          ) => {
            const candidates = identities.filter(
              (identity) => identity.buildClass === buildClass
            );
            if (candidates.length !== 1) return next;
            const owner = candidates[0];
            const descriptorSource = next;
            return next.replace(pattern, (matched, offset) => {
              if (sentenceMentionsIdentity(descriptorSource, owner)) return matched;
              if (
                hasForeignDirectAttribution(
                  descriptorSource,
                  Number(offset),
                  owner,
                  identities
                )
              ) {
                shouldRemove = true;
                owners.add(owner.name);
                return matched;
              }
              // A qualitative adjective is not a unique identifier. Unlike an
              // exact 150kg/150cm value, "육중한" may describe another actor,
              // a door, footsteps, or a temporary pose. Never inject the
              // canonical owner's name into otherwise unnamed prose.
              return matched;
            });
          };
          next = qualifyBuild("large", LARGE_BUILD_RE);
          if (!shouldRemove) next = qualifyBuild("small", SMALL_BUILD_RE);
        }
        if (!shouldRemove) return next;
        removed += 1;
        return "";
      })
      .join("");
  });

  if (!qualified && !removed) {
    return { text: source, qualified: 0, removed: 0, owners: [] };
  }
  return {
    text: lines.join("").replace(/\n{3,}/gu, "\n\n"),
    qualified,
    removed,
    owners: [...owners],
  };
}

export function formatPhysicalFactOwnershipBlock(identities: PhysicalFactIdentity[]) {
  const rows = (identities || [])
    .map((identity) => {
      const facts = [
        identity.heightCm !== null && Number.isFinite(Number(identity.heightCm))
          ? `키 ${identity.heightCm}cm`
          : "",
        identity.weightKg !== null && Number.isFinite(Number(identity.weightKg))
          ? `체중 ${identity.weightKg}kg`
          : "",
        identity.buildClass === "large"
          ? "체형 대형"
          : identity.buildClass === "small"
            ? "체형 소형"
            : "",
      ].filter(Boolean);
      return facts.length ? `- ${identity.name}: ${facts.join(", ")}` : "";
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return [
    "# [신체 사실 소유권 HARD GUARD — 전체 채팅 공통]",
    "- 키·체중·체형·외모는 아래에 적힌 정확한 인물에게만 속한다. 사건 기억의 memory_owner/character_id는 그 기억을 보관하는 인물일 뿐, 사건 문장 속 모든 신체 묘사의 주인이 아니다.",
    "- 다른 인물과 함께 나온 사건·대사·직전 AI 지문에서 수치나 체형을 발견해도 현재 화자·현재 NPC에게 복사하지 않는다. 이름 없는 정확한 키·체중 수치는 반드시 아래 정본 소유자의 이름을 밝혀 쓴다.",
    "- '육중한/거구/가녀린/마른' 같은 정성적 형용사만 보고 아래 정본 인물의 이름을 문장에 새로 끼워 넣지 않는다. 그 표현은 문·발소리 같은 사물이나 현재의 다른 행동 주체를 꾸밀 수 있다.",
    "- 아래에 없는 NPC의 키·체중·체형은 미정이다. 장면 초점, 성별, 나이, 관계, 주변 인물의 체격을 근거로 새 수치나 '거구/육중/비대/왜소/마름'을 추정하지 않는다.",
    "- 이전 AI 출력·요약이 아래 수치를 다른 인물에게 붙였다면 오염된 서술이므로 반복하지 않는다.",
    ...rows,
  ].join("\n");
}
