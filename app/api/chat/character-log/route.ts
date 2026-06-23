import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireChatAccess, bad } from "@/app/api/memory/_util";

type LogEvent = {
  id: number;
  chatId: string;
  messageId: string;
  turnNo: number;
  sourceRole: string;
  eventType: string;
  actor: string;
  target: string;
  action: string;
  evidence: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
};

const RELATION_HINTS = ["관계", "감정", "신뢰", "혐오", "경멸", "적대", "동료", "살의", "제거 대상", "불안", "공포", "수치심"];
const GENERIC_REL_TARGETS = new Set(["동료", "상대", "적", "팀", "팀원", "사람", "누구", "모두", "멀리", "저기", "여기"]);
const ROLE_NAMES = new Set(["어머니", "아버지", "누나", "형", "코치", "의사", "기사"]);
const TARGET_BLOCKLIST = new Set(["없다", "없다는", "없음", "그", "그녀", "그들", "당신"]);
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
const EMOTION_HINTS: Array<{ re: RegExp; label: string }> = [
  { re: /황당|어이없/, label: "황당함" },
  { re: /역겨|구역질/, label: "역겨움" },
  { re: /혐오/, label: "혐오" },
  { re: /경멸/, label: "경멸" },
  { re: /분노|화가|격분/, label: "분노" },
  { re: /허탈|허무/, label: "허탈함" },
  { re: /불안|초조|안절부절/, label: "불안" },
  { re: /공포|두려/, label: "공포" },
  { re: /당황/, label: "당황" },
  { re: /걱정|염려/, label: "걱정" },
  { re: /의아|왜\s|무슨 일/, label: "의아함" },
];

function trimText(s: string, max: number) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^\*+/, "")
    .replace(/\*+$/, "")
    .trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}...`;
}

function esc(s: string) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTerminal(text: string) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/\.\.\.$/.test(t)) return t;
  if (/[.?!…]"?$/.test(t)) return t;
  return `${t}.`;
}

function stripTerminal(text: string) {
  return String(text || "")
    .trim()
    .replace(/[.?!…]+$/g, "")
    .trim();
}

function hasFinalConsonant(word: string) {
  const t = String(word || "").trim();
  if (!t) return false;
  const ch = t[t.length - 1];
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function objParticle(word: string) {
  return hasFinalConsonant(word) ? "을" : "를";
}

function looksRelationText(text: string) {
  const t = String(text || "");
  return RELATION_HINTS.some((k) => t.includes(k));
}

function inferMentionedTarget(action: string, actor: string, actorSet: Set<string>, personaName: string) {
  const src = String(action || "");
  const candidates = new Set<string>();
  for (const n of actorSet) {
    if (!n || n === actor) continue;
    candidates.add(n);
  }
  if (personaName && personaName !== actor) candidates.add(personaName);
  for (const role of ROLE_NAMES) {
    if (role !== actor) candidates.add(role);
  }
  const names = [...candidates].sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (!n || TARGET_BLOCKLIST.has(n) || GENERIC_REL_TARGETS.has(n)) continue;
    const re = new RegExp(`(?:^|[\\s"'(])${esc(n)}(?=$|[\\s"'),.?!…])`);
    if (re.test(src)) return n;
  }
  return "";
}

function inferRelationTarget(action: string, actor: string, actorSet: Set<string>, personaName: string, directTarget: string) {
  const direct = String(directTarget || "").trim();
  if (direct && isValidRelationTarget(direct, actor)) return direct;
  const hinted = inferMentionedTarget(action, actor, actorSet, personaName);
  if (hinted && isValidRelationTarget(hinted, actor)) return hinted;
  if (
    personaName &&
    personaName !== actor &&
    /(?:^|[\s("'“”])(?:당신|너|자네)(?:[은는이가을를에게의와과도]|$)/.test(String(action || ""))
  ) {
    return personaName;
  }
  return "";
}

function relationLabelFromAction(action: string, eventType: string) {
  const t = String(action || "");
  if (t.includes("제거 대상")) return "제거 대상";
  if (t.includes("동료")) return "동료";
  if (t.includes("경멸")) return "경멸";
  if (t.includes("혐오")) return "혐오";
  if (t.includes("살의")) return "살의";
  if (t.includes("적대")) return "적대";
  if (t.includes("신뢰")) return "신뢰";
  if (eventType === "relation") return "관계 변화";
  return "";
}

function isRelationChangeCandidate(action: string, eventType: string, target: string) {
  if (!target) return false;
  if (eventType === "relation") return true;
  if (looksRelationText(action)) return true;
  if (extractEmotionLabels(action).length > 0) return true;
  return /도와|도움|놀라|의심|수치심|혐오|경멸|적대|살의|제거 대상|재분류|분류|고착|진입|변화|경고|저지|방관|신뢰|불안|공포/.test(
    String(action || "")
  );
}

function extractEmotionLabels(text: string) {
  const src = String(text || "");
  const out: string[] = [];
  for (const h of EMOTION_HINTS) {
    if (h.re.test(src)) out.push(h.label);
  }
  return [...new Set(out)].slice(0, 3);
}

function inferBehaviorLabel(text: string) {
  const src = String(text || "");
  if (/불렀|외쳤|나왔어|불러|호출/.test(src)) return "호출";
  if (/방관|지켜보/.test(src)) return "행동 방관";
  if (/저지|막아|막으|말려/.test(src)) return "행동 저지";
  if (/경고|주의|조심/.test(src)) return "경고";
  if (/격분|내동댕|악을 썼|살기 어린|노려보/.test(src)) return "적대 표출";
  if (/준비|퍼주|챙겨|건넸|데려다|보호대|치료/.test(src)) return "보살핌";
  if (/안절부절|서성|주시|관찰|노려보/.test(src)) return "상황 주시";
  if (/소개|설명|전해|알려|보고받/.test(src)) return "정보 전달";
  if (/불렀|외치|말했|대답|물었/.test(src)) return "대화";
  return "행동 지속";
}

function compactState(actor: string, target: string, action: string) {
  const emotions = extractEmotionLabels(action);
  const behavior = inferBehaviorLabel(action);
  const about = isValidRelationTarget(target, actor)
    ? behavior.startsWith("행동 ")
      ? `${target}의 ${behavior}`
      : behavior === "호출"
        ? `${target} 호출`
        : `${target} 관련 ${behavior}`
    : behavior;
  const emo = emotions.length ? ` / ${emotions.join(", ")}` : "";
  return trimText(`${actor}: ${about}${emo}`, 58);
}

function cleanActionForDisplay(action: string, actor: string) {
  const src = String(action || "").replace(/\s+/g, " ").trim();
  if (!src) return "";
  const q = src.match(/"([^"]{2,80})"/);
  if (q?.[1]) return ensureTerminal(trimText(q[1], 56));
  const s1 = src
    .replace(new RegExp(`^${actor}(?:은|는|이|가)?\\s*`), "")
    .replace(/^(그는|그녀는|당신은)\s+/, "");
  const s2 = s1.split(/[.?!]/)[0] || s1;
  return ensureTerminal(trimText(s2, 72));
}

function inferCauseType(action: string) {
  const src = String(action || "");
  if (/"[^"]{2,50}"/.test(src) || /말했|말하|고백|대답|물었|외쳤|불렀/.test(src)) return "발언";
  if (/정신 상태|상태|표정|모습/.test(src)) return "상태";
  return "행동";
}

function looksNamedTarget(target: string, actorSet: Set<string>, personaName: string, actor: string) {
  const t = String(target || "").trim();
  if (!t || t === "unknown") return false;
  if (t === actor) return false;
  if (TARGET_BLOCKLIST.has(t)) return false;
  if (GENERIC_REL_TARGETS.has(t)) return false;
  if (actorSet.has(t)) return true;
  if (personaName && t === personaName) return true;
  if (ROLE_NAMES.has(t)) return true;
  if (/^[가-힣]{3}$/.test(t) && KOREAN_SURNAMES.has(t[0])) return true;
  if (/^[A-Za-z][A-Za-z0-9_-]{2,23}$/.test(t)) return true;
  return false;
}

function toRelationChangeText(target: string, action: string, eventType: string) {
  const t = String(target || "").trim();
  if (!t) return "";
  const src = String(action || "");
  if (/도와|도움|돕/.test(src)) return `${t}${objParticle(t)} 도움`;
  if (/나이/.test(src) && /놀라|놀람/.test(src)) return `${t}의 나이에 놀람`;
  if (/정신 상태/.test(src) && /의심/.test(src)) return `${t}의 정신 상태를 의심하기 시작함`;
  const shameUp = src.match(/수치심\s*([0-9]+)\s*상승/);
  if (shameUp?.[1]) return `${t}의 행동에 대한 수치심 ${shameUp[1]} 상승`;
  if (/수치심/.test(src)) return `${t}의 행동에 극심한 수치심을 느낌`;
  if (/제거 대상/.test(src)) return `${t}${objParticle(t)} 제거 대상으로 간주하기 시작함`;
  if (/살의/.test(src) && /고착/.test(src)) return `${t}에 대한 적대감이 살의 단계에서 고착화됨`;
  if (/살의/.test(src)) return `${t}에 대한 감정이 살의로 변화`;
  if (/경멸/.test(src) && /진입/.test(src)) return `${t}에 대한 관계가 '경멸' 단계로 진입함`;
  if (/경멸/.test(src)) return `${t}에 대한 경멸을 느낌`;
  if (/혐오/.test(src)) return `${t}에 대한 혐오감을 표출`;
  if (/적대/.test(src)) return `${t}에 대한 적대감을 드러냄`;
  if (/신뢰/.test(src)) return `${t}에 대한 신뢰를 보임`;
  if (/저지|막아|막으|말려/.test(src)) return `${t}의 위험한 행동을 저지함`;
  if (/경고|주의|조심/.test(src)) return `${t}에게 경고함`;
  if (/방관|지켜보/.test(src)) return `${t}의 행동을 방관함`;
  if (/불안/.test(src)) return `${t} 관련 불안을 느낌`;
  if (/공포/.test(src)) return `${t} 관련 공포를 느낌`;

  const relation = relationLabelFromAction(action, eventType);
  const emotions = extractEmotionLabels(action);
  if (relation && relation !== "관계 변화") return `${t}에 대한 ${relation}을 느낌`;
  if (emotions.length > 0) {
    const emo = emotions[0];
    if (emo === "걱정") return `${t}${objParticle(t)} 걱정함`;
    if (emo === "불안" || emo === "공포") return `${t} 관련 상황에 ${emo}${objParticle(emo)} 느낌`;
    const cause = inferCauseType(action);
    return `${t}의 ${cause}에 ${emo}${objParticle(emo)} 느낌`;
  }
  return "";
}

function isValidRelationTarget(target: string, actor: string) {
  const t = String(target || "").trim();
  if (!t || t === actor || t === "unknown") return false;
  if (TARGET_BLOCKLIST.has(t)) return false;
  if (GENERIC_REL_TARGETS.has(t)) return false;
  return true;
}

function toEvents(rows: any[], chatId: string): LogEvent[] {
  return rows.map((r) => ({
    id: Number(r?.id || 0),
    chatId: String(r?.chatId || chatId),
    messageId: String(r?.messageId || ""),
    turnNo: Number(r?.turnNo || 0),
    sourceRole: String(r?.sourceRole || "assistant"),
    eventType: String(r?.eventType || "action"),
    actor: String(r?.actor || "unknown"),
    target: String(r?.target || ""),
    action: String(r?.action || ""),
    evidence: String(r?.evidence || ""),
    confidence: Number(r?.confidence || 0),
    createdAt: Number(r?.createdAt || 0),
    updatedAt: Number(r?.updatedAt || 0),
  }));
}

function buildCharacterCards(eventsAsc: LogEvent[], personaName: string) {
  const actorSet = new Set<string>();
  for (const ev of eventsAsc) {
    const actor = String(ev.actor || "").trim();
    if (actor && actor !== "unknown") actorSet.add(actor);
  }

  const map = new Map<
    string,
    {
      character: string;
      firstTurn: number;
      lastTurn: number;
      seenTurns: Set<number>;
      relationMap: Map<string, Set<string>>;
      state: string;
      stateTurn: number;
      stateRawAction: string;
      events: Array<{ turnNo: number; order: number; eventType: string; target: string; action: string }>;
      lastAction: string;
      lastActionTurn: number;
      relationChanges: Array<{ turnNo: number; text: string }>;
    }
  >();
  let eventOrder = 0;

  for (const ev of eventsAsc) {
    const actor = String(ev.actor || "").trim();
    if (!actor || actor === "unknown") continue;
    const turnNo = Number(ev.turnNo || 0);
    const actionRaw = String(ev.action || "");
    const action = trimText(actionRaw, 120);
    if (!action) continue;
    const rawTarget = String(ev.target || "").trim();
    const hintedTarget = inferMentionedTarget(action, actor, actorSet, personaName);
    const targetCandidate = looksNamedTarget(rawTarget, actorSet, personaName, actor) ? rawTarget : hintedTarget;
    const target = looksNamedTarget(targetCandidate, actorSet, personaName, actor) ? targetCandidate : "";
    const relationTarget = inferRelationTarget(action, actor, actorSet, personaName, target);
    const effectiveTarget = relationTarget || target;
    const emotions = extractEmotionLabels(action);
    const relLike =
      ev.eventType === "relation" ||
      (looksRelationText(action) && Boolean(effectiveTarget)) ||
      (Boolean(effectiveTarget) && (emotions.length > 0 || /저지|경고|분류|재분류|제거|고착|진입|변화/.test(action)));

    const item =
      map.get(actor) ||
      {
        character: actor,
        firstTurn: turnNo || 0,
        lastTurn: turnNo || 0,
        seenTurns: new Set<number>(),
        relationMap: new Map<string, Set<string>>(),
        state: "",
        stateTurn: 0,
        stateRawAction: "",
        events: [],
        lastAction: "",
        lastActionTurn: 0,
        relationChanges: [],
      };

    if (turnNo > 0) item.seenTurns.add(turnNo);
    if (!item.firstTurn || (turnNo > 0 && turnNo < item.firstTurn)) item.firstTurn = turnNo;
    if (turnNo > item.lastTurn) item.lastTurn = turnNo;
    eventOrder += 1;
    item.events.push({ turnNo, order: eventOrder, eventType: ev.eventType, target: effectiveTarget, action });

    if (effectiveTarget && isValidRelationTarget(effectiveTarget, actor)) {
      const set = item.relationMap.get(effectiveTarget) || new Set<string>();
      const label = relationLabelFromAction(action, ev.eventType);
      if (label && label !== "관계 변화") set.add(label);
      const behavior = inferBehaviorLabel(action);
      if (behavior && behavior !== "행동 지속" && behavior !== "대화") set.add(behavior);
      for (const emo of emotions) set.add(emo);
      if (set.size > 0) item.relationMap.set(effectiveTarget, set);
    }

    const stateCandidate = compactState(actor, effectiveTarget, action);
    const stateRank = relLike ? 2 : emotions.length > 0 ? 1 : 0;
    const currentRank = item.stateRawAction
      ? looksRelationText(item.stateRawAction) || /관련|저지|경고|분류|제거|변화|고착|진입/.test(item.state)
        ? 2
        : extractEmotionLabels(item.stateRawAction).length > 0
          ? 1
          : 0
      : -1;
    if (stateRank > currentRank || (stateRank === currentRank && turnNo >= item.stateTurn)) {
      item.state = stateCandidate;
      item.stateTurn = turnNo;
      item.stateRawAction = action;
    }

    if (turnNo > item.lastActionTurn || (turnNo === item.lastActionTurn && cleanActionForDisplay(action, actor) !== item.lastAction)) {
      const concise = cleanActionForDisplay(action, actor);
      if (concise && concise !== cleanActionForDisplay(item.stateRawAction, actor)) {
        item.lastAction = concise;
        item.lastActionTurn = turnNo;
      }
    }

    if (isRelationChangeCandidate(action, ev.eventType, effectiveTarget)) {
      const relationText = toRelationChangeText(effectiveTarget, action, ev.eventType);
      if (relationText) {
        item.relationChanges.push({
          turnNo,
          text: relationText,
        });
      }
    }

    map.set(actor, item);
  }

  const cards = [...map.values()]
    .map((x) => {
      const relationship = [...x.relationMap.entries()]
        .map(([to, labels]) => {
          const vals = [...labels].filter(Boolean).slice(0, 4);
          return vals.length ? `${x.character} -> ${to}: ${vals.join(", ")}` : "";
        })
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "ko-KR"));

      const changeSet = new Set<string>();
      let relationChanges = x.relationChanges
        .sort((a, b) => a.turnNo - b.turnNo)
        .filter((c) => {
          const key = `${c.turnNo}|${c.text}`;
          if (changeSet.has(key)) return false;
          changeSet.add(key);
          return true;
        })
        .slice(0, 14)
        .map((c) => ({ turnNo: c.turnNo, text: trimText(c.text, 72), target: "" }));

      if (x.firstTurn > 0) {
        const firstEv = x.events
          .filter((ev) => ev.turnNo === x.firstTurn)
          .sort((a, b) => a.order - b.order)[0];
        const firstRel = relationChanges.find((c) => Number(c.turnNo || 0) === x.firstTurn);
        let firstDetail = firstRel?.text || "";
        if (!firstDetail && firstEv) {
          const firstTarget = inferRelationTarget(firstEv.action, x.character, actorSet, personaName, firstEv.target);
          firstDetail = toRelationChangeText(firstTarget, firstEv.action, firstEv.eventType);
        }
        const firstText = firstDetail ? `첫 등장. ${stripTerminal(firstDetail)}` : "첫 등장";
        relationChanges = [
          { turnNo: x.firstTurn, text: firstText, target: "" },
          ...relationChanges.filter((c) => Number(c.turnNo || 0) !== x.firstTurn),
        ];
      }
      relationChanges = relationChanges
        .sort((a, b) => a.turnNo - b.turnNo)
        .filter((c, idx, arr) => idx === arr.findIndex((x2) => x2.turnNo === c.turnNo && x2.text === c.text))
        .slice(0, 12);

      let state = x.state || `${x.character}: 행동 지속`;
      let stateTurn = Number(x.stateTurn || x.lastTurn || 0);
      let stateAction = x.stateRawAction || "";
      if (x.events.length > 0) {
        let best: { turnNo: number; target: string; action: string; score: number } | null = null;
        for (const ev of x.events) {
          const emotions = extractEmotionLabels(ev.action);
          const relLike =
            ev.eventType === "relation" ||
            (Boolean(ev.target) &&
              (looksRelationText(ev.action) || emotions.length > 0 || /저지|경고|분류|재분류|제거|고착|진입|변화/.test(ev.action)));
          const score = (relLike ? 4 : 0) + (ev.target ? 2 : 0) + (emotions.length > 0 ? 2 : 0) + (ev.turnNo / 1000);
          if (!best || score > best.score) best = { turnNo: ev.turnNo, target: ev.target, action: ev.action, score };
        }
        if (best) {
          state = compactState(x.character, best.target, best.action);
          stateTurn = best.turnNo;
          stateAction = best.action;
        }
      }

      const stateConcise = cleanActionForDisplay(stateAction, x.character);
      const recent = [...x.events].sort((a, b) => b.turnNo - a.turnNo || b.order - a.order);
      let fallbackAction = "";
      let fallbackTurn = 0;
      let pickedAction = "";
      let pickedTurn = 0;
      for (const ev of recent) {
        const concise = cleanActionForDisplay(ev.action, x.character);
        if (!concise) continue;
        if (!fallbackAction) {
          fallbackAction = concise;
          fallbackTurn = ev.turnNo;
        }
        const sameAsState = concise === stateConcise && ev.turnNo === stateTurn;
        if (!sameAsState) {
          pickedAction = concise;
          pickedTurn = ev.turnNo;
          break;
        }
      }
      if (!pickedAction) {
        pickedAction = fallbackAction;
        pickedTurn = fallbackTurn;
      }

      const seenTurns = [...x.seenTurns].sort((a, b) => b - a);
      return {
        character: x.character,
        relationship,
        state,
        stateTurn,
        lastAction: pickedAction || x.lastAction || "-",
        lastActionTurn: Number(pickedTurn || x.lastActionTurn || 0),
        lastTurn: x.lastTurn || 0,
        seenTurns,
        relationChanges,
      };
    })
    .sort((a, b) => b.lastTurn - a.lastTurn || a.character.localeCompare(b.character, "ko-KR"));

  return cards;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const chatId = String(url.searchParams.get("chatId") || "").trim();
    if (!chatId) return bad("chatId가 필요합니다.");

    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const limitRaw = Number(url.searchParams.get("limit") || 160);
    const limit = Math.max(20, Math.min(5000, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 160));
    const scanLimit = Math.max(1200, Math.min(20000, limit * 12));
    const profile = db
      .prepare(
        `SELECT s.personaName AS personaName
         FROM chats c
         LEFT JOIN chat_settings s ON s.chatId = c.id
         WHERE c.id=?
         LIMIT 1`
      )
      .get(chatId) as any;
    const personaName = String(profile?.personaName || "").trim();

    const rows = db
      .prepare(
        `SELECT id, chatId, messageId, turnNo, sourceRole, eventType, actor, target, action, evidence, confidence, createdAt, updatedAt
         FROM chat_character_events
         WHERE chatId=?
         ORDER BY turnNo DESC, createdAt ASC, id ASC
         LIMIT ?`
      )
      .all(chatId, scanLimit) as any[];

    const filtered = toEvents(rows, chatId).filter((ev) => {
      const actor = String(ev.actor || "").trim();
      if (!actor || actor === "unknown") return false;
      if (String(ev.sourceRole || "") === "user") return false;
      if (actor === "사용자") return false;
      if (personaName && actor === personaName) return false;
      return true;
    });
    const events = filtered.slice(0, limit);
    const eventsAsc = [...events].sort((a, b) => a.turnNo - b.turnNo || a.createdAt - b.createdAt || a.id - b.id);
    const cards = buildCharacterCards(eventsAsc, personaName);

    const turnsMap = new Map<number, any[]>();
    for (const ev of events) {
      const k = Number(ev.turnNo || 0);
      const arr = turnsMap.get(k) || [];
      arr.push(ev);
      turnsMap.set(k, arr);
    }
    const turns = [...turnsMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([turnNo, items]) => {
        const byActor = new Map<string, LogEvent>();
        for (const ev of items) {
          const actor = String(ev?.actor || "").trim();
          if (!actor || actor === "unknown") continue;
          byActor.set(actor, ev);
        }
        const dedupEvents = [...byActor.values()].slice(0, 8);
        return { turnNo, events: dedupEvents };
      });

    return NextResponse.json({ ok: true, chatId, events, turns, cards });
  } catch (e: any) {
    return bad(e?.message || "character_log_failed", 500);
  }
}
