/** Pure reconstruction from retained conversation messages; no database or model calls.
 * Rebuilding after undo naturally removes events whose source messages were deleted.
 */
export type DurableCharacterIdentity = { name: string; aliases?: string | string[] };
export type DurableStateMessage = {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  turnNo?: unknown;
};
export type DurableStateEvidence = {
  sourceRole: "user" | "assistant";
  sourceMessageId: string;
  turnNo: number;
  evidence: string;
};
export type DurableLifeState = DurableStateEvidence & {
  name: string;
  kind: "deceased" | "alive";
};
export type DurableRelationshipState = DurableStateEvidence & {
  subjectName: string;
  objectName: string;
  kind: "hostile" | "reconciled";
};
export type DurableCharacterCanon = {
  lifeStates: DurableLifeState[];
  relationships: DurableRelationshipState[];
};

function clean(value: unknown, max = 800) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}
function key(value: string) { return value.normalize("NFKC").toLocaleLowerCase("ko-KR"); }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function aliases(value: DurableCharacterIdentity["aliases"]) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 80));
  const text = String(value || "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => clean(item, 80));
    } catch { /* Legacy alias strings are separated below. */ }
  }
  return text.split(/[,;|\n]/u).map((item) => clean(item, 80));
}

type Mention = { name: string; start: number; end: number };
function identityMatcher(identities: DurableCharacterIdentity[]) {
  const owners = new Map<string, Set<string>>();
  const canonical = new Map<string, string>();
  const spelling = new Map<string, string>();
  for (const row of identities) {
    const name = clean(row.name, 80);
    if (!name) continue;
    canonical.set(key(name), name);
    for (const variant of [name, ...aliases(row.aliases)]) {
      if (variant.length < 2) continue;
      const normalized = key(variant);
      const names = owners.get(normalized) || new Set<string>();
      names.add(name);
      owners.set(normalized, names);
      spelling.set(normalized, variant);
    }
  }
  const resolved = new Map<string, string>();
  for (const [variant, names] of owners) {
    // A shared alias must never transfer one person's death or grudge to another.
    if (canonical.has(variant)) resolved.set(variant, canonical.get(variant)!);
    else if (names.size === 1) resolved.set(variant, [...names][0]);
  }
  const variants = [...resolved.keys()].map((item) => spelling.get(item)!)
    .sort((a, b) => b.length - a.length);
  const pattern = variants.length ? new RegExp(
    `(?<![가-힣A-Za-z0-9_])(?:${variants.map(escapeRegex).join("|")})(?=$|(?:에게|한테|께서|으로|이라고|라는|이라|의|은|는|이|가|을|를|와|과|도|만|야|아|님|씨|군|양)|[^가-힣A-Za-z0-9_])`, "giu"
  ) : null;
  return (text: string): Mention[] => {
    if (!pattern) return [];
    pattern.lastIndex = 0;
    return [...text.matchAll(pattern)].map((match) => ({
      name: resolved.get(key(match[0]))!, start: match.index!, end: match.index! + match[0].length,
    }));
  };
}

const NON_CURRENT_CONTEXT = /(?:꿈(?:속|에서|을\s*꾸|이었다)|악몽|환영|환상|유령|망령|혼령|영혼|회상|추억|기억\s*속|생전|죽기\s*전|사망하기\s*전|과거\s*장면|옛\s*장면|사진\s*속|영상\s*속|녹화\s*영상|연극|배역)/u;
const UNCERTAIN_CONTEXT = /(?:만약|가정(?:하면|하|한)|상상(?:하면|하|한)|가능성|죽을지도|사망할지도|죽었다면|사망했다면|죽었으면|사망했으면|부활한다면|화해한다면|친구가\s*된다면|(?:죽|사망|부활|화해)[^.!?\n]{0,25}(?:까\??|겠|수\s*있|지도\s*모|수도|거라|거야)|(?:소문|오보|추정|착각|거짓말|거짓\s*주장)|(?:줄\s*알았|줄로\s*알았)|(?:죽|사망|부활|화해)[^.!?\n]{0,20}(?:계획|위협|협박|가정))/u;
const REPORTED_EVENT = /(?:죽었다|사망했다|숨졌다|부활했다|화해했다)(?:고|는)\s*(?:말|주장|듣|들었|믿|생각|소식|보도|보고|소문|전해)/u;
const DEAD_EVENT = /(?:사망(?:했|하였|함|됐|되었)|사살(?:됐|되었|당했|됨)|살해(?:당했|당하였다|됐|되었)|죽었|숨졌|숨을\s*거두(?:었|었다)|목숨을\s*잃(?:었|었다)|시신으로\s*발견(?:됐|되었)|사체로\s*발견(?:됐|되었)|순직(?:했|함)|서거(?:했|함))/u;
const ALIVE_EVENT = /(?:부활(?:했|하였|한다|하다|하여|시킨|시켰|시켜)|되살아(?:났|난|나|왔다)|되살(?:렸|린다|리다|려)|살아\s*(?:있(?:다|어|음|는\s*것)|돌아(?:왔|온|와))|살아서\s*돌아(?:왔|온|와)|생존(?:했|해\s*있|이\s*확인))/u;
const HOSTILE_EVENT = /(?:원수|적대\s*관계|적대하|증오하|증오했|미워하|미워했|불신하|불신했|절교(?:했|한다|했다)|배신(?:했|했다|당했|당했다)|(?:사이|관계)(?:가|는)?\s*(?:매우\s*|아주\s*|몹시\s*)?(?:나쁘|나빠|틀어졌|악화됐)|신뢰를\s*잃었)/u;
const RECONCILED_EVENT = /(?:화해(?:했|한다|했다|하였|하기로\s*했)|용서(?:했|한다|했다|하였)|오해를\s*풀(?:었|었다)|관계를\s*회복(?:했|한다|했다)|(?:친구|동료|동맹)(?:가|이)\s*되(?:었|었다)|친구로\s*지내기로\s*했)/u;
const NEGATED_RELATION = /(?:원수|적대\s*관계|증오|미워|불신|절교|배신|화해|용서|친구)[^.!?\n]{0,16}(?:않|아니|못했|못하|없었다|없다|취소)/u;
const NEGATED_HOSTILITY = /(?:원수|적대\s*관계)(?:가|이|는|은)?\s*(?:아니|없)|(?:증오|미워|불신|절교|배신)(?:하(?:지|지는|기는)|한\s*(?:적이|것이))?\s*(?:않|못|없|아니)/u;
const NEGATED_RECONCILIATION = /(?:화해|용서|관계\s*회복)(?:하(?:지|지는|기는)|한\s*(?:적이|것이))?\s*(?:않|못|없|아니)|친구(?:가|는|이)?\s*(?:아니|되(?:지|지는)\s*않)/u;

function withoutQuotes(text: string) {
  return text.replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|‘[^’\n]*(?:’|$)|'[^'\n]*(?:'|$)/gu, " ");
}
function sentences(text: string) {
  // Only stored evidence is shortened. Event detection must see the whole source,
  // including an important event at the end of a long single-paragraph turn.
  return text.split(/(?<=[.!?。！？])\s+|[\r\n]+/u).map((item) => item.replace(/\s+/gu, " ").trim()).filter(Boolean);
}
function factualNarration(text: string) {
  return !/[?？]/u.test(text) && !/(?:있니|있나요|있나|습니까|할까|일까)[.*\s]*$/u.test(text)
    && !NON_CURRENT_CONTEXT.test(text) && !UNCERTAIN_CONTEXT.test(text) && !REPORTED_EVENT.test(text);
}
function subjectTail(sentence: string, mention: Mention, mentions: Mention[]) {
  const tail = sentence.slice(mention.end);
  if (!/^(?:은|는|이|가|도|마저)?(?:\s|[,*]|$)/u.test(tail)) return "";
  const next = mentions.find((item) => item.start >= mention.end);
  return sentence.slice(mention.end, next?.start);
}
function ownsPredicate(tail: string, predicate: RegExp) {
  const match = predicate.exec(tail);
  if (!match) return false;
  const before = tail.slice(0, match.index).replace(/죽은\s*(?:게|것이)\s*아니(?:라|고)?/gu, " ");
  // "X는 친구가 죽었다" describes the friend's death, not X's. If a new
  // grammatical subject intervenes, leave this to explicit evidence instead of
  // permanently assigning that outcome to the nearest known name.
  for (const subject of before.matchAll(/(?:^|\s)([가-힣]{1,20})(?:이|가|은|는)(?=\s)/gu)) {
    const stem = subject[1];
    if (/^(?:년|개월|달|일|시간|분|초|때에|후에|뒤에|마지막에|끝에)$/u.test(stem)) continue;
    if (/(?:했다|었다|았다|하다|다가)$/u.test(stem)) continue;
    return false;
  }
  return true;
}
function pairForSentence(sentence: string, mentions: Mention[], personaName: string) {
  const names = [...new Set(mentions.map((item) => item.name))];
  if (names.length === 1 && personaName && names[0] !== personaName && /(?:나는|나와|나를|나에게|내게|우리\s*사이)/u.test(sentence)) {
    names.push(personaName);
  }
  // More than two names needs semantic attribution; do not guess an owner.
  return names.length === 2 ? names.sort((a, b) => key(a).localeCompare(key(b))) : null;
}
function pairKey(names: string[]) { return names.map(key).sort().join("\u0000"); }
function eventExcerpt(sentence: string, mentions: Mention[], eventIndex: number) {
  if (sentence.length <= 250) return sentence;
  const uniqueMentions = [...new Map(mentions.map((item) => [item.name, item])).values()].slice(0, 2);
  // Reserve room for exact source-name spans, then quote around the actual
  // predicate. A head-only truncation can omit the event that justified a state.
  const reserved = uniqueMentions.reduce((sum, item) => sum + item.end - item.start + 3, 0);
  const windowSize = Math.max(40, 240 - reserved);
  const start = Math.max(0, eventIndex - Math.min(40, Math.floor(windowSize / 3)));
  const ranges = [...uniqueMentions.map((item) => ({start:item.start,end:item.end})), {start,end:Math.min(sentence.length,start + windowSize)}]
    .sort((a,b) => a.start - b.start);
  const merged: Array<{start:number;end:number}> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end,range.end);
    else merged.push({...range});
  }
  return merged.map((range) => sentence.slice(range.start,range.end).trim()).filter(Boolean).join(" … ");
}
function isDirectedRelationship(sentence: string, mentions: Mention[], personaName: string) {
  const namedTarget = mentions.some((mention) => /^(?:을|를|에게|한테)(?:\s|$)/u.test(sentence.slice(mention.end)));
  const selfTarget = personaName && /(?:나를|나에게|내게)/u.test(sentence);
  const mutual = /(?:서로|두\s*사람|둘은|둘이)/u.test(sentence);
  const pairStatus = /(?:원수|적대\s*관계|(?:사이|관계)(?:가|는)?\s*[^.!?]{0,15}(?:나쁘|나빠|틀어졌|악화됐|회복)|절교|화해|친구(?:가|로)|동맹(?:이|으로))/u.test(sentence);
  return Boolean(namedTarget || selfTarget || mutual || (pairStatus && !/(?:함께|같이)/u.test(sentence)));
}

export function deriveDurableCharacterCanon(params: {
  messages: DurableStateMessage[];
  identities: DurableCharacterIdentity[];
  personaName?: string;
}): DurableCharacterCanon {
  const findMentions = identityMatcher(params.identities);
  const life = new Map<string, DurableLifeState>();
  const relationships = new Map<string, DurableRelationshipState>();
  let userTurn = 0;
  for (const message of params.messages) {
    const rawRole = String(message.role || "").toLowerCase();
    const role = rawRole === "model" ? "assistant" : rawRole;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "user") userTurn += 1;
    const turnNo = Math.max(1, Math.trunc(Number(message.turnNo) || userTurn || 1));
    for (const sentence of sentences(withoutQuotes(String(message.content || "")))) {
      if (!factualNarration(sentence)) continue;
      const mentions = findMentions(sentence);
      if (!mentions.length) continue;
      const evidence: DurableStateEvidence = {
        sourceRole: role, sourceMessageId: String(message.id || ""), turnNo, evidence: clean(sentence, 600),
      };
      for (const mention of mentions) {
        const tail = subjectTail(sentence, mention, mentions);
        const prefix = sentence.slice(Math.max(0, mention.start - 15), mention.start);
        const dead = (ownsPredicate(tail, DEAD_EVENT) && !/(?:죽|사망|숨지|살해)[^.!?\n]{0,12}(?:않|아니|못했)/u.test(tail))
          || /(?:죽은|사망한|숨진|사살된|살해당한)\s*$/u.test(prefix);
        // An explicit user revival may use the object form "X를 부활시킨다".
        const revivalTail = /^(?:을|를)\s*/u.test(sentence.slice(mention.end))
          ? sentence.slice(mention.end) : tail;
        const alive = role === "user" && ownsPredicate(revivalTail, ALIVE_EVENT)
          && !/(?:살아\s*있|부활|되살|생존)[^.!?\n]{0,12}(?:않|아니|못|없)/u.test(revivalTail);
        const previous = life.get(key(mention.name));
        if (alive) life.set(key(mention.name), {
          name: mention.name, kind: "alive", ...evidence,
          evidence: eventExcerpt(sentence,[mention],mention.end + (ALIVE_EVENT.exec(revivalTail)?.index || 0)),
        });
        else if (dead && (role === "user" || !previous || (previous.kind === "alive" && turnNo > previous.turnNo))) {
          life.set(key(mention.name), {
            name: mention.name, kind: "deceased", ...evidence,
            evidence: eventExcerpt(sentence,[mention],DEAD_EVENT.test(tail) ? mention.end + (DEAD_EVENT.exec(tail)?.index || 0) : mention.start),
          });
        }
      }
      const pair = pairForSentence(sentence, mentions, clean(params.personaName, 80));
      if (!pair || !isDirectedRelationship(sentence, mentions, clean(params.personaName, 80))) continue;
      const previous = relationships.get(pairKey(pair));
      const reconciled = role === "user" && RECONCILED_EVENT.test(sentence) && !NEGATED_RECONCILIATION.test(sentence);
      const hostile = HOSTILE_EVENT.test(sentence) && !NEGATED_HOSTILITY.test(sentence);
      if (reconciled || (hostile && (role === "user" || !previous))) {
        relationships.set(pairKey(pair), {
          subjectName: pair[0], objectName: pair[1], kind: reconciled ? "reconciled" : "hostile", ...evidence,
          evidence: eventExcerpt(sentence,mentions,(reconciled ? RECONCILED_EVENT : HOSTILE_EVENT).exec(sentence)?.index || 0),
        });
      }
    }
  }
  return { lifeStates: [...life.values()], relationships: [...relationships.values()] };
}

export function buildDurableCharacterCanonBlock(canon: DurableCharacterCanon) {
  if (!canon.lifeStates.length && !canon.relationships.length) return "";
  const lines = [
    "# [원문 근거를 보존한 인물 상태 — 최근 AI 출력·요약보다 우선]",
    "- 아래 상태는 남아 있는 원문 사건에서 재구성했다. 최근 AI의 재등장·친밀한 태도·요약만으로 사망이나 적대 상태를 해제하지 않는다.",
    "- 사망한 인물은 현재 장면에서 육체로 말하거나 행동할 수 없다. 명시된 회상·꿈·유령 장면은 구분하며, 사용자의 명시적 부활·생존 정정만 생사 변경으로 인정한다.",
    "- 적대 관계에는 그 원인과 경계·불신이 남는다. 대화·미소·예의·일시 협조만으로 친밀·용서·화해로 바꾸지 않는다. 사용자가 명시한 화해·용서 사건은 반영한다.",
  ];
  for (const state of canon.lifeStates) {
    lines.push(`- ${state.name}: ${state.kind === "deceased" ? "사망 확정" : "사용자가 생존·부활을 확정"} (${state.turnNo}턴, ${state.sourceRole}); 근거: ${state.evidence}`);
  }
  for (const state of canon.relationships) {
    lines.push(`- ${state.subjectName} ↔ ${state.objectName}: ${state.kind === "hostile" ? "적대·불화 유지" : "사용자가 화해·관계 회복을 확정"} (${state.turnNo}턴, ${state.sourceRole}); 근거: ${state.evidence}`);
  }
  return lines.join("\n");
}

const LIVING_ACTION = /(?:살아\s*있|살아서|생존(?:했|해|한)|부활(?:했|한|하여)|되살아|말(?:했|한다|하며|하고|했다)|대답(?:했|한다|하며)|대꾸|물었|묻(?:는다|고|자)|질문(?:했|한다)|웃(?:었|는다|으며)|미소를|걷(?:는다|고)|걸어|들어(?:왔|온다|와)|다가(?:왔|온다|와)|고개를|손을\s*(?:들|내밀|뻗)|눈을\s*(?:뜨|뜬|떴)|몸을\s*(?:일으|돌)|앉(?:았|는다|아)|일어(?:났|난다|나)|먹(?:었|는다)|마(?:셨|신다)|건넸|악수|포옹|껴안|돌아(?:왔|온다|와)|모습을\s*드러|문을\s*열)/u;
const FRIENDLY_ACTION = /(?:가장\s*(?:소중한|친한)\s*친구|절친|친구가\s*되|친구로\s*지내|화해(?:했|했다|한다)|용서(?:했|했다|한다)|다정(?:하게|한)|친근(?:하게|한)|반갑게|기쁘게\s*맞|따뜻하게\s*(?:안|맞|품)|애정|포옹|껴안)/u;
const PERFORMED_FRIENDLINESS = /(?:척(?:했|한다|하며|하고)|가식|억지|위장|연기|조롱|비웃|냉소|경계[^.!?\n]{0,16}감추|적대[^.!?\n]{0,16}감추)/u;

function outputSentences(line: string) {
  // Keep exact text and separators, and do not split punctuation inside dialogue.
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "“" || char === "‘") {
      quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      continue;
    }
    if (!/[.!?。！？]/u.test(char)) continue;
    let end = i + 1;
    while (line[end] === "*") end++;
    if (end < line.length && !/\s/u.test(line[end])) continue;
    while (end < line.length && /\s/u.test(line[end])) end++;
    parts.push(line.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < line.length) parts.push(line.slice(start));
  return parts.length ? parts : [line];
}

/** Generated output only. Never run this against historical messages or summaries:
 * a current death must not erase scenes from when the person was still alive.
 */
export function guardGeneratedDurableCharacterState(input: {
  text: unknown;
  canon: DurableCharacterCanon;
  identities: DurableCharacterIdentity[];
  personaName?: string;
}) {
  const text = String(input.text || "");
  const deceased = new Set(input.canon.lifeStates.filter((state) => state.kind === "deceased").map((state) => key(state.name)));
  const hostile = new Set(input.canon.relationships.filter((state) => state.kind === "hostile").map((state) => pairKey([state.subjectName, state.objectName])));
  if (!text || (!deceased.size && !hostile.size)) return { text, removed: 0, violations: [] as string[] };
  const findMentions = identityMatcher(input.identities);
  let inFence = false;
  let removed = 0;
  const violations = new Set<string>();
  const lines = text.split(/\r?\n/u).map((line) => {
    if (/^\s*```/u.test(line)) { inFence = !inFence; return line; }
    if (inFence || !line.trim()) return line;
    let suppressDeadDialogue = false;
    let changed = false;
    const kept = outputSentences(line).filter((part) => {
    if (suppressDeadDialogue && /^\s*["“][\s\S]*["”][\s*]*$/u.test(part)) {
      removed += 1; changed = true; suppressDeadDialogue = false; return false;
    }
    suppressDeadDialogue = false;
    if (NON_CURRENT_CONTEXT.test(part)) return true;
    const narration = withoutQuotes(part);
    const mentions = findMentions(narration);
    let invalid = false;
    for (const mention of mentions) {
      if (!deceased.has(key(mention.name))) continue;
      const tail = subjectTail(narration, mention, mentions);
      if (ownsPredicate(tail, LIVING_ACTION) && !/(?:살아\s*있|생존|부활)[^.!?\n]{0,10}(?:않|아니|못|없)/u.test(tail)
        && !DEAD_EVENT.test(tail) && !UNCERTAIN_CONTEXT.test(tail)) {
        violations.add(`deceased_actor:${mention.name}`);
        invalid = true;
      }
    }
    // A named dialogue speaker is also an actor, even without a narration verb.
    const speaker = part.match(/^\s*\*{0,2}([^:*"“\n]{2,80})\s*:\s*["“]/u)?.[1]?.trim();
    if (speaker) {
      const match = findMentions(speaker);
      if (match.length === 1 && match[0].start === 0 && match[0].end === speaker.length && deceased.has(key(match[0].name))) {
        violations.add(`deceased_speaker:${match[0].name}`);
        invalid = true;
      }
    }
    const pair = pairForSentence(narration, mentions, clean(input.personaName, 80));
    if (pair && hostile.has(pairKey(pair)) && FRIENDLY_ACTION.test(narration)
      && !PERFORMED_FRIENDLINESS.test(narration) && !NEGATED_RELATION.test(narration)
      && !UNCERTAIN_CONTEXT.test(narration)) {
      violations.add(`hostility_reversal:${pair.join("/")}`);
      invalid = true;
    }
    if (invalid) {
      removed += 1; changed = true;
      suppressDeadDialogue = /(?:말|대답|대꾸|물었|묻)/u.test(narration) && [...violations].some((item) => item.startsWith("deceased_"));
    }
    return !invalid;
    });
    if (!changed) return line;
    let value = kept.join("").trim();
    if (value && line.trim().startsWith("*") && !value.startsWith("*")) value = `*${value}`;
    if (value && line.trim().endsWith("*") && !value.endsWith("*")) value = `${value}*`;
    return value;
  });
  return { text: removed ? lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim() : text, removed, violations: [...violations] };
}
