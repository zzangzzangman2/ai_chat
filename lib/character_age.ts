import { characterAliases, characterNamePattern, mentionsCharacterName } from "./character_mentions";

type AgeCandidate = {
  sourceRole: "user" | "assistant";
  value: string;
  turnNo: number;
  evidence?: string;
  confidence?: number;
};

export type CharacterAge = {
  name: string;
  age: number;
  aliases?: string[];
  sourceRole?: "user" | "assistant";
  sourceOrder?: number;
  turnNo?: number;
  evidence?: string;
};
export type AgeIdentity = { id?: string; name: string; aliases?: string[] | string | null; profile?: string; role?: string };

const ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
const ageWords = new Map<string, number>([["스무", 20]]);
for (let age = 1; age < 100; age += 1) {
  ageWords.set(`${TENS[Math.floor(age / 10)]}${ONES[age % 10]}`, age);
}
const AGE_TOKEN = `(?:\\d{1,3}|${[...ageWords.keys()].sort((a, b) => b.length - a.length).join("|")})`;
const AGE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${AGE_TOKEN})\\s*(살|세)(?![A-Za-z\\d]|대|상|력)`, "gu");
const BARE_AGE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${AGE_TOKEN})(?=(?:이|가)?\\s*(?:된|되었|되셨|되시|밖에))`, "gu");
// A remembered age, prediction, question, denial, or comparison is not a claim
// about someone's current age. Do not rewrite those into present-day canon.
const NON_CURRENT_BEFORE = /(?:작년|지난해|과거|옛날|당시|그때|내년|후년|미래|만약|가정|였을\s*때|이었을\s*때)/u;
const NON_CURRENT_AFTER = /^\s*(?:이던|였던|이었|였|때|적|부터|까지|차이|연상|연하|보다|에\s|정도|쯤|이나\s*(?:어리|많)|[이가]\s*(?:되면|된다면|되었을)|이?라면|이?라니|[은는이가]?\s*아니|이?라는\s*(?:거짓말|소문|말)|이?라고\s*(?:속|거짓|잘못)|입니까|인가|인지|이야\?|이니\?|\?)/u;

export function parseCharacterAge(value: unknown) {
  const text = String(value || "").trim();
  const match = text.match(new RegExp(`^(${AGE_TOKEN})\\s*(?:살|세)?$`, "u"));
  const age = match ? (ageWords.get(match[1]) || Number(match[1])) : 0;
  return Number.isInteger(age) && age > 0 && age <= 150 ? age : 0;
}

function ageMentions(text: string) {
  const explicit = [...text.matchAll(AGE_RE)].map((match) => ({
    index: match.index!, text: match[0], token: match[1], unit: match[2],
    age: parseCharacterAge(match[0]),
  })).filter((mention) => mention.age > 0);
  const bare = [...text.matchAll(BARE_AGE_RE)].filter((match) =>
    /(?:올해|나이|아직)[^.!?\n]{0,30}$/u.test(text.slice(Math.max(0, match.index! - 40), match.index))
  ).map((match) => ({ index: match.index!, text: match[0], token: match[1], unit: "", age: parseCharacterAge(match[1]) }));
  return [...explicit, ...bare].sort((a, b) => a.index - b.index);
}

/** Stable NPC ages may be established by a direct, evidenced introduction.
 * Keep the first such age; repeated later hallucinations cannot outvote it.
 * Other kinds of assistant facts retain their stricter corroboration policy.
 */
export function resolveCanonicalAgeCandidate<T extends AgeCandidate>(facts: T[]): T | null {
  const ordered = [...facts].sort((a, b) => a.turnNo - b.turnNo);
  const user = ordered.filter((fact) => fact.sourceRole === "user" && parseCharacterAge(fact.value));
  if (user.length) return user[user.length - 1];
  return ordered.find((fact) => {
    const age = parseCharacterAge(fact.value), evidence = String(fact.evidence || "");
    const mentions = ageMentions(evidence);
    if (!age || Number(fact.confidence || 0) < 90) return false;
    const current = mentions.filter((mention) => isCurrentClaim(
      evidence.slice(0, mention.index), evidence.slice(mention.index + mention.text.length)
    ));
    return current.length > 0 && current.every((mention) => mention.age === age);
  }) || null;
}

function namesOf(person: CharacterAge) {
  // Personal pronouns are not exclusive aliases: every character can say "소첩".
  const aliases = (person.aliases || []).filter((name) => !/^(?:소첩|소녀|소생|저|나|내|제|그녀|그|그는|그녀는)$/u.test(name));
  return [...new Set([person.name, ...aliases])].filter(Boolean);
}

function isCurrentClaim(before: string, after: string) {
  const clause = before.split(/[.!?。！？,，\n]/u).pop() || "";
  return !NON_CURRENT_BEFORE.test(clause) && !NON_CURRENT_AFTER.test(after) &&
    !/^\s*(?:이|가)?\s*(?:채\s*)?(?:안\s*되|되지\s*않|넘|넘지|넘었|되었을\s*터|되면|될|정도|쯤|든)/u.test(after) &&
    !/^\s*(?:정도|쯤|으로\s*(?:보|추정|짐작))/u.test(after) &&
    !/^[^.!。！\n]*[?？]/u.test(after);
}

const AGE_QUALIFIERS = "(?:(?:현재|올해로?|이제|원래|만|방년|막|꼭|아직|겨우|불과|모두|각각|나이(?:는|가|:)?|나이가)\\s*)*";
const NAME_TITLE = "(?:\\s*(?:소저|사매|사형|형님|언니|님|씨|양))?";
const SUBJECT_PARTICLE = "(?:께서는|께서|이는|이가|은|는|이|가|의|도)?";

function ageAttribution(people: CharacterAge[]) {
  const names = [...new Set(people.flatMap(namesOf))].sort((a, b) => b.length - a.length);
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  // Factor shared Unicode boundaries once. Repeating them for every alias in
  // a nested name-list regex made replay of a long conversation take seconds.
  const named = names.length ? characterNamePattern("__AGE_IDENTITY__").replace("__AGE_IDENTITY__", `(?:${alternatives})`) : "(?!)";
  const nameList = `${named}${NAME_TITLE}(?:\\s*(?:와|과|하고|및|랑|,|그리고)\\s*${named}${NAME_TITLE})*`;
  const subject = new RegExp(`(${nameList})${SUBJECT_PARTICLE}\\s*${AGE_QUALIFIERS}$`, "u");
  const leading = new RegExp(`^\\s*(?:이신|인|의|에\\s*불과한|먹은)?\\s*(?:막내\\s*)?(${nameList})`, "u");
  const introNames = names.length ? `(?<![\\p{L}\\p{N}_])(?:${alternatives})` : "(?!)";
  const introduction = new RegExp(`(?:제\\s*이름은\\s*|저는\\s*|나는\\s*)?(${introNames})(?:이옵니다|입니다|이며|이라(?:고)?\\s*(?:합니다|하오)|이고|고(?=[,，…\\s])|이오)[^"“”\\n]{0,110}$`, "u");
  const ownerList = (text: string) => people.filter((person) => namesOf(person).some((name) => mentionsCharacterName(text, name)));
  const subjects = people.map((person) => ({ person, patterns: namesOf(person).map((name) =>
    new RegExp(`${characterNamePattern(name)}${NAME_TITLE}(?:께서는|께서|이는|이가|은|는|이|가|도|\\s+역시|\\s+또한)(?!의|랑)`, "gu")) }));
  const groupedSubjects = new RegExp(`(${nameList})(?:은|는|이가|이|가|도|\\s+역시|\\s+또한)`, "gu");
  const speaker = (narration: string, previous: CharacterAge | null) => {
    const clean = narration.replace(/["“][^"”]*["”]/gu, " ");
    const candidates = subjects.filter(({ person }) => namesOf(person).some((name) => clean.includes(name))).flatMap(({ person, patterns }) => patterns.flatMap((pattern) =>
      [...clean.matchAll(pattern)].map((match) => ({ person, index: match.index! })))).sort((a, b) => b.index - a.index);
    if (candidates.length) {
      if (candidates[1]?.index === candidates[0].index) return null;
      const selected = candidates[0], tail = clean.slice(selected.index);
      if ([...clean.matchAll(groupedSubjects)].some((match) =>
        selected.index >= match.index! && selected.index < match.index! + match[0].length && ownerList(match[1]).length > 1
      )) return null;
      const others = ownerList(tail).filter((person) => person.name !== selected.person.name);
      const speech = /(?:말(?:했다|한다|을\s*이|을\s*꺼)|대답|소개|목소리|외치|외쳤|중얼|입(?:을|매를)?\s*열)/u.test(tail);
      // A background group reacting to somebody else's speech is not its owner.
      if (others.length && !speech) return null;
      return speech || (!others.length && /(?:고개|얼굴|눈길|눈을)/u.test(tail)) ? selected.person : null;
    }
    return /^\s*\*?\s*(?:그녀|그는|그가|그의)/u.test(clean) ? previous : null;
  };
  return { subject, leading, introduction, ownerList, speaker };
}

export type CharacterAgeClaim = ReturnType<typeof ageMentions>[number] & {
  names: string[];
  evidence: string;
  groupStart?: number;
  groupEnd?: number;
  leadingGroup?: boolean;
};

/** Interpret grammatical subjects and local speakers, never every name in a
 * message. Shared ages and later comparisons are separate claims. */
export function extractCharacterAgeClaims(text: string, people: CharacterAge[], contextText = "", attribution?: ReturnType<typeof ageAttribution>) {
  if (!ageMentions(text).length) return [] as CharacterAgeClaim[];
  const matcher = attribution || ageAttribution(people);
  const claims: CharacterAgeClaim[] = [];
  let active: CharacterAge | null = null;
  let inFence = false;
  const process = (source: string, emit: boolean) => {
    let offset = 0;
    for (const part of source.split(/(\r?\n)/u)) {
      const start = offset; offset += part.length;
      if (!part.trim()) continue;
      if (part.includes("```")) { inFence = !inFence; active = null; continue; }
      if (inFence) continue;
      const dialogue = /^\s*["“]/u.test(part);
      if (!dialogue) active = matcher.speaker(part, active);
      if (!emit) continue;
      for (const mention of ageMentions(part)) {
        const before = part.slice(0, mention.index), after = part.slice(mention.index + mention.text.length);
        if (!isCurrentClaim(before, after)) continue;
        const subject = before.match(matcher.subject);
        const leading = !subject ? after.match(matcher.leading) : null;
        const introduction = !subject && !leading ? before.match(matcher.introduction) : null;
        let owners = subject ? matcher.ownerList(subject[1]) : leading ? matcher.ownerList(leading[1]) : introduction ? matcher.ownerList(introduction[1]) : [];
        if (!owners.length && dialogue && active && /(?<![\p{L}\p{N}])(?:소첩|소녀|소생|저는|제\s*나이|나는|내\s*나이|나이는)[^.!?"“”]{0,45}$/u.test(before)) owners = [active];
        if (!owners.length) continue;
        const groupStart = subject ? start + subject.index! : undefined;
        const groupEnd = leading ? start + mention.index + mention.text.length + leading[0].length : undefined;
        claims.push({ ...mention, index: start + mention.index, names: owners.map((person) => person.name),
          evidence: part.trim().slice(0, 800), groupStart, groupEnd, leadingGroup: Boolean(leading) });
      }
    }
  };
  process(contextText, false);
  process(text, true);
  return claims;
}

/** Replay original age declarations in order, including those extraction missed.
 * A later AI age cannot replace an earlier one. User corrections and actual
 * elapsed story time can change it. Stored observations are a source-anchored
 * fallback when grammar alone cannot attribute the original statement.
 */
export function buildCharacterAgeCanon(params: {
  facts: Array<AgeCandidate & { factKey: string; subjectName: string }>;
  characters?: AgeIdentity[];
  messages?: Array<{ role?: unknown; content?: unknown }>;
}) {
  const messages = params.messages || [];
  const people = new Map<string, CharacterAge>();
  for (const person of params.characters || []) people.set(person.name, {
    name: person.name, aliases: characterAliases(person.aliases), age: 0,
  });
  const facts = params.facts.filter((fact) => fact.factKey === "age" && parseCharacterAge(fact.value));
  for (const fact of facts) if (!people.has(fact.subjectName)) people.set(fact.subjectName, { name: fact.subjectName, age: 0 });
  const identities = [...people.values()];
  const attribution = ageAttribution(identities);
  const normalized = messages.map((message) => String(message.content || "").replace(/\s+/gu, " "));
  const anchors = facts.map((fact) => {
    const evidence = String(fact.evidence || "").replace(/\s+/gu, " ").trim();
    return { fact, index: evidence ? normalized.findIndex((text, index) =>
      String(messages[index].role).replace(/^model$/, "assistant") === fact.sourceRole && text.includes(evidence)) : -1 };
  });
  let offset = 0, turnNo = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = String(message.role || "").replace(/^model$/, "assistant");
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant") turnNo += 1;
    const text = String(message.content || "");
    if (role === "user" && !/[?？]|(?:만약|내년|가정)/u.test(text)) {
      // Plans ("5년 뒤에 찾아갈게") are not elapsed story time.
      const jump = text.match(/^\s*[*([\s]*(?:(그로부터|그날로부터|그때로부터|다시|또)\s*)?(\d{1,3}|한|일|두|이|세|삼)\s*(?:년|해)\s*(?:(?:이\s*)?(?:지났|흘렀|경과)|(?:후|뒤)(?=$|[\s.,\])*]))/u);
      if (jump) {
        const years = ({ 한: 1, 일: 1, 두: 2, 이: 2, 세: 3, 삼: 3 } as Record<string, number>)[jump[2]] || Number(jump[2]);
        const additive = Boolean(jump[1]) || /(?:지났|흘렀|경과)/u.test(jump[0]);
        const delta = additive ? years : Math.max(0, years - offset);
        offset = additive ? offset + years : Math.max(offset, years);
        for (const person of identities) if (person.age) person.age = Math.min(150, person.age + delta);
      }
    }
    const claimText = role === "user" ? text.replace(/"[^"\n]*"|“[^”\n]*”|```[\s\S]*?```/gu, " ") : text;
    for (const claim of extractCharacterAgeClaims(claimText, identities, "", attribution)) {
      for (const name of claim.names) {
        const person = people.get(name)!;
        // The first attributed original beats a later extracted AI mistake.
        if (person.age && role !== "user") continue;
        Object.assign(person, { age: claim.age, sourceRole: role, sourceOrder: index, turnNo, evidence: claim.evidence });
      }
    }
    for (const { fact } of anchors.filter((anchor) => anchor.index === index)) {
      const person = people.get(fact.subjectName)!;
      if (person.age && fact.sourceRole !== "user") continue;
      Object.assign(person, { age: parseCharacterAge(fact.value), sourceRole: fact.sourceRole,
        sourceOrder: index, turnNo: fact.turnNo, evidence: fact.evidence });
    }
  }
  for (const { fact } of anchors.filter((anchor) => anchor.index < 0)) {
    const person = people.get(fact.subjectName)!;
    if (person.age) continue;
    Object.assign(person, { age: parseCharacterAge(fact.value), sourceRole: fact.sourceRole,
      sourceOrder: -1, turnNo: fact.turnNo, evidence: fact.evidence });
  }
  return identities.filter((person) => person.age > 0);
}

export function enforceCharacterAges(params: {
  text: unknown;
  ages: CharacterAge[];
  characters?: AgeIdentity[];
  contextText?: unknown;
}) {
  const source = String(params.text || "");
  const people: CharacterAge[] = (params.characters || params.ages).map((person) => ({
    ...person, aliases: characterAliases(person.aliases),
    age: params.ages.find((known) => known.name === person.name)?.age || 0,
  }));
  for (const age of params.ages) if (!people.some((person) => person.name === age.name)) people.push(age);
  const edits: Array<{ start: number; end: number; value: string; names: string[] }> = [];
  for (const claim of extractCharacterAgeClaims(source, people, String(params.contextText || ""))) {
    const owners = claim.names.map((name) => people.find((person) => person.name === name)!);
    if (owners.some((owner) => !owner.age) || owners.every((owner) => owner.age === claim.age)) continue;
    const render = (age: number) => {
      const native = ageWords.has(claim.token) && age < 100;
      const token = native ? (age === 20 ? (claim.unit ? "스무" : "스물") : `${TENS[Math.floor(age / 10)]}${ONES[age % 10]}`) : String(age);
      return `${token}${native && claim.unit ? " " : ""}${claim.unit}`;
    };
    let start = claim.index, end = start + claim.text.length, value = render(owners[0].age);
    if (new Set(owners.map((owner) => owner.age)).size > 1) {
      if (claim.groupStart !== undefined) {
        start = claim.groupStart;
        value = owners.map((owner) => `${owner.name}${/[가-힣]/u.test(owner.name.at(-1) || "") && (owner.name.charCodeAt(owner.name.length - 1) - 0xac00) % 28 ? "은" : "는"} ${render(owner.age)}`).join(", ");
      } else if (claim.leadingGroup && claim.groupEnd !== undefined) {
        end = claim.groupEnd;
        value = owners.map((owner) => `${render(owner.age)}인 ${owner.name}`).join(", ");
      } else continue;
    }
    edits.push({ start, end, value, names: owners.filter((owner) => owner.age !== claim.age).map((owner) => owner.name) });
  }
  let text = source;
  for (const edit of edits.slice().reverse()) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return { text, rewritten: edits.length, names: [...new Set(edits.flatMap((edit) => edit.names))] };
}
