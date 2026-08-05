export type MemorySearchIndex = {
  title: string;
  entities: string;
  places: string;
  events: string;
  keywords: string;
  summary: string;
};

const WORD_RE = /[\p{Script=Hangul}a-z0-9]{2,}/giu;
const TITLE_RE = /^\s*#{1,6}\s*([^\r\n]+)/mu;
const TURN_SUFFIX_RE = /\s*\(\s*\d{1,6}\s*(?:[-~–—]\s*\d{1,6}\s*)?턴\s*\)\s*$/u;
const PARTICLE_RE = /(?:에게서|으로부터|이라고|라는|에게|한테|께서|에서|으로|라고|처럼|보다|까지|부터|하고|이며|이고|과|와|은|는|이|가|을|를|의|도|만|께)$/u;
const HONORIFIC_ENTITY_RE = /([가-힣]{2,5})(?:\s*)(?:씨|님|양|군|누나|언니|오빠|형|선배|후배|대표|반장|팀장|사장|회장|교수|선생|아버지|어머니|아빠|엄마|할아버지|할머니)(?=[\s,.;:!?)}\]"'”’]|$)/gu;
const PARTICLE_ENTITY_RE = /(?:^|[\s"'“”‘’([{])([가-힣]{2,5})(?:에게서|으로부터|에게|한테|께서|하고|이며|이고|과|와|은|는|이|가|을|를|의)(?=[\s,.;:!?)}\]"'”’]|$)/gmu;
const LABEL_ENTITY_RE = /(?:^|\s)([가-힣]{2,5})\s*[:：]/gmu;

const INDEX_STOPWORDS = new Set([
  "그것", "그때", "여기", "저기", "이곳", "저곳", "자신", "상대", "사람", "인물",
  "현재", "이후", "전에", "때문", "정도", "상황", "사실", "모습", "말투", "대화",
  "기억", "사건", "관계", "감정", "행동", "내용", "장면", "사용자", "주인공", "캐릭터",
  "했다", "한다", "된다", "있다", "없다", "했다는", "것을", "것이", "그리고", "하지만",
]);

const PLACE_TERMS = [
  "아파트", "자택", "집", "병원", "진료실", "학교", "교실", "회사", "사무실", "연습실",
  "경비실", "관리실", "주차장", "복도", "옥상", "공원", "놀이터", "식당", "카페", "호텔",
  "경찰서", "파출소", "구치소", "교도소", "공항", "역", "차량", "자동차", "방", "거실",
];

const EVENT_GROUPS: Array<{ canonical: string; terms: string[] }> = [
  { canonical: "감시", terms: ["감시", "미행", "지켜보", "망보", "잠복", "순찰", "추적"] },
  { canonical: "촬영", terms: ["사진", "촬영", "찍었", "찍은", "카메라", "녹화", "캡처"] },
  { canonical: "침입", terms: ["침입", "몰래 들어", "잠입", "무단", "침범"] },
  { canonical: "은폐", terms: ["알리바이", "은폐", "숨겼", "숨기", "증거 인멸", "위장"] },
  { canonical: "위협", terms: ["협박", "위협", "겁박", "인질", "강요"] },
  { canonical: "폭력", terms: ["폭행", "구타", "공격", "살해", "죽였", "상처", "부상"] },
  { canonical: "구조", terms: ["구조", "구출", "보호", "살려", "도왔", "도움"] },
  { canonical: "실종", terms: ["실종", "사라졌", "행방불명", "납치"] },
  { canonical: "사망", terms: ["사망", "죽음", "죽었다", "숨졌다", "장례"] },
  { canonical: "입원", terms: ["입원", "진료", "치료", "수술", "퇴원"] },
  { canonical: "체포", terms: ["체포", "구금", "연행", "수감", "신고"] },
  { canonical: "약속", terms: ["약속", "맹세", "계약", "합의"] },
  { canonical: "고백", terms: ["고백", "사랑한다고", "마음을 전", "청혼"] },
  { canonical: "결혼", terms: ["결혼", "부부", "혼인", "남편", "아내"] },
  { canonical: "이별", terms: ["이별", "헤어졌", "절교", "파혼", "이혼"] },
  { canonical: "갈등", terms: ["다툼", "싸움", "갈등", "배신", "오해", "냉전"] },
  { canonical: "화해", terms: ["화해", "용서", "사과", "관계 회복"] },
  { canonical: "만남", terms: ["만남", "재회", "처음 만", "통성명", "소개"] },
  { canonical: "가족", terms: ["아버지", "어머니", "아빠", "엄마", "딸", "아들", "손녀", "손자", "자매", "형제"] },
  { canonical: "직장", terms: ["직장", "고용", "상사", "부하", "경비원", "아이돌", "동료", "대표"] },
];

function normalizeWord(raw: string) {
  return String(raw || "").trim().toLowerCase();
}

function stripParticle(raw: string) {
  const token = normalizeWord(raw);
  const stripped = token.replace(PARTICLE_RE, "");
  return stripped.length >= 2 ? stripped : token;
}

function pushUnique(out: string[], seen: Set<string>, raw: string, max: number) {
  const token = normalizeWord(raw);
  if (out.length >= max || token.length < 2 || INDEX_STOPWORDS.has(token) || seen.has(token)) return;
  seen.add(token);
  out.push(token);
}

function joinWithShortMarkers(items: string[]) {
  const out = [...items];
  const seen = new Set(out);
  for (const item of items) {
    if (item.length !== 2) continue;
    const marker = memorySearchFtsTerm(item);
    if (marker && !seen.has(marker)) {
      seen.add(marker);
      out.push(marker);
    }
  }
  return out.join(" ");
}

/**
 * FTS5 trigram cannot find a two-character Korean word. Store an additional
 * searchable marker whose total length is at least three characters.
 */
export function memorySearchFtsTerm(raw: string) {
  const token = normalizeWord(raw).replace(/[^\p{Script=Hangul}a-z0-9]/giu, "");
  if (token.length < 2) return "";
  return token.length === 2 ? `z2${token}` : token;
}

export function buildMemorySearchFtsQuery(tokens: string[], maxTerms = 28) {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const term = memorySearchFtsTerm(raw);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(`"${term.replace(/"/g, '""')}"`);
    if (terms.length >= Math.max(1, maxTerms)) break;
  }
  return terms.join(" OR ");
}

export function buildMemorySearchIndex(rawSummary: string): MemorySearchIndex {
  const summary = String(rawSummary || "").trim();
  if (!summary) {
    return { title: "", entities: "", places: "", events: "", keywords: "", summary: "" };
  }

  const lower = summary.toLowerCase();
  const titleMatch = TITLE_RE.exec(summary);
  const title = String(titleMatch?.[1] || "").replace(TURN_SUFFIX_RE, "").trim();
  const words = lower.match(WORD_RE) || [];

  const keywords: string[] = [];
  const keywordSeen = new Set<string>();
  for (const word of words) {
    pushUnique(keywords, keywordSeen, word, 160);
    pushUnique(keywords, keywordSeen, stripParticle(word), 160);
  }

  // Add exact two-character markers once. They make short Korean names such as
  // "윈터" indexable without falling back to a full LIKE scan.
  const markerWords = [...keywords];
  for (const word of markerWords) {
    if (word.length === 2) pushUnique(keywords, keywordSeen, memorySearchFtsTerm(word), 220);
  }

  const entities: string[] = [];
  const entitySeen = new Set<string>();
  for (const match of summary.matchAll(HONORIFIC_ENTITY_RE)) {
    pushUnique(entities, entitySeen, match[1], 48);
  }
  for (const match of summary.matchAll(PARTICLE_ENTITY_RE)) {
    pushUnique(entities, entitySeen, match[1], 48);
  }
  for (const match of summary.matchAll(LABEL_ENTITY_RE)) {
    pushUnique(entities, entitySeen, match[1], 48);
  }

  const places: string[] = [];
  const placeSeen = new Set<string>();
  for (const word of words) {
    const token = stripParticle(word);
    if (PLACE_TERMS.some((place) => token.includes(place))) {
      pushUnique(places, placeSeen, token, 48);
    }
  }

  const events: string[] = [];
  const eventSeen = new Set<string>();
  for (const group of EVENT_GROUPS) {
    if (!group.terms.some((term) => lower.includes(term))) continue;
    pushUnique(events, eventSeen, group.canonical, 48);
    for (const term of group.terms) {
      if (lower.includes(term)) pushUnique(events, eventSeen, term.replace(/\s+/g, ""), 48);
    }
  }

  return {
    title: title.toLowerCase(),
    entities: joinWithShortMarkers(entities),
    places: joinWithShortMarkers(places),
    events: joinWithShortMarkers(events),
    keywords: keywords.join(" "),
    summary,
  };
}
