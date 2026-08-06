export type RecognitionConsistencyFact = {
  characterId: string;
  characterName: string;
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
  /(?:당신|너|그쪽|저\s*(?:사람|남자|여자|노인|늙은이|사내|아이|인물)|이\s*(?:사람|남자|여자|노인|늙은이|사내|아이|인물))\s*(?:은|는)?\s*(?:대체\s*)?(?:누구(?:야|냐|세요|십니까|지)?|누군데|뭐(?:야|냐|죠|지|입니까)|뭡니까|정체가\s*뭐(?:야|냐|죠|지|입니까)|뭐\s*하는\s*사람(?:이야|이냐|입니까)?)/giu,
  /(?:처음\s*(?:보는|본|만나는|만난)|초면(?:인|인데|이군|이네)?|생전\s*처음\s*보는)\s*(?:사람|남자|여자|노인|늙은이|사내|아이|얼굴|상대|인물)?/giu,
  /(?:낯선|모르는)\s*(?:사람|남자|여자|노인|늙은이|사내|아이|얼굴|상대|인물)/giu,
  /(?:본|만난|마주친)\s*적(?:이)?\s*(?:없|없는)/giu,
] as const;

function normalized(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase("ko-KR");
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

/**
 * Finds explicit first-meeting language only when the same local passage names
 * both an already-known character and the persona. Requiring both names keeps a
 * known character free to ask who an actually new third party is.
 */
export function findRecognitionContradiction(args: {
  text: string;
  personaName: string;
  recognition: RecognitionConsistencyFact[];
}): RecognitionContradiction | null {
  const story = stripFencedBlocks(args.text);
  const personaKey = normalized(args.personaName);
  if (!story || !personaKey || !args.recognition.length) return null;

  for (const pattern of FIRST_MEETING_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(story))) {
      // Speaker attribution normally lives in the same paragraph or the one
      // immediately before a quoted line. Looking farther back can incorrectly
      // bind a legitimate "who are you?" aimed at a newly arrived third party
      // to the persona merely because both known names appeared earlier.
      const local = normalized(
        surroundingSpeakerPassage(story, match.index, match[0].length)
      );
      if (!local.includes(personaKey)) continue;

      for (const fact of args.recognition) {
        const characterKey = normalized(fact.characterName);
        if (!characterKey || !local.includes(characterKey)) continue;
        return {
          characterName: fact.characterName,
          matchedText: match[0],
          index: match.index,
        };
      }
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
  recognition: RecognitionConsistencyFact[];
}) {
  let text = String(args.text || "");
  let removed = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const contradiction = findRecognitionContradiction({
      text,
      personaName: args.personaName,
      recognition: args.recognition,
    });
    if (!contradiction) break;

    const paragraphStartMarker = text.lastIndexOf("\n\n", contradiction.index);
    const start = paragraphStartMarker >= 0 ? paragraphStartMarker + 2 : 0;
    const paragraphEndMarker = text.indexOf("\n\n", contradiction.index);
    const end = paragraphEndMarker >= 0 ? paragraphEndMarker : text.length;
    if (end <= start || /^\s*```/.test(text.slice(start, end))) break;

    text = `${text.slice(0, start)}${text.slice(end)}`;
    removed += 1;
  }

  return {
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    removed,
  };
}
