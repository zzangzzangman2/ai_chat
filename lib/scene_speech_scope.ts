type SceneSpeaker = { characterName: string; characterAliases?: string[] };

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONTACT_REQUEST = /(?:전화|무전|통화).{0,20}(?:받|걸|듣|연결)|(?:밖|문\s*너머|옆방).{0,24}(?:누구|말해|대답|들어\s*보|들려\s*줘)|(?:모두|다들|너희|너네|각자|둘\s*다).{0,25}(?:대답|말해|말하|알려|설명)|(?:들어와|불러와|데려와)/u;
const REMOTE_SPEECH = /(?:문\s*밖|문(?:짝)?[^.!?\n]{0,16}(?:너머|사이)|옆\s*방|다른\s*방)[^.!?\n]{0,100}(?:말(?:했|하|을)|외(?:쳤|치)|대답|재촉|타이르|호소|목소리)/u;
const SPEECH_CUE = /(?:말(?:했|하|을)|외(?:쳤|치)|대답|재촉|타이르|호소|거들|목소리)/u;

function userAddressesSpeaker(text: string, names: string[]) {
  return names.some((name) => new RegExp(
    `${escapeRegex(name)}(?:아|야)(?:[\\s,.!?~…]|$)|${escapeRegex(name)}(?:은|는|이|가|도)?\\s*(?:말해|대답|설명|알려|들어와|돌아와)`, "iu"
  ).test(text));
}

/** Remove only attributed, unsolicited off-scene contributions. Mere references
 * to absent people, local dialogue, requested remote contact and metadata stay.
 * contextText supplies prior raw paragraphs when called by the paragraph gate. */
export function removeUnrequestedOffSceneSpeech(args: {
  text: string;
  contextText?: string;
  offSceneCharacters: SceneSpeaker[];
  currentUserText?: string;
  allowExternalContact?: boolean;
}) {
  const text = String(args.text || "");
  const currentUserText = String(args.currentUserText || "");
  if (args.allowExternalContact || CONTACT_REQUEST.test(currentUserText)) return { text, removed: 0 };
  const allowedSubjects: RegExp[] = [];
  const subjects = args.offSceneCharacters.flatMap((speaker) => {
    const names = [...new Set([speaker.characterName, ...(speaker.characterAliases || [])])]
      .map((name) => name.trim()).filter((name) => name.length >= 2);
    const patterns = names.flatMap((name) => [
      new RegExp(`${escapeRegex(name)}(?:은|는|이|가|도)`, "iu"),
      new RegExp(`${escapeRegex(name)}의[^.!?\\n]{0,20}(?:목소리|말(?:이|은|에|을)|재촉|대답|외침)`, "iu"),
    ]);
    if (userAddressesSpeaker(currentUserText, names)) {
      allowedSubjects.push(...patterns);
      return [];
    }
    return patterns;
  });
  let blockedSpeaker = false;
  let inFence = false;
  let removed = 0;
  const isOutside = (narration: string) => {
    if (allowedSubjects.some((pattern) => pattern.test(narration))) return false;
    const recollection = /(?:회상|떠올|기억(?:했|하며|을)|지난날|예전에|인용)/u.test(narration);
    if (!recollection && subjects.some((pattern) => pattern.test(narration))) return true;
    const listening = /(?:소리|목소리|기척).{0,20}(?:듣|들으|들었|고개|귀를)/u.test(narration);
    return !listening && !recollection && REMOTE_SPEECH.test(narration);
  };
  const process = (source: string, emit: boolean) => source.split(/(\r?\n[\t ]*\r?\n+)/u).map((part) => {
    if (!part.trim()) return emit ? part : "";
    const fenceCount = (part.match(/```/g) || []).length;
    if (inFence || fenceCount) {
      if (fenceCount % 2) inFence = !inFence;
      return emit ? part : "";
    }
    const dialogue = /^["“]/u.test(part.trimStart());
    const narration = part.replace(/["“][\s\S]*?["”]/gu, " ");
    const outside = isOutside(narration);
    // A background attendance list appended to a local paragraph must not take
    // ownership of the local character's next line. Remove only its sentences.
    if (!dialogue && outside && /^\s*\*[\s\S]*\*\s*$/u.test(part)) {
      const inner = part.trim().slice(1, -1);
      const sentences = inner.split(/(?<=[.!?。！？])\s+/u);
      const kept = sentences.filter((sentence) => !isOutside(sentence));
      if (kept.length && kept.length < sentences.length) {
        const last = sentences.at(-1) || "";
        blockedSpeaker = isOutside(last) && SPEECH_CUE.test(last);
        if (emit) removed += sentences.length - kept.length;
        return emit ? `*${kept.join(" ")}*` : "";
      }
    }
    if (allowedSubjects.some((pattern) => pattern.test(narration))) blockedSpeaker = false;
    else if (outside) blockedSpeaker = true;
    else if (!dialogue && !/^\s*\*?\s*(?:그녀|그는|그가|그들|그녀들|그의|그녀의|그들의)/u.test(part)) blockedSpeaker = false;
    if (blockedSpeaker) {
      if (emit) removed += 1;
      return "";
    }
    return emit ? part : "";
  }).join("");
  process(String(args.contextText || ""), false);
  const result = process(text, true);
  return { text: removed ? result.replace(/\n{3,}/g, "\n\n") : text, removed };
}
