export type CharacterEventType = "action" | "relation";

export type CharacterTurnEvent = {
  sourceRole: "user" | "assistant";
  eventType: CharacterEventType;
  actor: string;
  target: string;
  action: string;
  evidence: string;
  confidence: number;
};

const RELATION_KEYWORDS = [
  "관계",
  "감정",
  "신뢰",
  "혐오",
  "경멸",
  "적대",
  "동료",
  "살의",
  "제거 대상",
  "변화",
  "고착",
  "진입",
  "분류",
  "재분류",
];

const NAME_STOPWORDS = new Set([
  "사용자",
  "유저",
  "어시스턴트",
  "assistant",
  "system",
  "정보",
  "상태",
  "요약",
  "턴",
  "현재",
  "직전",
  "관계",
  "대상",
  "행동",
  "주인공",
  "상대",
  "그",
  "그녀",
  "그들",
  "너",
  "당신",
  "축구선수",
  "코치",
  "선수",
  "부원",
  "모드",
  "unknown",
  "narrator",
  "동료",
  "멀리",
  "저기",
  "여기",
  "누구",
  "모두",
  "팀",
  "팀원",
]);

const GENERIC_TARGET_WORDS = new Set([
  "동료",
  "상대",
  "적",
  "팀",
  "팀원",
  "사람",
  "누구",
  "모두",
  "멀리",
  "저기",
  "여기",
]);

const ACTOR_ROLE_WORDS = new Set([
  "어머니",
  "아버지",
  "누나",
  "형",
  "코치",
  "의사",
  "기사",
]);

const ACTOR_NOUN_BLOCKLIST = new Set([
  "신호음",
  "목소리",
  "운동장",
  "소리",
  "정적",
  "표정",
  "그림자",
  "세단",
  "수행기사",
  "체중",
  "시야",
  "공기",
  "침묵",
  "분필",
  "통증",
  "붓기",
  "열망",
]);

const KOREAN_SURNAMES = new Set([
  "김",
  "이",
  "박",
  "최",
  "정",
  "강",
  "조",
  "윤",
  "장",
  "임",
  "한",
  "오",
  "서",
  "신",
  "권",
  "황",
  "안",
  "송",
  "전",
  "홍",
  "유",
  "고",
  "문",
  "양",
  "손",
  "배",
  "조",
  "백",
  "허",
  "남",
  "심",
  "노",
  "하",
  "곽",
  "성",
  "차",
  "주",
  "우",
]);

function esc(s: string) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanInlineText(input: string) {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`+/g, "")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cut(s: string, max: number) {
  const t = cleanInlineText(s);
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd();
}

function looksLikeName(token: string) {
  const t = String(token || "").trim();
  if (!t) return false;
  if (t.length < 2 || t.length > 24) return false;
  const low = t.toLowerCase();
  if (NAME_STOPWORDS.has(t) || NAME_STOPWORDS.has(low)) return false;
  return /^[가-힣A-Za-z][가-힣A-Za-z0-9_-]*(?:\s+[가-힣A-Za-z][가-힣A-Za-z0-9_-]*)?$/.test(t);
}

function normalizeName(token: string) {
  return String(token || "")
    .trim()
    .replace(/^[\s"'`([{]+/, "")
    .replace(/[\s"'`)\]}:;,.!?]+$/, "");
}

function detectRelation(line: string) {
  const t = String(line || "");
  for (const kw of RELATION_KEYWORDS) {
    if (t.includes(kw)) return true;
  }
  return false;
}

function findKnownNameInText(text: string, knownNames: string[]) {
  const src = String(text || "");
  for (const name of knownNames) {
    if (!name) continue;
    const re = new RegExp(`(?:^|[\\s"'(])${esc(name)}(?=[\\s"'),.?!]|$)`);
    if (re.test(src)) return name;
  }
  return "";
}

function addKnownName(set: Set<string>, token: string) {
  const name = normalizeName(token || "");
  if (!looksLikeName(name)) return;
  set.add(name);
}

function isGenericTargetWord(token: string) {
  const t = normalizeName(token || "");
  if (!t) return true;
  return GENERIC_TARGET_WORDS.has(t) || GENERIC_TARGET_WORDS.has(t.toLowerCase());
}

function isLikelyActorToken(token: string, knownNames: string[], knownActorOnly: boolean) {
  const tok = normalizeName(token || "");
  if (!tok || !looksLikeName(tok)) return false;
  if (knownNames.includes(tok)) return true;
  if (ACTOR_ROLE_WORDS.has(tok)) return true;
  if (knownActorOnly) return false;
  if (ACTOR_NOUN_BLOCKLIST.has(tok)) return false;
  if (/^[A-Za-z][A-Za-z0-9_-]{1,23}$/.test(tok)) return true;
  if (/^[가-힣]{3}$/.test(tok) && KOREAN_SURNAMES.has(tok[0])) return true;
  return false;
}

function findActorByParticle(text: string, knownNames: string[], knownActorOnly: boolean) {
  const src = String(text || "");
  const re =
    /(?:^|[\s("'“”])([가-힣A-Za-z][가-힣A-Za-z0-9_-]{1,15})(?:은|는|이|가|도|께서)(?=$|[\s"'`),.?!…])/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(src)) !== null) {
    const tok = normalizeName(m?.[1] || "");
    if (!tok) continue;
    if (!isLikelyActorToken(tok, knownNames, knownActorOnly)) continue;
    return tok;
  }
  const m2 = src.match(
    /(?:^|[\s("'“”])([가-힣A-Za-z][가-힣A-Za-z0-9_-]{1,15})(?:에게서|에게|한테서|한테)(?=$|[\s"'`),.?!…])/
  );
  const tok2 = normalizeName(m2?.[1] || "");
  if (tok2 && isLikelyActorToken(tok2, knownNames, knownActorOnly)) return tok2;
  return "";
}

function findExplicitSpeaker(line: string) {
  const m = String(line || "").match(/^([^|\n]{1,24})\s*\|\s*(.+)$/);
  if (!m) return null;
  const speaker = normalizeName(m[1] || "");
  if (!looksLikeName(speaker)) return null;
  return { speaker, body: String(m[2] || "").trim() };
}

function findColonSpeaker(line: string) {
  const m = String(line || "").match(/^\[?([^\]\n:]{1,24})\]?\s*[:：]\s*(.+)$/);
  if (!m) return null;
  const speaker = normalizeName(m[1] || "");
  if (!looksLikeName(speaker)) return null;
  return { speaker, body: String(m[2] || "").trim() };
}

function findRoleSpeaker(line: string, npcName: string) {
  const m = String(line || "").match(/^\[?([^\]\n:]{1,24})\]?\s*[:：]\s*(.+)$/);
  if (!m) return null;
  const raw = normalizeName(m[1] || "");
  const npc = normalizeName(npcName || "");
  const roleLike = new Set(["축구선수", "코치", "선수", "부원", "상대", "npc"]);
  if (!roleLike.has(raw) && !roleLike.has(raw.toLowerCase())) return null;
  if (npc && looksLikeName(npc)) {
    return { speaker: npc, body: String(m[2] || "").trim() };
  }
  // npcName이 비어 있으면 역할명을 화자로 유지해 과거 턴이 누락되지 않게 한다.
  return { speaker: raw, body: String(m[2] || "").trim() };
}

function parseTaggedLine(line: string) {
  const src = String(line || "").trim();
  const m = src.match(/^\[(행동|관계)\]\s*(.+)$/);
  if (!m) return { body: src, forcedType: "" as CharacterEventType | "" };
  const forcedType: CharacterEventType = m[1] === "관계" ? "relation" : "action";
  return { body: String(m[2] || "").trim(), forcedType };
}

function findArrowSpeaker(line: string) {
  const m = String(line || "").match(/^([가-힣A-Za-z][가-힣A-Za-z0-9_ -]{0,23})\s*->\s*([가-힣A-Za-z][가-힣A-Za-z0-9_ -]{0,23})\s*[:：]\s*(.+)$/);
  if (!m) return null;
  const speaker = normalizeName(m[1] || "");
  const target = normalizeName(m[2] || "");
  if (!looksLikeName(speaker) || !looksLikeName(target) || speaker === target) return null;
  return { speaker, target, body: String(m[3] || "").trim() };
}

function shouldSkipLine(line: string) {
  const t = String(line || "").trim();
  if (!t) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^\[?(INFO|STATUS|STREAM)\]?[:：]/i.test(t)) return true;
  if (/^\[\s*모드\s*[:：]/.test(t)) return true;
  if (/^T\d+\b/i.test(t)) return true;
  if (/^\d+\.\s/.test(t)) return true;
  if (/^(?:[-*•]\s+|\d+\)\s+)/.test(t)) return true;
  if (/어떤 선택을 하겠는가|선택의 시간/.test(t)) return true;
  if (/가능성\)|소폭 상승 가능|회복률/.test(t)) return true;
  return false;
}

function inferTarget(text: string, actor: string, knownNames: string[]) {
  const src = String(text || "");
  const voc = src.match(/(?:^|[\s"'(])(?:야|저기|어이)\s*[,! ]*\s*([가-힣A-Za-z][가-힣A-Za-z0-9_-]{1,15})/);
  const vocTok = normalizeName(voc?.[1] || "");
  if (vocTok && vocTok !== actor && looksLikeName(vocTok) && !isGenericTargetWord(vocTok)) return vocTok;

  for (const name of knownNames) {
    if (!name || name === actor) continue;
    if (isGenericTargetWord(name)) continue;
    if (new RegExp(`(?:^|[\\s"'(])${esc(name)}(?=[\\s"'),.?!]|$)`).test(src)) return name;
  }
  const m = src.match(
    /(?:^|[\s("'“”])([가-힣A-Za-z][가-힣A-Za-z0-9_-]{1,15})(?:에게|한테|에 대한)(?=$|[\s"'`),.?!…])/
  );
  const tok = normalizeName(m?.[1] || "");
  if (!tok || tok === actor || !looksLikeName(tok) || isGenericTargetWord(tok)) return "";
  return tok;
}

function toKnownNames(personaName?: string, npcName?: string) {
  const set = new Set<string>();
  const p = normalizeName(personaName || "");
  const n = normalizeName(npcName || "");
  if (looksLikeName(p)) set.add(p);
  if (looksLikeName(n)) set.add(n);
  return [...set].sort((a, b) => b.length - a.length);
}

function mergeKnownNames(base: string[], extra: string[]) {
  const set = new Set<string>();
  for (const n of base) addKnownName(set, n);
  for (const n of extra) addKnownName(set, n);
  return [...set].sort((a, b) => b.length - a.length);
}

function buildUserEvent(userText: string, personaName: string, knownNames: string[]): CharacterTurnEvent | null {
  const action = cut(userText, 180);
  if (!action) return null;
  const actor = looksLikeName(personaName) ? personaName : "사용자";
  const target = inferTarget(action, actor, knownNames);
  return {
    sourceRole: "user",
    eventType: "action",
    actor,
    target,
    action,
    evidence: action,
    confidence: 100,
  };
}

export function extractCharacterTurnEvents(args: {
  userText?: string;
  assistantText: string;
  personaName?: string;
  npcName?: string;
  knownNames?: string[];
  knownActorOnly?: boolean;
  maxEvents?: number;
  includeUserEvent?: boolean;
}): CharacterTurnEvent[] {
  const userText = String(args.userText || "").trim();
  const assistantText = String(args.assistantText || "").trim();
  const personaName = normalizeName(args.personaName || "");
  const npcName = normalizeName(args.npcName || "");
  const extraKnownNames = Array.isArray(args.knownNames) ? args.knownNames.map((x) => normalizeName(String(x || ""))) : [];
  const maxEvents = Math.max(4, Math.min(48, Math.floor(Number(args.maxEvents) || 24)));
  const includeUserEvent = Boolean(args.includeUserEvent);
  const knownActorOnly = Boolean(args.knownActorOnly);

  const knownNameSet = new Set<string>(mergeKnownNames(toKnownNames(personaName, npcName), extraKnownNames));
  const initialKnownNames = [...knownNameSet].sort((a, b) => b.length - a.length);
  const events: CharacterTurnEvent[] = [];

  if (includeUserEvent) {
    const userEvent = buildUserEvent(userText, personaName, initialKnownNames);
    if (userEvent) events.push(userEvent);
  }

  let lastExplicitSpeaker = "";
  const seen = new Set<string>();
  const lines = assistantText
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, "\n")
    .split("\n")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    if (events.length >= maxEvents) break;
    if (shouldSkipLine(rawLine)) continue;

    const tagged = parseTaggedLine(rawLine);
    let body = tagged.body;
    let actor = "";
    let targetFromSpeaker = "";
    let confidence = 20;

    const explicit = findExplicitSpeaker(body);
    const byArrow = explicit ? null : findArrowSpeaker(body);
    const byColon = explicit || byArrow ? null : findColonSpeaker(body);
    const byRole = explicit || byArrow || byColon ? null : findRoleSpeaker(body, npcName);
    if (explicit) {
      lastExplicitSpeaker = explicit.speaker;
      actor = explicit.speaker;
      body = explicit.body;
      confidence = 95;
      addKnownName(knownNameSet, explicit.speaker);
    } else if (byArrow) {
      lastExplicitSpeaker = byArrow.speaker;
      actor = byArrow.speaker;
      targetFromSpeaker = byArrow.target;
      body = byArrow.body;
      confidence = 97;
      addKnownName(knownNameSet, byArrow.speaker);
      addKnownName(knownNameSet, byArrow.target);
    } else if (byColon) {
      lastExplicitSpeaker = byColon.speaker;
      actor = byColon.speaker;
      body = byColon.body;
      confidence = 92;
      addKnownName(knownNameSet, byColon.speaker);
    } else if (byRole) {
      lastExplicitSpeaker = byRole.speaker;
      actor = byRole.speaker;
      body = byRole.body;
      confidence = 84;
      addKnownName(knownNameSet, byRole.speaker);
    } else if (body.startsWith("*") && body.endsWith("*") && body.length >= 2) {
      body = body.slice(1, -1).trim();
    }

    body = cleanInlineText(body);
    if (!body) continue;

    if (!actor) {
      const knownNames = [...knownNameSet].sort((a, b) => b.length - a.length);
      const particleActor = findActorByParticle(body, knownNames, knownActorOnly);
      if (particleActor) {
        actor = particleActor;
        confidence = 72;
        addKnownName(knownNameSet, actor);
      }
    }

    if (!actor && /^([가-힣A-Za-z][가-힣A-Za-z0-9_-]{1,15})[은는이가](?=$|[\s"'`),.?!…])/.test(body)) {
      const mLead = body.match(/^([가-힣A-Za-z][가-힣A-Za-z0-9_-]{1,15})[은는이가](?=$|[\s"'`),.?!…])/);
      const lead = normalizeName(mLead?.[1] || "");
      const knownNames = [...knownNameSet].sort((a, b) => b.length - a.length);
      if (isLikelyActorToken(lead, knownNames, knownActorOnly)) {
        actor = lead;
        confidence = 66;
        addKnownName(knownNameSet, actor);
      }
    }

    if (
      !actor &&
      /(?:^|[\s"'([{])당신(?:은|이|을|를|에게|의)?(?=$|[\s"'`),.?!…])/.test(body) &&
      looksLikeName(personaName)
    ) {
      actor = personaName;
      confidence = 64;
    }
    if (
      !actor &&
      looksLikeName(personaName) &&
      !body.startsWith('"') &&
      (body.includes(personaName) || (personaName.length === 3 && body.includes(personaName.slice(1))))
    ) {
      actor = personaName;
      confidence = 58;
    }
    if (!actor && /^(그녀|그는|그가|그의)\b/.test(body) && lastExplicitSpeaker) {
      actor = lastExplicitSpeaker;
      confidence = 52;
    }

    if (!actor && body.startsWith('"') && lastExplicitSpeaker) {
      actor = lastExplicitSpeaker;
      confidence = 68;
    }
    if (!actor && body.startsWith('"') && looksLikeName(npcName)) {
      actor = npcName;
      confidence = 56;
    }
    if (!actor) actor = "unknown";
    if (actor !== "unknown") addKnownName(knownNameSet, actor);

    const eventType: CharacterEventType = tagged.forcedType || (detectRelation(body) ? "relation" : "action");
    const knownNames = [...knownNameSet].sort((a, b) => b.length - a.length);
    const target = targetFromSpeaker || inferTarget(body, actor, knownNames);
    if (target) addKnownName(knownNameSet, target);
    const action = cut(body, 180);
    if (action.length < 3) continue;
    if (actor === "unknown" && confidence < 50) continue;

    const key = `${eventType}|${actor}|${target}|${action}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      sourceRole: "assistant",
      eventType,
      actor,
      target,
      action,
      evidence: cut(rawLine, 220),
      confidence,
    });
  }

  return events.slice(0, maxEvents);
}
