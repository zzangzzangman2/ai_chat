export type RecognitionConsistencyFact = {
  characterId: string;
  characterName: string;
  characterAliases?: string[];
  firstInteractionTurn: number;
  lastInteractionTurn: number;
  evidence: string;
};

export type RecognitionContradiction = {
  characterName: string;
  matchedText: string;
  index: number;
};

export type ScenePresenceMessage = {
  role?: string;
  content?: string;
};

export type ScenePresenceIdentity = {
  name: string;
  aliases?: string[];
};

export type ScenePresenceFact = {
  characterName: string;
  characterAliases: string[];
  evidence: string;
  messageIndex: number;
};

export type ScenePresenceContradiction = {
  characterName: string;
  matchedText: string;
  index: number;
  kind:
    | "duplicate_entry"
    | "duplicate_introduction"
    | "unauthorized_exit"
    | "unauthorized_reentry";
};

const FIRST_MEETING_PATTERNS = [
  /(?:당신|너|넌|네놈|자네|그쪽|저\s*(?:사람|남자|여자|노인|늙은이|사내|아이|인물)|이\s*(?:사람|남자|여자|노인|늙은이|사내|아이|인물))\s*(?:은|는|이|가|도)?\s*(?:대체\s*)?(?:누구(?:야|냐|세요|십니까|지)?|누군데|뭐(?:야|냐|죠|지|입니까)|뭡니까|정체가\s*뭐(?:야|냐|죠|지|입니까)|뭐\s*하는\s*사람(?:이야|이냐|입니까)?)/giu,
  /["“'‘]\s*(?:대체\s*)?누구(?:야|냐|세요|십니까|지)?(?:\s*[?!？！])?/giu,
  /(?:처음\s*(?:보는|본|만나는|만난)|초면(?:인|인데|이군|이네)?|생전\s*처음\s*보는)\s*(?:사람|남자|여자|노인|늙은이|사내|아이|얼굴|상대|인물)?/giu,
  /(?:낯선|모르는)\s*(?:사람|남자|여자|노인|늙은이|사내|아이|얼굴|상대|인물)/giu,
  /(?:본|만난|마주친)\s*적(?:이)?\s*(?:없|없는)/giu,
  /(?:누군지\s*(?:몰랐|모르|알\s*수\s*없)|기억에\s*없는\s*(?:사람|얼굴)|알아보지\s*못(?:했|하)|못\s*알아봤)/giu,
] as const;

function normalized(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase("ko-KR");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usableEntityNames(values: unknown[]) {
  return [...new Set(values.map(normalized).filter((value) => value.length >= 2))];
}

function stripFencedBlocks(value: unknown) {
  return String(value || "")
    .replace(/```[^\n]*\n[\s\S]*?```/g, "")
    .replace(/```[\s\S]*$/g, "");
}

const SCENE_RESET_PATTERN =
  /(?:\[?\s*장면\s*전환\s*\]?|다음\s*날|며칠\s*후|몇\s*(?:분|시간|주|달|년)\s*후|장소를\s*(?:옮기|이동)|새로운\s*장소로\s*(?:이동|향))/u;

const ENTRY_CUE_PATTERN =
  /(?:새로\s*|다시\s*|뒤이어\s*|다음으로\s*)?(?:들어\s*왔|들어\s*온|들어섰|입장했|입장한|도착했|도착한|합류했|합류한|나타났|나타난|등장했|등장한|끌려\s*(?:들어\s*왔|들어\s*온|들어가|내려왔|내려온|왔|온|와)|데려왔|데려온|불려왔|불려온|호송(?:되어|돼)?\s*(?:들어|왔|온)|모습을\s*드러냈|모습을\s*드러낸)/u;

const EXIT_CUE_PATTERN =
  /(?:나갔|나간|떠났|떠난|퇴장했|퇴장한|사라졌|사라진|자취를\s*감췄|자취를\s*감춘|모습을\s*감췄|모습을\s*감춘|돌아갔|돌아간|자리를\s*떴|자리를\s*뜬|도망(?:쳤|친|갔|간|가버렸|가버린|쳐버렸|쳐버린)|방으로\s*(?:도망|달아)|끌려\s*(?:나갔|나간|나가|갔|간)|호송(?:되어|돼)?\s*나갔|밖으로\s*(?:나갔|나간|끌려갔|끌려간)|내보냈|내보낸|쫓아냈|쫓아낸)/u;

const ACTIVE_CUE_PATTERN =
  /(?:무릎을\s*꿇고\s*있|앉아\s*있|서\s*있|누워\s*있|기대어\s*있|머물고\s*있|남아\s*있|붙잡혀\s*있|포박(?:되어|돼)\s*있|묶여\s*있|갇혀\s*있|바라봤|바라보며|말했|물었|대답했|외쳤|고개를\s*(?:들|끄덕|저))/u;

const ENTRY_MODIFIER_CUE_PATTERN =
  /(?:들어\s*온|입장한|도착한|합류한|나타난|등장한|끌려\s*(?:들어\s*온|내려온|온)|데려온|불려온|호송(?:되어|돼)?\s*온|모습을\s*드러낸)/u;

const EXIT_MODIFIER_CUE_PATTERN =
  /(?:나간|떠난|퇴장한|사라진|자취를\s*감춘|모습을\s*감춘|돌아간|자리를\s*뜬|도망(?:친|간|가버린|쳐버린)|끌려\s*(?:나간|간)|호송(?:되어|돼)?\s*나간|내보낸|쫓아낸)/u;

const GENERIC_SCENE_SUBJECT_PATTERN =
  /(?:곁에\s*(?:있|엎드려|서|앉아)[^.!?。！？\n]{0,35})?(?:작은\s*)?(?:형체|인물|사람|아이|소녀|소년|친구|그녀|그|한\s*명)(?:은|는|이|가)?/u;

const RELATIONAL_GENERIC_SCENE_SUBJECT_PATTERN =
  /(?:(?:곁|옆|반대편|바로\s*옆|주변)[^.!?。！？\n]{0,55}(?:다른|또\s*다른|나머지)?\s*(?:형체|인물|사람|아이|소녀|소년|친구|그녀|그|한\s*명)|(?:다른|또\s*다른|나머지)\s*(?:형체|인물|사람|아이|소녀|소년|친구|그녀|그|한\s*명))/u;

const CURRENT_GROUP_REFERENCE_PATTERN =
  /(?:둘\s*다|둘이|두\s*(?:사람|명|아이|소녀|소년)|서로|얘들|너희들|다\s*같이|모두)/u;

const USER_EXCLUSION_CUE_PATTERN =
  /(?:문\s*밖|바깥|밖으로)[^.!?。！？\n]{0,70}(?:내?쫓|쫒|보냈|보낸|밀어냈|끌어냈)|(?:내?쫓|쫒|내보내|보내)[^.!?。！？\n]{0,50}(?:문\s*밖|바깥|밖으로)|(?:못|다시는?)\s*들어오|들어오지\s*못|출입\s*금지|접근\s*금지/u;

const USER_RETURN_CUE_PATTERN =
  /(?:다시\s*)?(?:들어와|들어오|돌아와|돌아오|불러와|데려와|합류해|복귀해|재입장)|(?:들여보내|들여보냈|입장시켜)/u;

function compactEvidence(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function splitStoryPassages(value: unknown) {
  return stripFencedBlocks(value)
    .split(/\n\s*\n|(?<=[.!?。！？])\s+/u)
    .map((passage) => passage.trim())
    .filter(Boolean);
}

function passageMentionsName(passage: string, names: string[]) {
  const key = normalized(passage);
  return names.some((name) => key.includes(name));
}

function nameBeforeCuePattern(name: string, cue: RegExp, distance = 100) {
  return new RegExp(
    `${escapeRegex(name)}(?:은|는|이|가|을|를|에게|한테|도|만|의|와|과)?[^.!?。！？\\n]{0,${distance}}(?:${cue.source})`,
    "iu"
  );
}

function cueBeforeNamePattern(name: string, cue: RegExp, distance = 100) {
  return new RegExp(
    `(?:${cue.source})[^.!?。！？\\n]{0,${distance}}${escapeRegex(name)}(?:은|는|이|가|을|를|에게|한테|도|만|의|와|과)?`,
    "iu"
  );
}

function passageHasNamedCue(args: {
  passage: string;
  names: string[];
  cue: RegExp;
  distance?: number;
}) {
  for (const name of args.names) {
    if (
      nameBeforeCuePattern(name, args.cue, args.distance).test(args.passage) ||
      cueBeforeNamePattern(name, args.cue, args.distance).test(args.passage)
    ) {
      return true;
    }
  }
  return false;
}

function findNamedDirectionalCue(args: {
  passage: string;
  names: string[];
  cue: RegExp;
  modifierCue: RegExp;
}) {
  const matches: RegExpExecArray[] = [];
  for (const name of args.names) {
    const escapedName = escapeRegex(name);
    const subject = new RegExp(
      `${escapedName}(?:이|가)[^.!?。！？\\n]{0,70}(?:${args.cue.source})`,
      "iu"
    ).exec(args.passage);
    if (subject) matches.push(subject);

    const topicPattern = new RegExp(
      `${escapedName}(?:은|는)([^.!?。！？\\n]{0,70})(?:${args.cue.source})`,
      "iu"
    );
    const topic = topicPattern.exec(args.passage);
    if (
      topic &&
      !/[\p{L}\p{N}_-]{2,30}(?:이|가)\s/iu.test(String(topic[1] || ""))
    ) {
      matches.push(topic);
    }

    // An object can only own the movement when a transport/escort verb binds it;
    // "A를 보며 B가 들어왔다" must not be read as A entering.
    const object = new RegExp(
      `${escapedName}(?:을|를)([^.!?。！？\\n]{0,80})(?:${args.cue.source})`,
      "iu"
    ).exec(args.passage);
    if (
      object &&
      /(?:끌|데리|데려|호송|부축|불러|내보내|쫓아내)/u.test(
        String(object[0] || "")
      )
    ) {
      matches.push(object);
    }

    const modifier = new RegExp(
      `(?:${args.modifierCue.source})(?:\\s+[\\p{L}\\p{N}_-]+){0,4}\\s+${escapedName}(?:은|는|이|가|을|를)?`,
      "iu"
    ).exec(args.passage);
    if (modifier) matches.push(modifier);

    const reveal = new RegExp(
      `(?:${args.cue.source})[^.!?。！？\\n]{0,35}(?:것|사람|여자|남자|인물|대상)(?:은|는|이|가)[^.!?。！？\\n]{0,80}${escapedName}(?:은|는|이|가|을|를)?`,
      "iu"
    ).exec(args.passage);
    if (reveal) matches.push(reveal);
  }
  matches.sort((a, b) => a.index - b.index);
  return matches[0] || null;
}

function findNamedEntryCue(passage: string, names: string[]) {
  return findNamedDirectionalCue({
    passage,
    names,
    cue: ENTRY_CUE_PATTERN,
    modifierCue: ENTRY_MODIFIER_CUE_PATTERN,
  });
}

function findNamedExitCue(passage: string, names: string[]) {
  return findNamedDirectionalCue({
    passage,
    names,
    cue: EXIT_CUE_PATTERN,
    modifierCue: EXIT_MODIFIER_CUE_PATTERN,
  });
}

function passageShowsActivePresence(passage: string, names: string[]) {
  if (
    passageHasNamedCue({
      passage,
      names,
      cue: ACTIVE_CUE_PATTERN,
      distance: 90,
    })
  ) {
    return true;
  }

  // Korean scene prose often puts the continuing-state phrase before the
  // subject: "무릎을 꿇고 있던 안유진은 ...".
  for (const name of names) {
    const stateBeforeSubject = new RegExp(
      `(?:무릎을\\s*꿇고|앉아|서|누워|기대어|붙잡혀|포박(?:되어|돼)|묶여|갇혀)[^.!?。！？\\n]{0,45}(?:있던|있는)\\s*(?:[\\p{L}\\p{N}_-]+\\s+){0,4}${escapeRegex(name)}(?:은|는|이|가)?`,
      "iu"
    );
    if (stateBeforeSubject.test(passage)) return true;
  }
  return false;
}

/**
 * Reconstructs only high-confidence transient scene presence from recent raw
 * turns. This deliberately does not use residence or long-memory locations:
 * present/absent is a short-lived scene fact and must be cleared by an exit or
 * an explicit time/location cut.
 */
export function deriveCurrentScenePresence(args: {
  messages: ScenePresenceMessage[];
  identities: ScenePresenceIdentity[];
  maxMessages?: number;
}): ScenePresenceFact[] {
  const identities = args.identities
    .map((identity) => ({
      characterName: String(identity.name || "").trim(),
      characterAliases: usableEntityNames(identity.aliases || []),
    }))
    .filter((identity) => normalized(identity.characterName).length >= 2);
  if (!identities.length) return [];

  const requestedMax = Number(args.maxMessages || 14);
  const maxMessages = Number.isFinite(requestedMax)
    ? Math.max(2, Math.floor(requestedMax))
    : 14;
  const recent = (args.messages || []).slice(-maxMessages);
  const states = new Map<string, ScenePresenceFact>();
  let latestUserText = "";

  recent.forEach((message, messageIndex) => {
    const story = stripFencedBlocks(message?.content || "");
    if (!story.trim()) return;
    const isUserMessage = normalized(message?.role) === "user";
    if (isUserMessage) latestUserText = story;

    for (const passage of splitStoryPassages(story)) {
      if (SCENE_RESET_PATTERN.test(passage)) states.clear();
      for (const identity of identities) {
        const names = usableEntityNames([
          identity.characterName,
          ...identity.characterAliases,
        ]);
        if (!passageMentionsName(passage, names)) continue;

        // Exit wins when a compact sentence contains both movement directions;
        // a later passage in the same turn can still establish a true re-entry.
        if (findNamedExitCue(passage, names)) {
          // An assistant draft cannot erase a character from scene canon by
          // inventing a flight/disappearance. It only confirms an exit when
          // the immediately preceding user turn actually directed one.
          if (
            isUserMessage ||
            currentTurnAllowsExit(latestUserText, names)
          ) {
            states.delete(normalized(identity.characterName));
          }
          continue;
        }

        const entered = Boolean(findNamedEntryCue(passage, names));
        if (!entered && !passageShowsActivePresence(passage, names)) continue;

        states.set(normalized(identity.characterName), {
          characterName: identity.characterName,
          characterAliases: identity.characterAliases,
          evidence: compactEvidence(passage),
          messageIndex,
        });
      }
    }
  });

  return [...states.values()];
}

/**
 * Reconstructs user-authoritative exclusions from the recent raw scene.
 * Assistant prose is deliberately unable to clear this state: a character the
 * user expelled or banned stays outside until the user explicitly calls that
 * same character back or starts a new scene.
 */
export function deriveCurrentSceneExclusions(args: {
  messages: ScenePresenceMessage[];
  identities: ScenePresenceIdentity[];
  maxMessages?: number;
}): ScenePresenceFact[] {
  const identities = args.identities
    .map((identity) => ({
      characterName: String(identity.name || "").trim(),
      characterAliases: usableEntityNames(identity.aliases || []),
    }))
    .filter((identity) => normalized(identity.characterName).length >= 2);
  if (!identities.length) return [];

  const requestedMax = Number(args.maxMessages || 18);
  const maxMessages = Number.isFinite(requestedMax)
    ? Math.max(2, Math.floor(requestedMax))
    : 18;
  const recent = (args.messages || []).slice(-maxMessages);
  const states = new Map<string, ScenePresenceFact>();

  recent.forEach((message, messageIndex) => {
    const story = stripFencedBlocks(message?.content || "");
    if (!story.trim()) return;

    for (const passage of splitStoryPassages(story)) {
      if (normalized(message?.role) !== "user") continue;
      if (SCENE_RESET_PATTERN.test(passage)) states.clear();

      for (const identity of identities) {
        const names = usableEntityNames([
          identity.characterName,
          ...identity.characterAliases,
        ]);
        if (!passageMentionsName(passage, names)) continue;

        if (
          USER_RETURN_CUE_PATTERN.test(passage) &&
          !USER_EXCLUSION_CUE_PATTERN.test(passage)
        ) {
          states.delete(normalized(identity.characterName));
          continue;
        }

        if (
          findNamedExitCue(passage, names) ||
          USER_EXCLUSION_CUE_PATTERN.test(passage)
        ) {
          states.set(normalized(identity.characterName), {
            characterName: identity.characterName,
            characterAliases: identity.characterAliases,
            evidence: compactEvidence(passage),
            messageIndex,
          });
        }
      }
    }
  });

  return [...states.values()];
}

function currentTurnAllowsExit(value: unknown, names: string[]) {
  const text = String(value || "");
  if (!text.trim()) return false;
  if (
    /(?:나가|꺼져|떠나|사라져|도망가|방으로\s*가|돌아가|퇴장|내보내|쫓아내|쫒아내|밖으로\s*보내)/u.test(
      text
    )
  ) {
    return true;
  }
  return passageMentionsName(text, names) && Boolean(findNamedExitCue(text, names));
}

function currentTurnAllowsReentry(value: unknown, names: string[]) {
  const text = String(value || "");
  if (!passageMentionsName(text, names)) return false;
  return (
    USER_RETURN_CUE_PATTERN.test(text) ||
    currentTurnOverridesScenePresence(text, names)
  );
}

function currentTurnOverridesScenePresence(value: unknown, names: string[]) {
  const text = String(value || "");
  if (!/(?:OOC|작가\s*지시|설정\s*(?:변경|수정|정정)|연속성\s*무시)/iu.test(text)) {
    return false;
  }
  return (
    passageMentionsName(text, names) &&
    (ENTRY_CUE_PATTERN.test(text) || /(?:재입장|다시\s*등장|돌아오)/u.test(text))
  );
}

function findNamedIntroduction(passage: string, names: string[]) {
  for (const name of names) {
    const pattern = new RegExp(
      `(?:저는|전|제\\s*이름은|내\\s*이름은)?[^"”.!?。！？\\n]{0,45}${escapeRegex(name)}(?:\\s*(?:이라고|라고)\\s*(?:합니다|해요)|\\s*(?:입니다|예요|이에요))`,
      "iu"
    );
    const match = pattern.exec(passage);
    if (match) return match;
  }
  return null;
}

function findNamedDuplicateEntry(passage: string, names: string[]) {
  return findNamedEntryCue(passage, names);
}

/** Finds a draft that stages an already-present person as a new arrival. */
export function findScenePresenceContradiction(args: {
  text: string;
  currentUserText?: string;
  presentCharacters: ScenePresenceFact[];
  excludedCharacters?: ScenePresenceFact[];
}): ScenePresenceContradiction | null {
  const story = stripFencedBlocks(args.text);
  const excludedCharacters = args.excludedCharacters || [];
  if (
    !story.trim() ||
    (!args.presentCharacters.length && !excludedCharacters.length)
  ) {
    return null;
  }
  let searchOffset = 0;

  for (const passage of splitStoryPassages(story)) {
    const passageIndex = story.indexOf(passage, searchOffset);
    if (passageIndex >= 0) searchOffset = passageIndex + passage.length;

    for (const fact of args.presentCharacters) {
      const names = usableEntityNames([
        fact.characterName,
        ...(fact.characterAliases || []),
      ]);
      if (!passageMentionsName(passage, names)) continue;
      if (currentTurnOverridesScenePresence(args.currentUserText, names)) continue;

      const entry = findNamedDuplicateEntry(passage, names);
      if (entry) {
        return {
          characterName: fact.characterName,
          matchedText: entry[0],
          index: Math.max(0, passageIndex) + entry.index,
          kind: "duplicate_entry",
        };
      }

      if (!currentTurnAllowsExit(args.currentUserText, names)) {
        const exit = findNamedExitCue(passage, names);
        if (exit) {
          return {
            characterName: fact.characterName,
            matchedText: exit[0],
            index: Math.max(0, passageIndex) + exit.index,
            kind: "unauthorized_exit",
          };
        }
      }

      // A bare self-introduction is a second independent backstop. It catches
      // the next streamed paragraph even when the duplicate-arrival paragraph
      // immediately before it was already removed.
      if (!/(?:소개|신원|이름|누구)/u.test(String(args.currentUserText || ""))) {
        const introduction = findNamedIntroduction(passage, names);
        if (introduction) {
          return {
            characterName: fact.characterName,
            matchedText: introduction[0],
            index: Math.max(0, passageIndex) + introduction.index,
            kind: "duplicate_introduction",
          };
        }
      }
    }

    // The model sometimes evades a name-bound guard by replacing a known
    // person with "the small figure / the other person beside her" and
    // immediately making that anonymous referent disappear. The current scene
    // roster itself is authoritative: a relational subject such as "the other
    // figure beside her" cannot bypass the guard merely because the latest
    // user sentence omitted an explicit "both of you" phrase.
    const currentUserReferencesGroup = CURRENT_GROUP_REFERENCE_PATTERN.test(
      String(args.currentUserText || "")
    );
    const relationalCurrentSubject =
      args.presentCharacters.length >= 2 &&
      RELATIONAL_GENERIC_SCENE_SUBJECT_PATTERN.test(passage);
    if (
      args.presentCharacters.length > 0 &&
      (currentUserReferencesGroup || relationalCurrentSubject) &&
      GENERIC_SCENE_SUBJECT_PATTERN.test(passage)
    ) {
      const genericExit = EXIT_CUE_PATTERN.exec(passage);
      if (genericExit && !currentTurnAllowsExit(args.currentUserText, [])) {
        return {
          characterName: args.presentCharacters[0].characterName,
          matchedText: genericExit[0],
          index: Math.max(0, passageIndex) + genericExit.index,
          kind: "unauthorized_exit",
        };
      }
    }


    for (const fact of excludedCharacters) {
      const names = usableEntityNames([
        fact.characterName,
        ...(fact.characterAliases || []),
      ]);
      if (!passageMentionsName(passage, names)) continue;
      if (currentTurnAllowsReentry(args.currentUserText, names)) continue;

      const entry = findNamedEntryCue(passage, names);
      if (entry) {
        return {
          characterName: fact.characterName,
          matchedText: entry[0],
          index: Math.max(0, passageIndex) + entry.index,
          kind: "unauthorized_reentry",
        };
      }
    }
  }
  return null;
}

function surroundingSpeakerPassage(text: string, index: number, matchLength: number) {
  const before = text.slice(0, index);
  const boundaries = [...before.matchAll(/\n\s*\n/g)];
  const currentStart = boundaries.length
    ? Number(boundaries[boundaries.length - 1].index || 0) +
      boundaries[boundaries.length - 1][0].length
    : 0;
  const previousStart =
    boundaries.length >= 2
      ? Number(boundaries[boundaries.length - 2].index || 0) +
        boundaries[boundaries.length - 2][0].length
      : 0;
  const after = text.slice(index + matchLength);
  const nextBoundary = after.search(/\n\s*\n/);
  const currentEnd =
    nextBoundary >= 0 ? index + matchLength + nextBoundary : text.length;
  return text.slice(previousStart, Math.max(currentStart, currentEnd));
}

const ATTRIBUTION_CUE =
  /말|묻|물었|물어|외치|소리|고함|중얼|대꾸|답하|쏘아붙|내뱉|토해|으르렁|경고|명령|노려|바라보|쳐다보|생각|판단|여기|인식|느끼|취급|대했|반응/iu;

function entityMentionIndexes(text: string, names: string[]) {
  const indexes: Array<{ index: number; name: string }> = [];
  for (const name of names) {
    let cursor = 0;
    while (cursor < text.length) {
      const index = text.indexOf(name, cursor);
      if (index < 0) break;
      indexes.push({ index, name });
      cursor = index + Math.max(1, name.length);
    }
  }
  return indexes;
}

function speakerAttributionScore(args: {
  local: string;
  matchText: string;
  fact: RecognitionConsistencyFact;
}) {
  const names = usableEntityNames([
    args.fact.characterName,
    ...(args.fact.characterAliases || []),
  ]);
  const matchKey = normalized(args.matchText);
  const matchIndex = Math.max(0, args.local.lastIndexOf(matchKey));
  let best = 0;

  for (const mention of entityMentionIndexes(args.local, names)) {
    if (mention.index <= matchIndex) {
      const between = args.local.slice(
        mention.index + mention.name.length,
        matchIndex
      );
      const subjectMarked = /^(?:은|는|이|가|도|에게서|한테서)/u.test(
        between.trimStart()
      );
      if (subjectMarked && ATTRIBUTION_CUE.test(between)) best = Math.max(best, 12);
      else if (subjectMarked && between.length <= 180) best = Math.max(best, 6);
      else if (between.length <= 80 && ATTRIBUTION_CUE.test(between)) {
        best = Math.max(best, 5);
      }
    } else {
      const after = args.local.slice(
        matchIndex + matchKey.length,
        Math.min(args.local.length, mention.index + mention.name.length + 100)
      );
      const attribution = new RegExp(
        `${escapeRegex(mention.name)}(?:은|는|이|가|도)?[^.!?。…]{0,70}[.!?。…]?$`,
        "iu"
      );
      if (attribution.test(after) && ATTRIBUTION_CUE.test(after)) {
        best = Math.max(best, 12);
      }
    }
  }
  return best;
}

function currentTurnIntroducesThirdParty(value: unknown) {
  const text = normalized(value);
  if (!text) return false;
  return /(?:새(?:로운)?|낯선|모르는|처음\s*보는|정체불명(?:의)?)\s*(?:사람|남자|여자|노인|아이|인물|손님|학생|직원)|(?:누군가|새\s*인물).{0,24}(?:나타|등장|들어오|데려오|소개)/u.test(
    text
  );
}

function passageTargetsNamedThirdParty(args: {
  local: string;
  matchText: string;
  speaker: RecognitionConsistencyFact;
  personaNames: string[];
  sceneCharacterNames: string[];
}) {
  const excluded = new Set(
    usableEntityNames([
      args.speaker.characterName,
      ...(args.speaker.characterAliases || []),
      ...args.personaNames,
    ])
  );
  const matchIndex = Math.max(0, args.local.lastIndexOf(normalized(args.matchText)));
  const targetWindow = args.local.slice(Math.max(0, matchIndex - 220), matchIndex);
  const directionalTargets = [
    ...targetWindow.matchAll(
      /[\p{L}\p{N}_]{2,30}(?:에게|한테|더러|을\s*향해|를\s*향해|쪽을\s*보며|을\s*보며|를\s*보며)/gu
    ),
  ];
  const latestDirectionalIndex = directionalTargets.length
    ? Number(directionalTargets[directionalTargets.length - 1].index || 0)
    : -1;
  for (const name of usableEntityNames(args.sceneCharacterNames)) {
    if (excluded.has(name)) continue;
    const targetPattern = new RegExp(
      `${escapeRegex(name)}(?:에게|한테|더러|을\\s*향해|를\\s*향해|쪽을\\s*보며|을\\s*보며|를\\s*보며)`,
      "giu"
    );
    const matches = [...targetWindow.matchAll(targetPattern)];
    const latestNamedIndex = matches.length
      ? Number(matches[matches.length - 1].index || 0)
      : -1;
    if (
      latestNamedIndex >= 0 &&
      (latestDirectionalIndex < 0 || latestNamedIndex >= latestDirectionalIndex)
    ) {
      return true;
    }
  }
  return false;
}

function directlyAddressesCurrentInterlocutor(value: unknown) {
  return /^(?:["“'‘]\s*)?(?:당신|너|넌|네놈|자네|그쪽)\b|^(?:["“'‘]\s*)?(?:당신|너|넌|네놈|자네|그쪽)(?:은|는|이|가|도)?\s|^(?:["“'‘]\s*)(?:대체\s*)?누구/u.test(
    normalized(value)
  );
}

export function removeRecognitionContradictionAtIndex(args: {
  text: string;
  index: number;
}) {
  const text = String(args.text || "");
  const index = Math.max(0, Math.min(text.length, Number(args.index || 0)));
  const paragraphStartMarker = text.lastIndexOf("\n\n", index);
  const start = paragraphStartMarker >= 0 ? paragraphStartMarker + 2 : 0;
  const paragraphEndMarker = text.indexOf("\n\n", index);
  const end = paragraphEndMarker >= 0 ? paragraphEndMarker : text.length;
  if (end <= start || /^\s*```/.test(text.slice(start, end))) {
    return { text: text.trim(), removed: 0 };
  }
  return {
    text: `${text.slice(0, start)}${text.slice(end)}`
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    removed: 1,
  };
}

/**
 * Resolves first-meeting language against the authoritative acquaintance IDs.
 * A user turn makes the persona the default interlocutor, so a known speaker's
 * direct second-person denial is still caught when the prose calls the persona
 * only "the old man", a role, an alias or a pronoun. Explicit named third-party
 * targets and user-authored third-party introductions remain valid exceptions.
 */
export function findRecognitionContradiction(args: {
  text: string;
  personaName: string;
  personaAliases?: string[];
  currentUserText?: string;
  sceneCharacterNames?: string[];
  recognition: RecognitionConsistencyFact[];
}): RecognitionContradiction | null {
  const story = stripFencedBlocks(args.text);
  const personaNames = usableEntityNames([
    args.personaName,
    ...(args.personaAliases || []),
  ]);
  if (!story || !personaNames.length || !args.recognition.length) return null;
  const userIntroducedThirdParty = currentTurnIntroducesThirdParty(
    args.currentUserText
  );

  for (const pattern of FIRST_MEETING_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(story))) {
      const matchedText = match[0];
      const matchedIndex = match.index;
      // Speaker attribution normally lives in the same paragraph or the one
      // immediately before a quoted line. Looking farther back can incorrectly
      // bind a legitimate "who are you?" aimed at a newly arrived third party
      // to the persona merely because both known names appeared earlier.
      const local = normalized(
        surroundingSpeakerPassage(story, matchedIndex, matchedText.length)
      );
      const scoredSpeakers = args.recognition
        .map((fact) => ({
          fact,
          score: speakerAttributionScore({ local, matchText: matchedText, fact }),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
      const speaker = scoredSpeakers[0];
      if (!speaker || speaker.score < 6) continue;

      const personaIsNamed = personaNames.some((name) => local.includes(name));
      const targetsNamedThirdParty = passageTargetsNamedThirdParty({
        local,
        matchText: matchedText,
        speaker: speaker.fact,
        personaNames,
        sceneCharacterNames: args.sceneCharacterNames || [],
      });
      if (targetsNamedThirdParty) continue;
      const defaultInterlocutorIsPersona =
        directlyAddressesCurrentInterlocutor(matchedText) &&
        !userIntroducedThirdParty;
      if (!personaIsNamed && !defaultInterlocutorIsPersona) continue;

      return {
        characterName: speaker.fact.characterName,
        matchedText,
        index: matchedIndex,
      };
    }
  }
  return null;
}

/**
 * Last-resort deterministic safety net used only if a model repair still
 * contains the same contradiction. It removes the local paragraph/line that
 * carries the invalid first-meeting claim while preserving status fences.
 */
export function removeRecognitionContradictionPassages(args: {
  text: string;
  personaName: string;
  personaAliases?: string[];
  currentUserText?: string;
  sceneCharacterNames?: string[];
  recognition: RecognitionConsistencyFact[];
}) {
  let text = String(args.text || "");
  let removed = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const contradiction = findRecognitionContradiction({
      text,
      personaName: args.personaName,
      personaAliases: args.personaAliases,
      currentUserText: args.currentUserText,
      sceneCharacterNames: args.sceneCharacterNames,
      recognition: args.recognition,
    });
    if (!contradiction) break;

    const filtered = removeRecognitionContradictionAtIndex({
      text,
      index: contradiction.index,
    });
    if (!filtered.removed) break;
    text = filtered.text;
    removed += filtered.removed;
  }

  return {
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    removed,
  };
}

/** Removes only the local contradictory prose after model repair also failed. */
export function removeScenePresenceContradictionPassages(args: {
  text: string;
  currentUserText?: string;
  presentCharacters: ScenePresenceFact[];
  excludedCharacters?: ScenePresenceFact[];
}) {
  const originalText = String(args.text || "");
  let text = originalText;
  let removed = 0;
  const characters = new Set<string>();
  const kinds = new Set<ScenePresenceContradiction["kind"]>();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const contradiction = findScenePresenceContradiction({
      text,
      currentUserText: args.currentUserText,
      presentCharacters: args.presentCharacters,
      excludedCharacters: args.excludedCharacters,
    });
    if (!contradiction) break;

    if (
      contradiction.kind === "unauthorized_exit" ||
      contradiction.kind === "unauthorized_reentry"
    ) {
      const before = text.slice(0, contradiction.index);
      const paragraphStartBreak = before.lastIndexOf("\n\n");
      const paragraphStart = paragraphStartBreak >= 0 ? paragraphStartBreak + 2 : 0;
      const after = text.slice(contradiction.index);
      const paragraphEndBreak = after.indexOf("\n\n");
      const paragraphEnd =
        paragraphEndBreak >= 0 ? contradiction.index + paragraphEndBreak : text.length;
      const localParagraph = text.slice(paragraphStart, paragraphEnd);
      const implicatedFact = args.presentCharacters.find(
        (fact) => fact.characterName === contradiction.characterName
      );
      const implicatedNames = implicatedFact
        ? usableEntityNames([
            implicatedFact.characterName,
            ...(implicatedFact.characterAliases || []),
          ])
        : [];
      const isRelationalAnonymousExit = Boolean(
        contradiction.kind === "unauthorized_exit" &&
          RELATIONAL_GENERIC_SCENE_SUBJECT_PATTERN.test(localParagraph) &&
          !passageMentionsName(localParagraph, implicatedNames)
      );

      if (isRelationalAnonymousExit) {
        // Anonymous-subject evasions are usually a self-contained opening
        // flourish. Remove that contaminated paragraph (including "only X was
        // left" consequences) while preserving later prose where the actual
        // roster is still intact.
        text = `${text.slice(0, paragraphStart).trimEnd()}\n\n${text
          .slice(paragraphEnd)
          .trimStart()}`.trim();
        removed += 1;
        characters.add(contradiction.characterName);
        kinds.add(contradiction.kind);
        continue;
      }

      // Once a draft changes the cast without user authority, every later
      // action/speaker can depend on that invalid substitution. Discard the
      // contaminated story suffix rather than leaving orphaned dialogue from
      // the wrong character. Preserve fenced status metadata independently.
      const paragraphBoundary = before.lastIndexOf("\n\n");
      const lineBoundary = before.lastIndexOf("\n");
      const cutAt = Math.max(
        0,
        paragraphBoundary >= 0 ? paragraphBoundary + 2 : lineBoundary + 1
      );
      const preservedFences = [
        ...text.slice(cutAt).matchAll(/```[^\n]*\n[\s\S]*?```/g),
      ].map((match) => match[0].trim());
      text = [text.slice(0, cutAt).trim(), ...preservedFences]
        .filter(Boolean)
        .join("\n\n");
      removed += 1;
      characters.add(contradiction.characterName);
      kinds.add(contradiction.kind);
      break;
    }

    const filtered = removeRecognitionContradictionAtIndex({
      text,
      index: contradiction.index,
    });
    if (!filtered.removed) break;
    text = filtered.text;
    removed += filtered.removed;
    characters.add(contradiction.characterName);
    kinds.add(contradiction.kind);
  }

  return {
    text: removed ? text.replace(/\n{3,}/g, "\n\n").trim() : originalText,
    removed,
    characterNames: [...characters],
    kinds: [...kinds],
  };
}
