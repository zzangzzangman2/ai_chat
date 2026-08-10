export type TemporalMessage = {
  role?: unknown;
  content?: unknown;
  createdAt?: unknown;
};

export type TemporalStamp = {
  year: number;
  month: number;
  day: number;
  dateKey: number;
  timeMinutes: number | null;
  label: string;
};

export type TemporalCanon = TemporalStamp & {
  observations: number;
  confirmed: boolean;
  source: "user_explicit" | "repeated_info" | "latest_info";
};

export type PastDatedAnchor = {
  dateKey: number;
  dateLabel: string;
  keywords: string[];
  excerpt: string;
};

export type TemporalContradiction = {
  kind: "date_regression" | "time_regression" | "revived_past_schedule";
  reason: string;
  matchedText: string;
  outputStamp?: TemporalStamp;
  anchor?: PastDatedAnchor;
};

const DATE_RE = /(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu;
const TIME_RE = /(?:⏰\s*)?(?:오전|오후)?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})?\s*(?:분)?/u;
const INFO_DATE_RE = /📅\s*(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu;
const PENDING_RE = /(?:예정|임박|콜\s*타임|호출|합류|준비|대기|곧\s*(?:시작|개최|진행)|잠시\s*후|오늘\s*(?:열리|진행|개최|발매)|이번\s*(?:일정|행사|무대))/u;
const USER_DATE_AUTHORITY_RE = /(?:현재|지금|오늘|이제|현시점|현재\s*날짜|날짜는|시점은|부터|로\s*진행)/u;
const TEMPORAL_OVERRIDE_RE = /(?:회상|플래시백|과거\s*(?:장면|시점|으로)|시간(?:을|이)?\s*되돌|타임\s*리프|이전\s*시점으로|날짜를\s*되돌)/iu;

const ANCHOR_STOPWORDS = new Set(
  [
    "기준", "시점", "작품", "시작", "이후", "이전", "실제", "역사", "현재", "오늘",
    "오전", "오후", "예정", "임박", "진행", "개최", "열린다", "열린", "있다", "없다",
    "한다", "된다", "아무도", "누구도", "대해서", "그리고", "하지만", "해당", "관련",
    "월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일",
  ].map((value) => value.toLocaleLowerCase("ko-KR"))
);

function validDate(year: number, month: number, day: number) {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function stamp(year: number, month: number, day: number, timeMinutes: number | null): TemporalStamp {
  const dateKey = year * 10000 + month * 100 + day;
  const dateLabel = `${year}년 ${month}월 ${day}일`;
  const timeLabel = timeMinutes == null
    ? ""
    : ` ${String(Math.floor(timeMinutes / 60)).padStart(2, "0")}:${String(timeMinutes % 60).padStart(2, "0")}`;
  return { year, month, day, dateKey, timeMinutes, label: `${dateLabel}${timeLabel}` };
}

function nearbyTime(text: string, dateEnd: number) {
  const tail = String(text || "").slice(dateEnd, dateEnd + 100);
  const match = tail.match(TIME_RE);
  if (!match) return null;
  let hour = Number(match[1] || 0);
  const minute = Math.max(0, Math.min(59, Number(match[2] || 0)));
  const token = String(match[0] || "");
  if (token.includes("오후") && hour < 12) hour += 12;
  if (token.includes("오전") && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return hour * 60 + minute;
}

function extractDates(text: unknown, infoOnly: boolean): TemporalStamp[] {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const regex = infoOnly ? INFO_DATE_RE : DATE_RE;
  regex.lastIndex = 0;
  const out: TemporalStamp[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!validDate(year, month, day)) continue;
    out.push(stamp(year, month, day, nearbyTime(source, match.index + match[0].length)));
  }
  return out;
}

function explicitUserStamps(text: unknown) {
  const source = String(text || "");
  if (!USER_DATE_AUTHORITY_RE.test(source) && !TEMPORAL_OVERRIDE_RE.test(source)) {
    return [] as TemporalStamp[];
  }
  return extractDates(source, false);
}

export function hasTemporalOverrideRequest(text: unknown) {
  return TEMPORAL_OVERRIDE_RE.test(String(text || ""));
}

export function buildTemporalCanon(messages: TemporalMessage[]): TemporalCanon | null {
  const observations = new Map<number, {
    stamps: TemporalStamp[];
    infoCount: number;
    userCount: number;
    infoIndices: number[];
    lastIndex: number;
  }>();
  let latestExplicitUser: { stamp: TemporalStamp; index: number } | null = null;
  for (let index = 0; index < (messages || []).length; index += 1) {
    const message = messages[index];
    const role = String(message?.role || "").toLowerCase();
    const stamps = role === "user"
      ? explicitUserStamps(message?.content)
      : role === "assistant" || role === "model"
        ? extractDates(message?.content, true)
        : [];
    for (const item of stamps) {
      const row = observations.get(item.dateKey) || {
        stamps: [],
        infoCount: 0,
        userCount: 0,
        infoIndices: [],
        lastIndex: -1,
      };
      row.stamps.push(item);
      if (role === "user") row.userCount += 1;
      else {
        row.infoCount += 1;
        row.infoIndices.push(index);
      }
      row.lastIndex = index;
      observations.set(item.dateKey, row);
      if (role === "user" && (!latestExplicitUser || index >= latestExplicitUser.index)) {
        latestExplicitUser = { stamp: item, index };
      }
    }
  }
  if (!observations.size) return null;

  const rows = [...observations.entries()].map(([dateKey, row]) => ({ dateKey, ...row }));

  // A user's explicit current-date correction or dated time-travel instruction
  // starts a new timeline segment, even when it intentionally moves backwards.
  // Two matching INFO observations after that correction may advance the segment;
  // an old user date therefore cannot freeze the story forever.
  if (latestExplicitUser) {
    const laterRepeatedInfo = rows
      .map((row) => ({
        ...row,
        laterInfoCount: row.infoIndices.filter((index) => index > latestExplicitUser!.index).length,
      }))
      .filter((row) => row.laterInfoCount >= 2)
      .sort((a, b) => b.dateKey - a.dateKey || b.lastIndex - a.lastIndex);
    if (laterRepeatedInfo.length) {
      const selected = laterRepeatedInfo[0];
      const representative = selected.stamps.reduce((best, item) => {
        if (best.timeMinutes == null) return item.timeMinutes == null ? best : item;
        if (item.timeMinutes == null) return best;
        return item.timeMinutes > best.timeMinutes ? item : best;
      }, selected.stamps[0]);
      return {
        ...representative,
        observations: selected.laterInfoCount,
        confirmed: true,
        source: "repeated_info",
      };
    }
    const explicitRow = observations.get(latestExplicitUser.stamp.dateKey)!;
    return {
      ...latestExplicitUser.stamp,
      observations: explicitRow.userCount,
      confirmed: true,
      source: "user_explicit",
    };
  }

  const authoritative = rows.filter((row) => row.userCount > 0 || row.infoCount >= 2);
  const pool = authoritative.length ? authoritative : rows;
  pool.sort((a, b) => b.dateKey - a.dateKey || b.lastIndex - a.lastIndex);
  const selected = pool[0];
  const representative = selected.stamps.reduce((best, item) => {
    if (best.timeMinutes == null) return item.timeMinutes == null ? best : item;
    if (item.timeMinutes == null) return best;
    return item.timeMinutes > best.timeMinutes ? item : best;
  }, selected.stamps[0]);
  const source = selected.userCount > 0
    ? "user_explicit"
    : selected.infoCount >= 2
      ? "repeated_info"
      : "latest_info";
  return {
    ...representative,
    observations: selected.userCount + selected.infoCount,
    confirmed: selected.userCount > 0 || selected.infoCount >= 2,
    source,
  };
}

function wordsFromAnchor(text: string) {
  const normalized = String(text || "")
    // Do not reuse DATE_RE here: extractPastDatedAnchors is concurrently
    // iterating that global regexp and replace() would reset its lastIndex.
    .replace(/20\d{2}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/gu, " ")
    .replace(/\d+(?:[:.]\d+)?/g, " ")
    .replace(/[{}[\]<>#*_`|]/g, " ")
    .toLocaleLowerCase("ko-KR");
  const words = normalized.match(/[가-힣A-Za-z]{2,}/g) || [];
  return [...new Set(words.filter((word) => !ANCHOR_STOPWORDS.has(word)))].slice(0, 14);
}

export function extractPastDatedAnchors(text: unknown, canon: TemporalCanon): PastDatedAnchor[] {
  if (!canon?.confirmed) return [];
  const source = String(text || "").replace(/\r\n/g, "\n");
  DATE_RE.lastIndex = 0;
  const anchors: PastDatedAnchor[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = DATE_RE.exec(source))) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!validDate(year, month, day)) continue;
    const dateKey = year * 10000 + month * 100 + day;
    if (dateKey >= canon.dateKey) continue;
    const lineStart = Math.max(source.lastIndexOf("\n", match.index), source.lastIndexOf(".", match.index)) + 1;
    const nextNewline = source.indexOf("\n", match.index + match[0].length);
    const nextPeriod = source.indexOf(".", match.index + match[0].length);
    const ends = [nextNewline, nextPeriod].filter((value) => value >= 0);
    const lineEnd = ends.length ? Math.min(...ends) + 1 : Math.min(source.length, match.index + 320);
    const excerpt = source.slice(Math.max(0, lineStart), Math.min(source.length, lineEnd)).replace(/\s+/g, " ").trim();
    const keywords = wordsFromAnchor(excerpt);
    if (keywords.length < 2) continue;
    const key = `${dateKey}\u0000${keywords.slice(0, 5).join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ dateKey, dateLabel: `${year}년 ${month}월 ${day}일`, keywords, excerpt: excerpt.slice(0, 260) });
  }
  return anchors.slice(0, 16);
}

function compareStamp(a: TemporalStamp, b: TemporalStamp) {
  if (a.dateKey !== b.dateKey) return a.dateKey - b.dateKey;
  if (a.timeMinutes == null || b.timeMinutes == null) return 0;
  return a.timeMinutes - b.timeMinutes;
}

export function findTemporalContradiction(params: {
  text: unknown;
  canon: TemporalCanon | null;
  anchors?: PastDatedAnchor[];
}): TemporalContradiction | null {
  const canon = params.canon;
  if (!canon?.confirmed) return null;
  const text = String(params.text || "");
  const outputStamps = extractDates(text, true);
  for (const outputStamp of outputStamps) {
    const comparison = compareStamp(outputStamp, canon);
    if (comparison < 0) {
      return {
        kind: outputStamp.dateKey < canon.dateKey ? "date_regression" : "time_regression",
        reason: `${outputStamp.label} is earlier than canonical ${canon.label}`,
        matchedText: outputStamp.label,
        outputStamp,
      };
    }
  }

  if (!PENDING_RE.test(text)) return null;
  const lower = text.toLocaleLowerCase("ko-KR");
  for (const anchor of params.anchors || []) {
    const matched = anchor.keywords.filter((keyword) => lower.includes(keyword));
    if (matched.length < 2) continue;
    return {
      kind: "revived_past_schedule",
      reason: `${anchor.dateLabel} event was presented as pending after ${canon.label}`,
      matchedText: matched.slice(0, 4).join(", "),
      anchor,
    };
  }
  return null;
}

export function formatTemporalCanonBlock(canon: TemporalCanon | null, anchors: PastDatedAnchor[] = []) {
  if (!canon?.confirmed) return "";
  return [
    "# [CURRENT TEMPORAL CANON — HARD CONTINUITY]",
    `- 현재 확정 시점은 ${canon.label}이다. 이후 사용자 입력에 명시적인 시간 이동·회상·날짜 정정이 없는 한 이보다 과거로 돌아가지 않는다.`,
    "- 작품 프롬프트와 로어북의 기준일·시작일은 최초 출발점 또는 역사 정보다. 현재 확정 시점을 덮어쓰지 않는다.",
    "- 현재 확정 시점보다 이른 날짜에 예정됐던 행사·발매·리허설·콜타임은 이미 지난 과거다. 예정·임박·미해결 일정으로 되살리지 않는다.",
    "- INFO/STATUS의 날짜와 시간도 본문과 동일한 시간축을 사용한다. 날짜 회귀나 완료 일정 부활이 생기면 출력 전에 현재 정사에 맞게 다시 쓴다.",
    ...(anchors.length
      ? [
          "- 다음 날짜형 일정은 현재보다 과거이므로 역사·완료 항목으로만 취급한다:",
          ...anchors.slice(0, 8).map((anchor) => `  - ${anchor.dateLabel}: ${anchor.keywords.slice(0, 6).join(", ")}`),
        ]
      : []),
  ].join("\n");
}
