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
