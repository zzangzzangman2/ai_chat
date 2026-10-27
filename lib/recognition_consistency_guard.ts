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
    | "unauthorized_incapacitation"
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

const INCAPACITATION_CUE_PATTERN =
  /(?:기절(?:했|해버렸|하고\s*말았|한\s*채)|혼절(?:했|해버렸|하고\s*말았|한\s*채)|실신(?:했|해버렸|하고\s*말았|한\s*채)|의식을\s*잃(?:었|어버렸|고\s*말았|은\s*채)|정신을\s*잃(?:었|어버렸|고\s*말았|은\s*채)|의식불명(?:이\s*됐|이\s*되었|인\s*채)|잠들어버렸|마비(?:됐|되어버렸)|발화\s*불능(?:이\s*됐|인\s*채))/u;

const INCAPACITATION_MODIFIER_CUE_PATTERN =
  /(?:기절한|혼절한|실신한|의식을\s*잃은|정신을\s*잃은|의식불명인|잠들어버린|마비된|발화\s*불능인)/u;

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

// These are relative locations outside the current viewpoint, not remembered
// residences. A voice through a door is not physical co-presence.
const OFF_SCENE_LOCATION = /(?:옆\s*방|다른\s*방|건넛\s*방|건너편\s*방|문\s*밖|현장\s*밖|멀리\s*떨어진\s*[가-힣]+|먼\s*(?:곳|마을|도시))/gu;
const PERCEPTION_BRIDGE = /(?:소리|목소리|기척|울음|비명|전언|연락|메시지|전화|무전)|(?:들려|들리|들었|들으|듣고|전해)/u;
const ROOM_LOCATION = /^(?:안방|침실|서재|거실|회의실|객실|병실|방)$/u;
const OUTSIDE_ROOM_LOCATION = /(?:툇마루|마당|담장|복도|문(?:짝)?[^.!?。！？\n]{0,16}(?:사이|너머|건너))/gu;
const LOCAL_ROOM_ANCHOR = /(?:방\s*안|실내|책상|탁자|침대|창가|내\s*곁)(?:에서|에|으로|의|옆|\s)/u;

function userSceneMove(text: string, identities: ScenePresenceIdentity[]) {
  if (/(?:가지|들어가지|이동하지|옮기지)\s*(?:마|말|않)|(?:가면|들어가면)\s*안/u.test(text)) return "";
  const move = /(?:안방|침실|서재|거실|회의실|객실|병실|옆방|다른\s*방|마당|광장|식당|방)(?:으로|로)\s*(?:가자|가서|가겠|이동하|이동했|들어가|들어갔|옮겨)/u.exec(text);
  if (!move) return "";
  const prefix = text.slice(0, move.index);
  if (identities.some((identity) => usableEntityNames([identity.name, ...(identity.aliases || [])]).some(
    (name) => new RegExp(`${escapeRegex(name)}(?:은|는|이|가)[^.!?。！？]*$`, "iu").test(prefix)
  ))) return "";
  return move[0].split(/(?:으로|로)/u)[0].replace(/\s/g, "");
}

function sceneNarrationOnly(value: string) {
  // Speech can mention someone elsewhere or describe a plan. Neither establishes
  // that person's location. Preserve paragraph boundaries for narrated evidence.
  return value.replace(/["“][\s\S]*?["”]/gu, (speech) => speech.replace(/[^\n]/gu, " "));
}

function offSceneSubjects(passage: string, identities: ScenePresenceIdentity[], viewpointLocation: string) {
  const subjects: { name: string; start: number; end: number }[] = [];
  for (const identity of identities) {
    for (const name of usableEntityNames([identity.name, ...(identity.aliases || [])])) {
      const pattern = new RegExp(`${escapeRegex(name)}(?:은|는|이|가|도|와|과|(?=\\s*[,，]))`, "giu");
      for (const match of passage.matchAll(pattern)) {
        subjects.push({ name: normalized(identity.name), start: match.index!, end: match.index! + match[0].length });
      }
    }
  }
  subjects.sort((a, b) => a.start - b.start || b.end - a.end);
  const locations = [
    ...passage.matchAll(OFF_SCENE_LOCATION),
    ...(ROOM_LOCATION.test(viewpointLocation) ? passage.matchAll(OUTSIDE_ROOM_LOCATION) : []),
  ].filter(
    (match) => normalized(match[0]).replace(/\s/g, "") !== viewpointLocation
  );
  const result = new Set<string>();
  for (const subject of subjects) {
    const nextSubject = subjects.find((other) => other.start > subject.start);
    for (const location of locations) {
      const start = location.index!;
      // A local listener after "문밖에서 들려오는 소리에" stays local. A named
      // object ("설영을 타이르며") is not a second speaker outside the door.
      if (start < subject.start) {
        const between = passage.slice(start + location[0].length, subject.start);
        if (!PERCEPTION_BRIDGE.test(between) &&
            !(ROOM_LOCATION.test(viewpointLocation) && (LOCAL_ROOM_ANCHOR.test(between) || between.includes(viewpointLocation)))) result.add(subject.name);
      } else if (start >= subject.end && start < (nextSubject?.start ?? passage.length)) {
        const clause = passage.slice(subject.end, nextSubject?.start);
        if (!PERCEPTION_BRIDGE.test(clause)) result.add(subject.name);
      }
    }
  }
  return result;
}

function requestedSceneLocation(passage: string, identities: ScenePresenceIdentity[]) {
  if (/(?:가지|들어가지|이동하지|보여\s*주지|전환하지|바꾸지|쓰지|넣지|다루지)\s*(?:마|말|않)/u.test(passage)) return "";
  const location = [...passage.matchAll(OFF_SCENE_LOCATION)][0];
  if (!location) return "";
  if (/시점\s*(?:을|으로|은|:)|장면\s*전환/u.test(passage)) return location[0];
  // Moving an NPC elsewhere is not a camera/user move to that NPC's room.
  if (!/가서|이동(?:한다|했다|하자)|들어가(?:서|자)/u.test(passage)) return "";
  const prefix = passage.slice(0, location.index);
  if (identities.some((identity) => passageMentionsName(prefix, usableEntityNames([identity.name, ...(identity.aliases || [])])))) return "";
  return location[0];
}

/**
 * Reconstructs only high-confidence transient scene presence from recent raw
 * turns. This deliberately does not use residence or long-memory locations:
 * present/absent is a short-lived scene fact and must be cleared by an exit or
 * an explicit time/location cut.
 */
export function deriveCurrentSceneState(args: {
  messages: ScenePresenceMessage[];
  identities: ScenePresenceIdentity[];
  maxMessages?: number;
}): { present: ScenePresenceFact[]; offScene: ScenePresenceFact[]; location: string } {
  const identities = args.identities
    .map((identity) => ({
      characterName: String(identity.name || "").trim(),
      characterAliases: usableEntityNames(identity.aliases || []),
    }))
    .filter((identity) => normalized(identity.characterName).length >= 2);
  const requestedMax = Number(args.maxMessages || 14);
  const maxMessages = Number.isFinite(requestedMax)
    ? Math.max(2, Math.floor(requestedMax))
    : 14;
  const messages = args.messages || [];
  let lastMove = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (normalized(messages[index]?.role) === "user" &&
        userSceneMove(sceneNarrationOnly(stripFencedBlocks(messages[index]?.content)), args.identities)) {
      lastMove = index;
      break;
    }
  }
  // Keep the current room's boundary even after it scrolls out of the recent
  // prompt window. An unnamed follow-up cannot bring the previous room along.
  const recent = messages.slice(lastMove >= 0 ? lastMove : -maxMessages);
  const states = new Map<string, ScenePresenceFact>();
  const outside = new Map<string, ScenePresenceFact>();
  const userPlacedHere = new Set<string>();
  let latestUserText = "";
  let viewpointLocation = "";
  if (lastMove > 0) {
    const previous = deriveCurrentSceneState({
      ...args,
      messages: messages.slice(Math.max(0, lastMove - maxMessages), lastMove),
    });
    const moveText = sceneNarrationOnly(stripFencedBlocks(messages[lastMove].content));
    const destination = userSceneMove(moveText, args.identities);
    const bringsGroup = /(?:모두|다\s*같이|다들|전부).{0,24}(?:가자|이동|들어가)/u.test(moveText);
    for (const fact of [...previous.offScene, ...previous.present]) {
      const invited = bringsGroup || usableEntityNames([fact.characterName, ...fact.characterAliases])
        .some((name) => new RegExp(`${escapeRegex(name)}(?:와|과|랑|이랑|아|야)`, "iu").test(moveText));
      if (!invited && !fact.evidence.includes(destination)) outside.set(normalized(fact.characterName), fact);
    }
  }

  recent.forEach((message, messageIndex) => {
    const story = stripFencedBlocks(message?.content || "");
    if (!story.trim()) return;
    const isUserMessage = normalized(message?.role) === "user";
    if (isUserMessage) latestUserText = story;
    let remoteViewpoint = false;

    for (const passage of splitStoryPassages(sceneNarrationOnly(story))) {
      const requestedLocation = isUserMessage
        ? userSceneMove(passage, args.identities) || requestedSceneLocation(passage, args.identities)
        : "";
      const returnsToOriginal = isUserMessage && /원래\s*(?:방|장소|현장).{0,12}돌아/u.test(passage);
      if (SCENE_RESET_PATTERN.test(passage) || requestedLocation || returnsToOriginal) {
        states.clear();
        if (!(lastMove >= 0 && messageIndex === 0 && requestedLocation)) outside.clear();
        userPlacedHere.clear();
        viewpointLocation = normalized(requestedLocation).replace(/\s/g, "");
        remoteViewpoint = false;
      }
      const remoteSubjects = offSceneSubjects(passage, args.identities, viewpointLocation);
      if (remoteSubjects.size) remoteViewpoint = true;
      else if (ROOM_LOCATION.test(viewpointLocation) && (LOCAL_ROOM_ANCHOR.test(passage) || passage.includes(viewpointLocation))) remoteViewpoint = false;
      else if (PERCEPTION_BRIDGE.test(passage) && [...passage.matchAll(OFF_SCENE_LOCATION)].length) remoteViewpoint = false;
      else if ([...states.values()].some((fact) =>
        usableEntityNames([fact.characterName, ...fact.characterAliases]).some((name) =>
          new RegExp(`${escapeRegex(name)}(?:은|는|이|가)`, "iu").test(passage)
        )
      )) remoteViewpoint = false;
      for (const identity of identities) {
        const names = usableEntityNames([
          identity.characterName,
          ...identity.characterAliases,
        ]);
        if (!passageMentionsName(passage, names)) continue;
        const key = normalized(identity.characterName);
        const fact = {
          characterName: identity.characterName,
          characterAliases: identity.characterAliases,
          evidence: compactEvidence(passage),
          messageIndex,
        };

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
            states.delete(key);
            outside.set(key, fact);
            userPlacedHere.delete(key);
          }
          continue;
        }

        const entered = Boolean(findNamedEntryCue(passage, names));
        const entersFromOutside = entered && (
          /(?:옆\s*방|문\s*밖|툇마루|마당|복도)에서[^.!?。！？\n]{0,60}(?:이\s*방|방\s*안|안으로|현재\s*현장|곁으로)/u.test(passage) ||
          Boolean(viewpointLocation && new RegExp(`(?:옆\\s*방|문\\s*밖|툇마루|마당|복도)에서[^.!?。！？\\n]{0,60}${escapeRegex(viewpointLocation)}(?:으로|로)`, "u").test(passage))
        );
        if (remoteSubjects.has(key) && !entersFromOutside) {
          // Explicit user placement wins over a later model cutaway. Otherwise
          // a static location outside the door corrects earlier ambiguous prose.
          if (isUserMessage || !userPlacedHere.has(key)) {
            states.delete(key);
            outside.set(key, fact);
            userPlacedHere.delete(key);
          }
          continue;
        }

        if (!entered && !passageShowsActivePresence(passage, names)) continue;
        if (remoteViewpoint && !states.has(key) && !entered && !isUserMessage) {
          outside.set(key, fact);
          continue;
        }
        // Later dialogue/action in the same cutaway cannot silently bring an
        // off-scene person back. A real entry or new user placement can.
        if (outside.has(key) && !entered && !isUserMessage) continue;
        outside.delete(key);
        if (isUserMessage) userPlacedHere.add(key);

        states.set(key, fact);
      }
    }
  });

  return { present: [...states.values()], offScene: [...outside.values()], location: viewpointLocation };
}

export function deriveCurrentScenePresence(args: {
  messages: ScenePresenceMessage[];
  identities: ScenePresenceIdentity[];
  maxMessages?: number;
}): ScenePresenceFact[] {
  return deriveCurrentSceneState(args).present;
}

function findNamedIncapacitationCue(passage: string, names: string[]) {
  return findNamedDirectionalCue({
    passage,
    names,
    cue: INCAPACITATION_CUE_PATTERN,
    modifierCue: INCAPACITATION_MODIFIER_CUE_PATTERN,
  });
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

function currentTurnAllowsIncapacitation(value: unknown, names: string[]) {
  const text = String(value || "");
  if (!text.trim() || !passageMentionsName(text, names)) return false;
  if (/(?:기절|혼절|실신|의식|정신|잠|마비|발화)[^.!?。！？\n]{0,18}(?:하지\s*마|말고|아니|않)/u.test(text)) {
    return false;
  }
  return Boolean(findNamedIncapacitationCue(text, names)) ||
    /(?:기절해|기절시켜|재워|의식을\s*잃게\s*해|정신을\s*잃게\s*해)/u.test(text);
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
  // Keep offsets into the original text even when a status fence precedes prose.
  const story = String(args.text || "").replace(
    /```[^\n]*\n[\s\S]*?```|```[\s\S]*$/g,
    (fence) => fence.replace(/[^\n]/g, " ")
  );
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

      if (!currentTurnAllowsIncapacitation(args.currentUserText, names)) {
        const incapacitation = findNamedIncapacitationCue(passage, names);
        if (incapacitation) {
          return {
            characterName: fact.characterName,
            matchedText: incapacitation[0],
            index: Math.max(0, passageIndex) + incapacitation.index,
            kind: "unauthorized_incapacitation",
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

function removeLegacySceneFiller(value: string) {
  let removed = 0;
  let inFence = false;
  const text = value.split("\n").filter((line) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return true;
    }
    if (inFence) return true;
    // Match only the old generated narration, never quoted dialogue or a
    // legitimate sentence which merely happens to say someone stayed.
    if (/^\s*\*[^*\n]+ 역시 (?:자리를 벗어나지 않고|깨어 있는 채) 현재 장면에 그대로 남아, 이어지는 상황에 반응했다\.\*\s*$/u.test(line)) {
      removed += 1;
      return false;
    }
    return true;
  }).join("\n");
  return { text, removed };
}

function removeSceneBeat(args: {
  text: string;
  index: number;
  anonymousExit: boolean;
}) {
  const { text, index } = args;
  let start = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  let end = lineEnd < 0 ? text.length : lineEnd;
  let narration = false;
  for (const match of text.matchAll(/\*([^*]+)\*/gu)) {
    const innerStart = match.index + 1;
    const innerEnd = innerStart + match[1].length;
    if (index >= innerStart && index < innerEnd) {
      start = innerStart;
      end = innerEnd;
      narration = true;
      break;
    }
  }
  const body = text.slice(start, end);
  let offset = 0;
  let found = false;
  const kept = body.split(/(?<=[.!?。！？])\s+|\n+/u).filter((sentence) => {
    const sentenceStart = body.indexOf(sentence, offset);
    offset = sentenceStart + sentence.length;
    if (index >= start + sentenceStart && index < start + offset) {
      found = true;
      return false;
    }
    // "Only X remained" in the same beat depends on the anonymous departure.
    return !(
      found && args.anonymousExit &&
      /(?:오직|홀로|혼자)[^.!?。！？\n]*(?:남겨졌|남았|남게)/u.test(sentence)
    );
  });
  if (!found) return text;
  const bodyAfter = kept.join(" ").trim();
  const replacement = narration && bodyAfter ? `*${bodyAfter}*` : bodyAfter;
  return text.slice(0, narration ? start - 1 : start) +
    replacement + text.slice(narration ? end + 1 : end);
}

/** Removes contradictory prose without inventing stock replacement narration. */
export function removeScenePresenceContradictionPassages(args: {
  text: string;
  currentUserText?: string;
  presentCharacters: ScenePresenceFact[];
  excludedCharacters?: ScenePresenceFact[];
}) {
  const originalText = String(args.text || "");
  // Earlier turns may already contain the old template, which the model can echo.
  const legacy = removeLegacySceneFiller(originalText);
  let text = legacy.text;
  let removed = legacy.removed;
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
      contradiction.kind === "unauthorized_incapacitation" ||
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

      if (
        contradiction.kind === "unauthorized_incapacitation" ||
        contradiction.kind === "unauthorized_exit" ||
        isRelationalAnonymousExit
      ) {
        // Preserve valid sentences, dialogue and status metadata around the
        // invalid beat. Do not replace it with a repeated invented reaction.
        const filtered = removeSceneBeat({
          text,
          index: contradiction.index,
          anonymousExit: isRelationalAnonymousExit,
        });
        if (filtered === text) break;
        text = filtered;
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
