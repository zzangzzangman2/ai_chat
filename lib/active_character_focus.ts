import { findMentionedCharacterIds, findAddressedCharacterIds, characterNamePattern, characterAliases } from "./character_mentions";

export type ActiveCharacterIdentity = {
  id: string;
  name: string;
  aliases?: string | string[] | null;
  profile?: string;
  role?: string;
  relationshipNote?: string;
};

type FocusRelationship = { subjectName: string; objectName: string; relation: string };

export type ActiveCharacterFocus = {
  ids: string[];
  names: string[];
  anchorText: string;
  reason: "current-explicit" | "current-mention" | "pronoun-nearest-user" | "relationship-address" | "continued-address" | "none";
  locked: boolean;
  exclusive?: boolean;
  inPerson?: boolean;
  familyNames?: string[];
};

const FATHER = /장인(?:어른|님)?/u;
const MOTHER = /장모(?:님)?/u;
const PARENT_ROLE = { father: "(?:부친|아버지|친부|아빠)", mother: "(?:모친|어머니|친모|엄마)" };
const REMOTE = /전화|통화|무전|서신|편지|문자|전언/u;
const ADDRESS_BREAK = /장면\s*전환|다음\s*날|며칠\s*후|이야기.{0,8}(?:그만|끝)|대화.{0,8}(?:그만|끝)|(?:으로|로)\s*(?:가자|가서|들어가|이동|떠나|돌아가)|(?:만나러|찾아)\s*가/u;
const GROUP_ADDRESS = /(?:모두|다들|너희|너네|각자|둘\s*다|다\s*같이)[^.!?\n]{0,24}(?:대답|말해|말하|의견|설명|알려|준비해|준비하|시작해|시작하|진행해|확인해|모여|움직여|따라와|가자|가라|나가|들어와)/u;
const REMOTE_QUESTION = /어디\s*(?:있|계)|(?:오면|오거든|만나면|온다면)/u;

function requestsExclusiveReply(text: string, names: string[] = []) {
  return /(?:너|당신|자네|본인)(?:만|한테만|에게만)[^.!?\n]{0,16}(?:대답|말|묻|질문|듣)|(?:에게|한테|께)만[^.!?\n]{0,16}(?:묻|질문|말)|단둘이|둘이서만|다른\s*(?:사람|인물|애들|누구)[^.!?\n]{0,20}(?:끼어들지|말하지|대답하지)/u.test(text) ||
    names.some(name => new RegExp(`${characterNamePattern(name)}만\\s*(?:대답|말해|설명|알려)`, "u").test(text));
}

function conversationBreak(text: string, identities: ActiveCharacterIdentity[]) {
  if (ADDRESS_BREAK.test(text) || GROUP_ADDRESS.test(text)) return true;
  const action = text.replace(/^[\s*\[\(]+|[\s*\]\).!]+$/gu, "");
  // Short stage directions are scene progression, not an unnamed line to the
  // last person addressed. Questions/plans about somebody's arrival are not.
  if (/^(?:(?:작전|계획|상황|장면|이야기|행사|회의|작업)\s*)?(?:계속\s*)?(?:진행|시작|도착|합류|이동|입장|퇴장)(?:한다|해|해줘|하자|했다|함)?$/u.test(action)) return true;
  const narrative = text.replace(/["“][^"”]*["”]/gu, " ");
  return identities.some(identity => [identity.name, ...characterAliases(identity.aliases)].some(name =>
    new RegExp(`${characterNamePattern(name)}(?:이|가|은|는)\\s*(?:(?:여기|이곳|방|마당|현장)(?:에|으로|로)?\\s*)?(?:도착(?:한다|했다|했어)|들어(?:온다|왔다|왔어)|등장(?:한다|했다)|합류(?:한다|했다)|떠(?:난다|났다)|퇴장(?:한다|했다))(?![가-힣])`, "u").test(narrative)
  ));
}

function directAddress(text: string, identities: ActiveCharacterIdentity[]): ActiveCharacterFocus | null {
  const ids = findAddressedCharacterIds(identities, text);
  const matches = identities.filter(identity => ids.has(identity.id));
  if (!matches.length) return null;
  return {ids:matches.map(identity => identity.id),names:matches.map(identity => identity.name),anchorText:text,
    reason:"current-explicit",locked:true,exclusive:requestsExclusiveReply(text, matches.flatMap(identity => [identity.name, ...characterAliases(identity.aliases)])) && !GROUP_ADDRESS.test(text),inPerson:!REMOTE.test(text) && !REMOTE_QUESTION.test(text)};
}

function escapePattern(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function resolveFamilyAddress(text: string, params: {
  identities: ActiveCharacterIdentity[];
  relationships?: FocusRelationship[];
  personaName?: string;
}): ActiveCharacterFocus | null {
  const wantsFather = FATHER.test(text), wantsMother = MOTHER.test(text);
  const explicitOwners = mentionedIdentities(text, params.identities);
  const wantsParents = /부모(?:님)?/u.test(text) && explicitOwners.length > 0;
  if (!wantsFather && !wantsMother && !wantsParents) return null;
  // A question/plan about absent parents is not an address or an arrival.
  if (/어디|누구|계신지|만나면|오시면|가면|인사하지\s*마/u.test(text)) return null;
  if (!/(?:에게|한테|께)|인사|말(?:한다|하|씀)|묻|여쭤|감사|안녕|[,.!?]|["“]/u.test(text)) return null;
  const relations = params.relationships || [];
  const spouses = new Set(relations.filter(r => /^(?:배우자|아내|남편|부인)$/u.test(r.relation)).flatMap(r =>
    r.subjectName === params.personaName ? [r.objectName] : r.objectName === params.personaName ? [r.subjectName] : []));
  const requested = [wantsFather || wantsParents ? "father" : "", wantsMother || wantsParents ? "mother" : ""].filter(Boolean) as Array<keyof typeof PARENT_ROLE>;
  const selected: ActiveCharacterIdentity[] = [];
  const familyNames = new Set<string>();
  for (const kind of requested) {
    const candidates = params.identities.flatMap(identity => {
      const description = [identity.profile, identity.role, identity.relationshipNote].join(" ");
      const direct = Boolean(params.personaName) && new RegExp(`${escapePattern(params.personaName!)}(?:의)?\\s*${kind === "father" ? "장인" : "장모"}`, "u").test(description);
      if (!direct && !new RegExp(PARENT_ROLE[kind], "u").test(description) && !relations.some(r =>
        r.objectName === identity.name && new RegExp(`^${PARENT_ROLE[kind]}$`, "u").test(r.relation))) return [];
      const owners = params.identities.filter(child => {
        const parentInProfile = new RegExp(`${escapePattern(child.name)}(?:의)?\\s*${PARENT_ROLE[kind]}`, "u").test(description);
        const parentInGraph = relations.some(r =>
          (r.subjectName === child.name && r.objectName === identity.name && new RegExp(`^${PARENT_ROLE[kind]}$`, "u").test(r.relation)) ||
          (r.subjectName === identity.name && r.objectName === child.name && /^(?:자녀|딸|아들)$/u.test(r.relation) && new RegExp(PARENT_ROLE[kind], "u").test(description)));
        return parentInProfile || parentInGraph;
      });
      const qualifiedOwners = explicitOwners.length
        ? owners.filter(owner => explicitOwners.some(named => named.id === owner.id))
        : owners.filter(owner => spouses.has(owner.name));
      if (!qualifiedOwners.length && !(direct && !explicitOwners.length)) return [];
      return [{ identity, owners: qualifiedOwners }];
    });
    // Multiple families are ambiguous. Do not pick the most recently named NPC.
    if (candidates.length !== 1) return null;
    selected.push(candidates[0].identity);
    candidates[0].owners.forEach(owner => familyNames.add(owner.name));
  }
  return { ids: selected.map(r => r.id), names: selected.map(r => r.name), anchorText: text,
    reason: "relationship-address", locked: true, exclusive: requestsExclusiveReply(text), inPerson: !REMOTE.test(text), familyNames: [...familyNames] };
}

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
  relationships?: FocusRelationship[];
  personaName?: string;
}): ActiveCharacterFocus {
  const identities = (params.identities || []).filter(
    (identity) => String(identity?.id || "").trim() && String(identity?.name || "").trim()
  );
  const currentText = cleanStoryText(params.currentUserText).trim();
  const familyFocus = resolveFamilyAddress(currentText, { ...params, identities });
  if (familyFocus) return familyFocus;
  const directFocus = directAddress(currentText, identities);
  if (directFocus) return directFocus;
  if (GROUP_ADDRESS.test(currentText)) return {ids:[],names:[],anchorText:"",reason:"none",locked:false};
  const currentMatches = mentionedIdentities(currentText, identities);

  // A recent addressee has reply priority, not exclusive ownership of a scene.
  // Source facts persist in long-term memory; conversational attention expires
  // or yields to scene progression without changing those facts.
  if (!conversationBreak(currentText, identities)) {
    const previous = (params.previousUserTexts || []).slice(0, Math.max(1, Math.min(30, params.maxPreviousTurns ?? 12)));
    const intervening = [currentText];
    for (const value of previous) {
      const text = cleanStoryText(value).trim();
      const anchor = resolveFamilyAddress(text, { ...params, identities }) || directAddress(text, identities);
      if (anchor) {
        if (!anchor.familyNames?.length) {
          // Mentioning a third person is often the topic of a question to the
          // current listener. Only a new address or scene/contact break switches it.
          if (REMOTE.test(currentText) && !REMOTE.test(anchor.anchorText)) break;
          return {...anchor,reason:"continued-address",inPerson:false,
            exclusive:anchor.exclusive || requestsExclusiveReply(currentText)};
        }
        const allowed = new Set([...anchor.names, ...(anchor.familyNames || [])]);
        const unchanged = intervening.every(line => mentionedIdentities(line, identities).every(identity => allowed.has(identity.name)) &&
          !(anchor.familyNames || []).some(name => new RegExp(`${escapePattern(name)}(?:에게|한테|께|야|아)`, "u").test(line)));
        if (unchanged) return { ...anchor, reason: "continued-address", inPerson: false,
          exclusive: anchor.exclusive || requestsExclusiveReply(currentText) };
        break;
      }
      if (conversationBreak(text, identities) || FATHER.test(text) || MOTHER.test(text)) break;
      intervening.push(text);
    }
  }

  if (currentMatches.length) {
    return { ids: currentMatches.map(identity => identity.id), names: currentMatches.map(identity => identity.name),
      anchorText: currentText, reason: "current-mention", locked: false };
  }

  if (!conversationBreak(currentText, identities) && usesSecondPersonReference(params.currentUserText)) {
    const maxPreviousTurns = Math.max(1, Math.min(30, Math.floor(params.maxPreviousTurns ?? 12)));
    for (const previous of (params.previousUserTexts || []).slice(0, maxPreviousTurns)) {
      if (conversationBreak(cleanStoryText(previous), identities)) break;
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

/** A direct in-person greeting establishes the addressed people in the scene.
 * Being the addressee is separate from residence and from other NPCs' presence. */
export function applyActiveFocusToScene<T extends { characterName: string; characterAliases: string[]; evidence: string; messageIndex: number }>(
  scene: { present: T[]; offScene: T[]; location: string }, focus: ActiveCharacterFocus,
) {
  if (!focus.inPerson || !["current-explicit", "relationship-address"].includes(focus.reason)) return scene;
  const isTarget = (fact: T) => focus.names.includes(fact.characterName);
  const present = [...scene.present.filter(fact => !isTarget(fact))];
  for (const name of focus.names) {
    const previous = [...scene.present, ...scene.offScene].find(fact => fact.characterName === name);
    present.push({ ...previous, characterName: name, characterAliases: previous?.characterAliases || [],
      evidence: focus.anchorText, messageIndex: previous?.messageIndex ?? -1 } as T);
  }
  return { ...scene, present, offScene: scene.offScene.filter(fact => !isTarget(fact)) };
}
