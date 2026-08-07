import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { db } from "@/lib/db";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { generateText, summarizeLongMemoryKorean, summarizeLongMemorySectionKorean } from "@/lib/ai";
import { LONG_MEMORY_SUMMARY_RULES, stripUrlsAndMediaMarkdown } from "@/lib/memory_sanitize";
import {
  analyzeRelationshipCorrectionDrift,
  buildRelationshipCorrectionGuidance,
} from "@/lib/relationship_memory";
import {
  analyzeIdentityCanonDrift,
  buildIdentityCanonBlock,
  inferPersonaNameFromMessages,
} from "@/lib/identity_memory";
import { formatRelationshipGraphBlock, loadRelationshipGraph } from "@/lib/relationship_graph";
import {
  buildEpistemicPromptFirewall,
  omitWorldOnlyRelationshipsFromPrompt,
  sanitizeSharedEpistemicText,
} from "@/lib/epistemic_prompt_firewall";
import { removeUnsupportedLegalStatusClaims } from "@/lib/legal_status_consistency_guard";
import {
  applyStructuredCharacterGraph,
  extractStructuredCharacterGraph,
  loadStructuredCharacterIdentities,
} from "@/lib/structured_relationship_memory";
import {
  analyzeCanonicalFactDrift,
  buildAuthoritativePersonaFacts,
  formatCanonicalCharacterFactsBlock,
  loadCanonicalCharacterFacts,
} from "@/lib/canonical_character_facts";
import { buildSpatialCanon } from "@/lib/spatial_canon";

import { bad, requireChatAccess } from "@/app/api/memory/_util";

import { selectRecentByUserTurns } from "@/app/api/chat/send/_server/textPolicy";
import {
  selectMessagesForAssistantTurnRange,
  selectMessagesForAssistantTurnRangeCapped,
} from "@/app/api/chat/send/_server/turnRange";
import {
  getSummarizedEndTurn,
  extractSummarySections,
  hasRangeBlock,
  normalizeStoredMemorySummary,
  strlenSummary,
} from "@/app/api/chat/send/_server/summaryStored";
import {
  normalizeSummaryTail,
  sanitizeLongMemorySummary,
  upsertSummaryRangeBlock,
} from "@/app/api/chat/send/_server/memory";

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function pickLongMemorySummaryModel() {
  const forced = String(process.env.LONG_MEMORY_SUMMARY_MODEL || "").trim();
  if (forced) return forced;

  // Long-memory refresh always prefers fast/cheap summarization.
  return "gemini-3.6-flash";
}

function pickLongMemorySummaryFallbackModel() {
  const forced = String(process.env.LONG_MEMORY_SUMMARY_FALLBACK_MODEL || "").trim();
  if (forced) return forced;
  // Default is flash-only. Enable fallback only when explicitly forced by env.
  return "";
}

function extractSectionTitle(raw: string): string {
  const src = String(raw || "").replace(/\r\n/g, "\n");
  const m = src.match(/^\s*###\s*(.*?)\s*\(\s*\d+\s*(?:[-–—~]\s*\d+\s*)?턴\s*\)\s*$/m);
  const t = String(m?.[1] || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > 28 ? t.slice(0, 28).trim() : t;
}

function countAssistantTurns(all: Array<{ role: string }>) {
  const firstUserPos = all.findIndex((m) => m.role === "user");
  if (firstUserPos < 0) return 0;
  let turns = 0;
  for (let i = firstUserPos; i < all.length; i++) {
    // DB에는 assistant가 "assistant" 또는 "model"로 저장될 수 있다.
    // (turnRange 셀렉터와 일치시키지 않으면 completedTurnCount=0으로 고정되어
    // boundaryEndTurn이 0이 되어 요약이 영원히 생성되지 않는 문제가 생긴다.)
    if (all[i].role === "assistant" || all[i].role === "model") turns++;
  }
  return turns;
}

function formatTurnsLocal(turns: Array<{ role: string; content: string }>) {
  return turns
    .map((m) => {
      const tag = m.role === "user" ? "[사용자]" : "[어시스턴트]";
      return `${tag} ${m.content}`;
    })
    .join("\n\n");
}

function deterministicMemorySnippet(value: unknown, maxChars: number) {
  const normalized = stripUrlsAndMediaMarkdown(String(value || ""), { keepHeadings: false })
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[^|\n]{1,40}\s*\|\s*/gm, "")
    .replace(/[\*_`#>\[\]]+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  const limit = Math.max(36, Math.floor(maxChars));
  if (normalized.length <= limit) {
    return /[.!?…。]$/u.test(normalized) ? normalized : `${normalized}.`;
  }
  const head = normalized.slice(0, limit);
  const sentenceEnd = Math.max(
    head.lastIndexOf("."),
    head.lastIndexOf("!"),
    head.lastIndexOf("?"),
    head.lastIndexOf("。"),
    head.lastIndexOf("…")
  );
  if (sentenceEnd >= Math.floor(limit * 0.55)) return head.slice(0, sentenceEnd + 1).trim();
  return `${head.trim()}…`;
}

function buildDeterministicMemorySection(params: {
  turns: Array<{ role: string; content: string }>;
  startTurn: number;
  endTurn: number;
  targetChars: number;
}) {
  const completedTurns: Array<{ userText: string; assistantText: string }> = [];
  let pendingUserText = "";
  for (const turn of params.turns) {
    const role = String(turn?.role || "").toLowerCase();
    if (role === "user") {
      pendingUserText = String(turn?.content || "");
      continue;
    }
    if (role !== "assistant" && role !== "model") continue;
    completedTurns.push({
      userText: pendingUserText,
      assistantText: String(turn?.content || ""),
    });
    pendingUserText = "";
  }
  const perTurn = Math.max(48, Math.floor(params.targetChars / Math.max(1, completedTurns.length)) - 10);
  const rows = completedTurns
    .map((turn, index) => {
      // 모델 출력이 사용자 지문·설정 정정을 거슬렀을 수 있으므로,
      // 결정론적 최후 보존본은 해당 턴의 사용자 원문을 우선한다.
      const snippet = deterministicMemorySnippet(turn.userText || turn.assistantText, perTurn);
      return snippet ? `${params.startTurn + index}턴: ${snippet}` : "";
    })
    .filter(Boolean);
  const body = rows.join(" ") || "해당 구간의 대화 원문은 보존되었으며 다음 갱신에서 다시 분석한다.";
  return `### 대화 자동 보존 (${params.startTurn}-${params.endTurn}턴)\n${body}`;
}

function formatMemoryBlockSection(section: { startTurn: number; endTurn: number; title: string; body: string }) {
  return `### ${section.title} (${section.startTurn}-${section.endTurn}턴)\n${section.body}`.trim();
}

function backfillMemoryBlocksFromSummary(params: {
  chatId: string;
  summary: string;
  summaryEvery: number;
  summaryLength: number;
  now: number;
}) {
  const sections = extractSummarySections(params.summary);
  if (!sections.length) return 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO chat_memory_blocks
       (chatId, startTurn, endTurn, summary, summaryChars, summaryEvery, summaryLength, model, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction((rows: typeof sections) => {
    for (const section of rows) {
      const summary = formatMemoryBlockSection(section);
      insert.run(
        params.chatId,
        section.startTurn,
        section.endTurn,
        encryptIfPossible(summary),
        strlenSummary(summary),
        params.summaryEvery,
        params.summaryLength,
        "cache",
        JSON.stringify({ source: "cache_backfill" }),
        params.now,
        params.now
      );
    }
  });

  run(sections);
  return sections.length;
}

function upsertMemoryBlock(params: {
  chatId: string;
  startTurn: number;
  endTurn: number;
  summary: string;
  summaryEvery: number;
  summaryLength: number;
  model: string;
  meta: unknown;
  now: number;
}) {
  const summary = String(params.summary || "").trim();
  if (!summary) return;

  db.prepare(
    `INSERT INTO chat_memory_blocks
       (chatId, startTurn, endTurn, summary, summaryChars, summaryEvery, summaryLength, model, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, startTurn) DO UPDATE SET
       endTurn=excluded.endTurn,
       summary=excluded.summary,
       summaryChars=excluded.summaryChars,
       summaryEvery=excluded.summaryEvery,
       summaryLength=excluded.summaryLength,
       model=excluded.model,
       meta=excluded.meta,
       updatedAt=excluded.updatedAt`
  ).run(
    params.chatId,
    params.startTurn,
    params.endTurn,
    encryptIfPossible(summary),
    strlenSummary(summary),
    params.summaryEvery,
    params.summaryLength,
    params.model,
    JSON.stringify(params.meta ?? {}),
    params.now,
    params.now
  );
}

type BodyQuality = {
  ok: boolean;
  reason: string;
  hangul: number;
  latin: number;
  latinRatio: number;
  badMarker: boolean;
};

function analyzeLongMemoryBody(body: string): BodyQuality {
  const t = String(body || "").replace(/\r\n/g, "\n").trim();
  const hangul = (t.match(/[가-힣]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const denom = hangul + latin;
  const latinRatio = denom > 0 ? latin / denom : 0;

  const badMarker =
    /^\s*(?:thought|analysis|reasoning)\b/i.test(t) ||
    /\b(?:Characters?|Setting)\b\s*[:：]/i.test(t) ||
    /\bDialogue\b\s*[:：]/i.test(t);

  // Heuristics: we expect Korean-dominant text with only minimal ASCII.
  // Allow small amounts of ASCII for codes like Z8/LV50, but block obvious English-heavy bodies.
  const tooMuchEnglish = (latin >= 24 && latinRatio > 0.35) || (latin >= 48 && hangul < 24);

  // Another common failure: dangling open paren at the end of the body.
  const danglingParen = /\([^)]*$/.test(t) || /（[^）]*$/.test(t);

  // Another common failure: the body ends with an obviously dangling Korean token
  // due to local trimming (e.g. "...에게 이."), which feels like the summary is "cut off".
  const lastLine = (t.split("\n").map((x) => x.trim()).filter(Boolean).pop() || t).trim();
  const badTailToken =
    /(?:^|\s)(그리고|하지만|또는|및|그래서|즉|때문에)(?:[.!?…。]|$)/.test(lastLine) ||
    /(?:^|\s)(이|그|저|내|네|제|또)(?:[.!?…。]|$)/.test(lastLine);
  const goodEnding =
    /[.!?…。]$/.test(lastLine) || /(다|요|함|됨|했다|하였다|된다|됐다|있다|없다|였다|이었다|한다)\.?$/.test(lastLine);

  if (!t) {
    return { ok: false, reason: "empty", hangul, latin, latinRatio, badMarker };
  }
  if (badMarker) {
    return { ok: false, reason: "bad_marker", hangul, latin, latinRatio, badMarker };
  }
  if (tooMuchEnglish) {
    return { ok: false, reason: "too_much_english", hangul, latin, latinRatio, badMarker };
  }
  if (danglingParen && latin >= 10) {
    return { ok: false, reason: "dangling_paren", hangul, latin, latinRatio, badMarker };
  }
  if (badTailToken && t.length >= 30) {
    return { ok: false, reason: "bad_tail_token", hangul, latin, latinRatio, badMarker };
  }
  if (!goodEnding && t.length >= 40) {
    return { ok: false, reason: "bad_ending", hangul, latin, latinRatio, badMarker };
  }

  return { ok: true, reason: "ok", hangul, latin, latinRatio, badMarker };
}

// 신규 생성 결과에만 적용하는 엄격한 자기검토/메타 유출 검사다.
// 기존 저장본 복구 판단(firstBadSectionRange)은 기존 검사기를 유지해,
// 배포만으로 과거 채팅 내용을 재작성하지 않는다.
const GENERATED_MEMORY_SELF_REVIEW_MARKER =
  /(?:Wait\s*,?\s*check|Let['’]?s\s+check|Total\s+length|Target\s*[~:：]|Perfect!|Character\s*&\s*Constraint\s*Check|Detailed\s+Character|All\s+in\s+list|Alphabet\s*[:：]|Markdown\s*[:：]|Labels?\s*[:：]|\b\d+\s*(?:chars?|characters?)\b|시스템\s*지침|개발자\s*프롬프트|오버라이드|요구사항\s*(?:검토|확인)|글자\s*수\s*(?:검토|확인))/i;

function analyzeGeneratedLongMemoryBody(body: string): BodyQuality {
  const base = analyzeLongMemoryBody(body);
  if (!base.ok) return base;

  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (GENERATED_MEMORY_SELF_REVIEW_MARKER.test(text)) {
    return {
      ...base,
      ok: false,
      reason: "model_self_review",
      badMarker: true,
    };
  }

  return base;
}

type NameDriftQuality = {
  ok: boolean;
  reason: string;
  sourceNames: string[];
  summaryNames: string[];
  unknownNames: string[];
};

const SURNAME_CHARS = "김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우";
const NON_NAME_KR3 = new Set([
  "신입생",
  "운동장",
  "유니폼",
  "정적만",
  "조감도",
  "전방에",
  "없다는",
  "이해도",
  "이번에",
  "배에서",
  "주저앉",
  "차단하",
  "장면들",
  "임원들",
  "신청서",
  "정답이",
  "하이라이",
  "차림의",
  "성준슛",
  "정신력",
  "주전조",
  "이없다",
  "신거리",
]);
const NAME_FOLLOW_PARTICLES = [
  "에게서",
  "한테서",
  "에게는",
  "한테는",
  "으로는",
  "으로",
  "에게",
  "한테",
  "에서",
  "부터",
  "까지",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "와",
  "과",
  "의",
  "도",
  "만",
  "로",
  "랑",
  "께",
  "뿐",
  "나",
  "이나",
];

function isLikelyKoreanNameToken(token: string) {
  const t = String(token || "").trim();
  if (!new RegExp(`^[${SURNAME_CHARS}][가-힣]{2}$`).test(t)) return false;
  if (NON_NAME_KR3.has(t)) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// (자동 캐릭터 탐지) Auto character detection — strict mode
// ──────────────────────────────────────────────────────────────────────
//
// 정책:
// - 요약 갱신(3턴 boundary) 직후, 같은 윈도우 raw 텍스트에서 LLM으로 인물 후보 추출
// - 코드 레벨에서 한 번 더 빡세게 필터: 블랙리스트 + 한글 이름 패턴 + evidence 검증 + 출현 2회+ + 페르소나/기존 로스터 제외
// - INSERT ... ON CONFLICT DO NOTHING 으로 수동 입력 절대 안 건드림
// - 탐지 실패는 무시(요약 저장은 영향 받지 않음)

const AUTO_CHARACTER_NAME_BLACKLIST: ReadonlySet<string> = new Set([
  // 메타/지시 어휘
  "사용자", "주인공", "플레이어", "유저", "독자", "관객", "본인", "자기", "당신",
  "그녀", "우리", "그들", "남자", "여자", "사람", "사람들", "누군가", "모두",
  // 가족/관계 호칭
  "엄마", "아빠", "어머니", "아버지", "부모", "형", "누나", "오빠", "언니", "동생",
  "형제", "자매", "할머니", "할아버지", "할매", "할배", "친구", "지인", "동기", "동료",
  "친지", "가족", "삼촌", "이모", "고모", "외삼촌", "외숙모", "조카", "사촌",
  // 일반 역할/직책
  "사장", "사장님", "선생", "선생님", "교수", "교수님", "박사", "원장", "팀장", "과장",
  "부장", "대리", "주임", "사원", "직원", "알바", "알바생", "점원", "손님", "고객",
  "학생", "학우", "후배", "선배", "신입생", "복학생", "교사", "강사", "조교",
  // 호칭/존칭
  "아저씨", "아줌마", "아주머니", "어르신", "어른", "꼬마", "아이", "애기",
  "아이들", "꼬맹이", "녀석", "이놈", "그놈", "저놈",
  // 캐릭터/스토리 메타
  "캐릭터", "등장인물", "인물", "조연", "엑스트라", "악역", "주역",
  "상대", "상대방", "파트너", "팀원", "멤버",
]);

const KOREAN_NAME_PATTERN = /^[가-힣]{2,4}$/;

function countOccurrencesInText(haystack: string, needle: string): number {
  const h = String(haystack || "");
  const n = String(needle || "");
  if (!n) return 0;
  let count = 0;
  let i = 0;
  while ((i = h.indexOf(n, i)) !== -1) {
    count++;
    i += n.length;
  }
  return count;
}

type AutoDetectedCharacter = { name: string; profile: string; evidence: string };

async function detectCharactersFromWindow(params: {
  rawWindowText: string;
  personaName: string;
  existingNames: Set<string>;
  llmOpts: { model: string; maxOutputTokens: number; maxReasoningTokens: number; thinkingBudget: number };
  windowStartTurn: number;
  windowEndTurn: number;
}): Promise<AutoDetectedCharacter[]> {
  const raw = String(params.rawWindowText || "").trim();
  // 짧은 윈도우는 신뢰성 떨어져 skip (소설 모드에선 보통 한 턴이 수백자 이상)
  if (!raw || raw.length < 80) return [];

  const persona = String(params.personaName || "").trim();

  const system = [
    "당신은 한국어 RP 대화에서 '의미 있게 등장하는 인물'을 정확히 골라내는 추출기입니다.",
    "규칙:",
    "1) 한국어 고유명(이름)으로 호명된 인물만. 호칭/역할(엄마/아빠/사장/선생/친구/언니/오빠/누나/아저씨/아주머니 등)은 이름이 아니므로 제외.",
    `2) 페르소나(주인공) '${persona || "(미지정)"}'은(는) 절대 추출 금지.`,
    "3) 단순 비유, 역사인물 인용, 작품/노래/장소 이름은 제외.",
    "4) 원문에 이름이 2번 이상 명시되었거나, 대사/행동/구체 묘사가 있는 인물만 추출. 한 번 스쳐가는 단순 언급은 제외.",
    "   (예: 친구의 친구 이름이 한 번 나오고 끝나면 제외. 약속 상대로 두 번 언급되면 OK.)",
    "5) 0명도 가능. 확실하지 않으면 추출하지 마세요.",
    "6) 출력은 JSON 배열 ONLY. 코드펜스/설명/머리말 금지.",
    "스키마: [{\"name\":\"한글이름\",\"profile\":\"한 줄 인물 요약\",\"evidence\":\"원문에서 그대로 인용한 짧은 문장\"}]",
    "evidence는 반드시 원문에서 글자 그대로 복사한 문장이어야 합니다(요약 절대 금지).",
    `기존 등록 인물(중복 추출 불필요): ${[...params.existingNames].slice(0, 30).join(", ") || "(없음)"}`,
  ].join("\n");

  const user = `다음은 ${params.windowStartTurn}~${params.windowEndTurn}턴 원문입니다. 위 규칙대로 JSON 배열만 출력하세요.\n\n${raw}`;

  let outText = "";
  try {
    const r = await generateText({
      system,
      user,
      opts: {
        model: params.llmOpts.model,
        // gemini-3-flash-preview는 reasoning 토큰을 따로 소비하므로
        // 작은 cap을 주면 reasoning이 다 먹어버려 text가 빈 채로 MAX_TOKENS로 잘린다.
        // 추출 출력은 짧지만 reasoning 헤드룸을 충분히 확보해 둔다.
        //
        // (2026-07-30 실측, 현재 모델 gemini-3.6-flash 기준) 아래 thinkingBudget /
        // maxReasoningTokens=128은 강제되지 않는다. buildThinkingConfig가 3.6-flash에서
        // 128(<1024)을 thinkingLevel="medium"으로 매핑하고(3.6의 최저 지원 레벨),
        // medium이 reasoning 2576~2581 토큰을 쓴다.
        // thinking과 가시출력이 한 예산을 공유하므로 cap 2048(+medium 헤드룸≈640)에서는
        // 848콜 중 13콜이 outputTokens≈105로 잘려 JSON이 중간에 끊겼고,
        // extractJson이 null을 반환해 추출 결과가 조용히 버려졌다.
        // medium reasoning(≈2.6k)과 실제 출력이 모두 들어가도록 헤드룸을 늘린다.
        maxOutputTokens: 4096,
        maxReasoningTokens: 128,
        thinkingBudget: 128,
        temperature: 0.1,
        topP: 0.9,
      },
    });
    outText = String((r as any)?.text || "").trim();
  } catch (e: any) {
    if (process.env.CHAT_DEBUG === "1") console.log(JSON.stringify({ tag: "autochar.llm.error", err: String(e?.message || e) }));
    return [];
  }
  if (!outText) {
    if (process.env.CHAT_DEBUG === "1") console.log(JSON.stringify({ tag: "autochar.llm.empty" }));
    return [];
  }

  // 첫 번째 JSON 배열만 파싱 (모델이 머리말 붙이더라도 견고)
  let parsed: any[] = [];
  try {
    const m = outText.match(/\[[\s\S]*\]/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {
    parsed = [];
  }
  if (process.env.CHAT_DEBUG === "1") {
    console.log(JSON.stringify({
      tag: "autochar.llm.raw",
      rawTextSample: outText.slice(0, 500),
      parsedLen: Array.isArray(parsed) ? parsed.length : -1,
      parsedSample: Array.isArray(parsed) ? parsed.slice(0, 5) : null,
    }));
  }
  if (!Array.isArray(parsed)) return [];

  const out: AutoDetectedCharacter[] = [];
  const seen = new Set<string>();
  const rejects: any[] = [];
  for (const item of parsed) {
    const name = String(item?.name || "").trim();
    const profile = String(item?.profile || "").trim();
    const evidence = String(item?.evidence || "").trim();

    // strict filters — 하나라도 실패하면 reject
    if (!KOREAN_NAME_PATTERN.test(name)) { rejects.push({ name, reason: "pattern" }); continue; }
    if (AUTO_CHARACTER_NAME_BLACKLIST.has(name)) { rejects.push({ name, reason: "blacklist" }); continue; }
    if (persona && name === persona) { rejects.push({ name, reason: "persona" }); continue; }
    if (params.existingNames.has(name)) { rejects.push({ name, reason: "existing" }); continue; }
    if (seen.has(name)) { rejects.push({ name, reason: "duplicate" }); continue; }
    if (!evidence || evidence.length < 4) { rejects.push({ name, reason: "no_evidence" }); continue; }
    if (!raw.includes(evidence)) { rejects.push({ name, reason: "evidence_not_in_raw", evidence: evidence.slice(0, 80) }); continue; }
    if (countOccurrencesInText(raw, name) < 2) { rejects.push({ name, reason: "low_count", count: countOccurrencesInText(raw, name) }); continue; }

    seen.add(name);
    out.push({
      name,
      profile: profile.slice(0, 200),
      evidence: evidence.slice(0, 300),
    });
  }
  if (process.env.CHAT_DEBUG === "1") {
    console.log(JSON.stringify({
      tag: "autochar.result",
      accepted: out.map((o) => o.name),
      rejected: rejects,
    }));
  }
  return out;
}

const STRUCTURED_GRAPH_WINDOW_TURNS = 12;
const AUTO_CHARACTER_BACKFILL_TURNS = 12;

type StructuredGraphRefreshOutcome = {
  attempted: boolean;
  structuredGraphParsed: boolean;
  structuredGraphRefreshed: boolean;
  fallbackUsed: boolean;
  candidateNames: string[];
  missingCandidateNames: string[];
  autoCharactersAdded: string[];
  autoAliasesUpdated: string[];
  autoRelationshipsUpserted: number;
  autoFactsUpserted: number;
};

async function refreshStructuredCharacterState(params: {
  chatId: string;
  personaName: string;
  personaAge: number;
  personaGender: string;
  personaInfo: string;
  summaryModel: string;
  graphWindowText: string;
  graphWindowStartTurn: number;
  graphWindowEndTurn: number;
  now: number;
}): Promise<StructuredGraphRefreshOutcome> {
  const empty = (): StructuredGraphRefreshOutcome => ({
    attempted: true,
    structuredGraphParsed: false,
    structuredGraphRefreshed: false,
    fallbackUsed: false,
    candidateNames: [],
    missingCandidateNames: [],
    autoCharactersAdded: [],
    autoAliasesUpdated: [],
    autoRelationshipsUpserted: 0,
    autoFactsUpserted: 0,
  });

  try {
    const existingRosterRows = db
      .prepare(
        `SELECT name FROM chat_character_roster WHERE chatId=? AND enabled != 0`
      )
      .all(params.chatId) as Array<{ name: string }>;
    const existingNames = new Set<string>(
      existingRosterRows.map((row) => String(row?.name || "").trim()).filter(Boolean)
    );
    const candidateNames: string[] = [];
    const wasRosterEmpty = existingNames.size === 0;
    const authoritativePersona = buildAuthoritativePersonaFacts({
      name: params.personaName,
      age: params.personaAge,
      gender: params.personaGender,
      info: params.personaInfo,
    });
    const structuredGraph = await extractStructuredCharacterGraph({
      rawWindowText: params.graphWindowText,
      personaName: params.personaName,
      existingCharacters: loadStructuredCharacterIdentities(params.chatId),
      existingFacts: loadCanonicalCharacterFacts(params.chatId),
      authoritativePersona,
      llmOpts: {
        model: params.summaryModel,
        maxOutputTokens: 4096,
        maxReasoningTokens: 128,
        thinkingBudget: 128,
      },
      windowStartTurn: params.graphWindowStartTurn,
      windowEndTurn: params.graphWindowEndTurn,
    });

    const acceptedNames = new Set(
      structuredGraph.characters
        .filter(
          (character) =>
            character.id !== "persona" &&
            String(character.mainName || "").trim() !== params.personaName
        )
        .map((character) => String(character.mainName || "").trim())
        .filter(Boolean)
    );
    const missingCandidateNames: string[] = [];
    const shouldUseFallback =
      !structuredGraph.ok || wasRosterEmpty;

    let autoCharactersAdded: string[] = [];
    let autoAliasesUpdated: string[] = [];
    let autoRelationshipsUpserted = 0;
    let autoFactsUpserted = 0;
    if (structuredGraph.ok) {
      const applied = applyStructuredCharacterGraph({
        chatId: params.chatId,
        personaName: params.personaName,
        graph: structuredGraph,
        turnNo: params.graphWindowEndTurn,
      });
      autoCharactersAdded = applied.charactersAdded;
      autoAliasesUpdated = applied.aliasesUpdated;
      autoRelationshipsUpserted = applied.relationshipsUpserted;
      autoFactsUpserted = applied.factsUpserted;
    }

    let detected: AutoDetectedCharacter[] = [];
    if (shouldUseFallback) {
      detected = await detectCharactersFromWindow({
        rawWindowText: params.graphWindowText,
        personaName: params.personaName,
        existingNames: new Set([
          ...existingNames,
          ...autoCharactersAdded,
        ]),
        llmOpts: {
          model: params.summaryModel,
          maxOutputTokens: 600,
          maxReasoningTokens: 0,
          thinkingBudget: 0,
        },
        windowStartTurn: params.graphWindowStartTurn,
        windowEndTurn: params.graphWindowEndTurn,
      });
    }

    if (detected.length > 0) {
      const insertStmt = db.prepare(
        `INSERT INTO chat_character_roster
           (id, chatId, name, aliases, role, profile, relationshipNote, emotionNote, status, enabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chatId, name) DO NOTHING`
      );
      const inserted: string[] = [];
      const insertMany = db.transaction((items: AutoDetectedCharacter[]) => {
        for (const character of items) {
          const profileText = character.profile
            ? `(자동 탐지) ${character.profile}`
            : "(자동 탐지)";
          const result = insertStmt.run(
            randomUUID(),
            params.chatId,
            character.name,
            encryptIfPossible(""),
            encryptIfPossible(""),
            encryptIfPossible(profileText),
            encryptIfPossible(""),
            encryptIfPossible(""),
            encryptIfPossible(""),
            1,
            params.now,
            params.now
          );
          if (Number((result as { changes?: unknown })?.changes || 0) > 0) {
            inserted.push(character.name);
          }
        }
      });
      insertMany(detected);
      autoCharactersAdded = [...new Set([...autoCharactersAdded, ...inserted])];
    }

    const structuredGraphRefreshed =
      structuredGraph.ok &&
      (acceptedNames.size > 0 ||
        structuredGraph.relationships.length > 0 ||
        structuredGraph.facts.length > 0);
    if (process.env.CHAT_DEBUG === "1") {
      console.log(JSON.stringify({
        tag: "structuredGraph.refresh",
        chatId: params.chatId,
        window: [params.graphWindowStartTurn, params.graphWindowEndTurn],
        structuredGraphParsed: structuredGraph.ok,
        structuredGraphRefreshed,
        fallbackUsed: shouldUseFallback,
        candidateNames,
        missingCandidateNames,
        autoCharactersAdded,
        autoAliasesUpdated,
        autoRelationshipsUpserted,
        autoFactsUpserted,
      }));
    }
    return {
      attempted: true,
      structuredGraphParsed: structuredGraph.ok,
      structuredGraphRefreshed,
      fallbackUsed: shouldUseFallback,
      candidateNames,
      missingCandidateNames,
      autoCharactersAdded,
      autoAliasesUpdated,
      autoRelationshipsUpserted,
      autoFactsUpserted,
    };
  } catch (error: unknown) {
    if (process.env.CHAT_DEBUG === "1") {
      console.log(JSON.stringify({
        tag: "structuredGraph.refresh_error",
        chatId: params.chatId,
        window: [params.graphWindowStartTurn, params.graphWindowEndTurn],
        error: String((error as { message?: unknown })?.message || error),
      }));
    }
    return empty();
  }
}

async function backfillAutoCharacterMemories(params: {
  req: Request;
  chatId: string;
  autoCharactersAdded: string[];
  turnLimit?: number;
}) {
  if (!params.autoCharactersAdded.length) return null;
  const recentAssistantIds = db
    .prepare(
      `SELECT id FROM messages
       WHERE chatId=? AND (role='assistant' OR role='model')
       ORDER BY createdAt DESC, id DESC
       LIMIT ?`
    )
    .all(
      params.chatId,
      Math.max(1, Number(params.turnLimit || AUTO_CHARACTER_BACKFILL_TURNS))
    ) as Array<{ id: string }>;
  const ids = recentAssistantIds.map((row) => String(row?.id || "")).filter(Boolean);
  if (!ids.length) return null;

  const origin = new URL(params.req.url).origin;
  const refreshUrl = `${origin}/api/chat/characters/refresh`;
  const cookieHeader = params.req.headers.get("cookie") || "";
  let savedCount = 0;
  // 한꺼번에 12개를 호출하면 Flash rate limit에 걸릴 수 있어 3개씩 처리한다.
  for (let index = 0; index < ids.length; index += 3) {
    const batch = ids.slice(index, index + 3);
    const results = await Promise.allSettled(
      batch.map((assistantMessageId) =>
        fetch(refreshUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          body: JSON.stringify({ chatId: params.chatId, assistantMessageId }),
        }).then((response) => response.json().catch(() => null))
      )
    );
    for (const result of results) {
      if (
        result.status === "fulfilled" &&
        result.value &&
        typeof result.value === "object"
      ) {
        savedCount += Math.max(
          0,
          Number((result.value as { saved?: unknown }).saved || 0)
        );
      }
    }
  }
  return { turns: ids.length, savedCount };
}

function collectLikelyKoreanNames(text: string) {
  const src = String(text || "");
  const out = new Set<string>();
  const re = new RegExp(`[${SURNAME_CHARS}][가-힣]{2}`, "g");
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(src)) !== null) {
    const name = String(m?.[0] || "").trim();
    if (!isLikelyKoreanNameToken(name)) continue;

    const idx = Number(m?.index || 0);
    const prev = idx > 0 ? src[idx - 1] : "";
    if (prev && /[가-힣]/.test(prev)) continue;

    const after = src.slice(idx + 3);
    if (!after) {
      out.add(name);
      continue;
    }
    const ch = after[0];
    if (!/[가-힣]/.test(ch)) {
      out.add(name);
      continue;
    }
    if (NAME_FOLLOW_PARTICLES.some((p) => after.startsWith(p))) {
      out.add(name);
      continue;
    }
  }
  return out;
}

function analyzeNameDrift(body: string, sourceNames: Set<string>, allowNames: string[] = []): NameDriftQuality {
  const allow = new Set<string>();
  for (const n of sourceNames) allow.add(n);
  for (const n of allowNames) {
    if (isLikelyKoreanNameToken(n)) allow.add(n);
  }

  const summaryNames = [...collectLikelyKoreanNames(body)].sort((a, b) => a.localeCompare(b, "ko-KR"));
  const source = [...allow].sort((a, b) => a.localeCompare(b, "ko-KR"));
  if (!summaryNames.length) {
    return {
      ok: true,
      reason: "no_names_in_summary",
      sourceNames: source,
      summaryNames,
      unknownNames: [],
    };
  }

  const unknownNames = summaryNames.filter((n) => !allow.has(n));
  if (unknownNames.length > 0) {
    return {
      ok: false,
      reason: "unknown_name_in_summary",
      sourceNames: source,
      summaryNames,
      unknownNames,
    };
  }
  return {
    ok: true,
    reason: "ok",
    sourceNames: source,
    summaryNames,
    unknownNames: [],
  };
}

function firstBadSectionRange(summary: string, boundaryEndTurn: number) {
  const sections = extractSummarySections(String(summary || ""));
  const ordered = [...sections].sort((a, b) => a.startTurn - b.startTurn);
  for (const s of ordered) {
    if (s.endTurn > boundaryEndTurn) continue;
    // (변경 2026-08) 저장본 복구 판정에도 self-review 마커 검사를 적용한다.
    // 모델의 사고/자기검증 텍스트("Wait, check...", "(71 chars) Total length...",
    // "시스템 지침의 마크다운 금지는 오버라이드할 수 없다...")가 요약 본문으로 저장된
    // 사례가 실제로 확인됐고, 기존 analyzeLongMemoryBody는 한국어 사고문을 걸러내지 못했다.
    // 이 판정은 repairCorrupted=true 로 명시 요청했을 때만 사용되므로,
    // "배포만으로 과거 채팅이 재작성되지 않는다"는 기존 원칙은 그대로 유지된다.
    const q = analyzeGeneratedLongMemoryBody(s.body);
    if (!q.ok) return { startTurn: s.startTurn, endTurn: s.endTurn, title: s.title, quality: q };
  }
  return null;
}

// B-mode (요약.txt): fixed policy
const SUMMARY_EVERY_ASSISTANT_TURNS = 3; // 3 assistant turns per window
const KEEP_USER_TURNS = 7; // exclude last 7 user turns from summarization input

// NOTE: keep 160 supported (some UIs used it historically).
const PER_TURN_OPTIONS = [80, 140, 160, 200, 260, 320] as const;

type PerTurnChars = (typeof PER_TURN_OPTIONS)[number];

function normalizePerTurnChars(v: any): PerTurnChars {
  const n = Number(v);
  if (!Number.isFinite(n)) return PER_TURN_OPTIONS[0];
  if (PER_TURN_OPTIONS.includes(n as PerTurnChars)) return n as PerTurnChars;
  // closest match
  let best: PerTurnChars = PER_TURN_OPTIONS[0];
  for (const opt of PER_TURN_OPTIONS) {
    if (Math.abs(opt - n) < Math.abs(best - n)) best = opt;
  }
  return best;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = String(body?.chatId || "").trim();
    if (!chatId) return bad("chatId가 필요합니다.");

    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    // settings (model + token budgets)
    const st = db
      .prepare(
        `SELECT model, maxOutputTokens, maxReasoningTokens, thinkingBudget,
                personaName, personaAge, personaGender, personaInfo, longMemoryPerTurnChars
         FROM chat_settings WHERE chatId=?`
      )
      .get(chatId) as any;

    const runtime = (body?.runtime ?? {}) as any;
    const summaryEveryVal = SUMMARY_EVERY_ASSISTANT_TURNS; // must match /api/chat/send shouldRefresh logic
    const keepUserTurnsVal = KEEP_USER_TURNS;
    const perTurnCharsVal = normalizePerTurnChars(body?.perTurnChars ?? st?.longMemoryPerTurnChars ?? 80);
    // 손상된 구간은 기본적으로 자동 복구한다. 명시적으로 false인 관리 요청만 건너뛴다.
    const repairCorrupted = body?.repairCorrupted !== false;
    // 불량 출력 강제 저장은 로컬 개발에서 환경변수까지 명시한 경우에만 허용한다.
    // 브라우저/DOS 클라이언트가 실수로 true를 보내도 운영 DB에는 저장되지 않는다.
    const allowBadOutputSave =
      process.env.NODE_ENV !== "production" &&
      String(process.env.AI_LONG_MEMORY_DEBUG_ALLOW_BAD_OUTPUT_SAVE || "").trim() === "1" &&
      Boolean(body?.allowBadOutputSave);

    // load & decrypt all messages
    const rawAll = db
      .prepare(
        `SELECT id, chatId, role, content, imagesJson, createdAt, updatedAt
         FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC`
      )
      .all(chatId) as any[];

    const decryptedAll = rawAll.map((m) => ({
      ...m,
      content: decryptIfPossible(m.content),
      imagesJson: decryptIfPossible(m.imagesJson),
    }));
    const preRefreshGraph = loadRelationshipGraph(chatId);
    const epistemicFirewall = buildEpistemicPromptFirewall(preRefreshGraph);
    let all = decryptedAll.map((message) => {
      if (message.role !== "assistant" && message.role !== "model") return message;
      return {
        ...message,
        content: sanitizeSharedEpistemicText(
          message.content,
          epistemicFirewall
        ).text,
      };
    });

    const completedTurnCount = countAssistantTurns(all);
    const summaryModel = pickLongMemorySummaryModel();
    const configuredPersonaName = String(st?.personaName || "").trim();
    const inferredPersonaName = configuredPersonaName
      ? ""
      : inferPersonaNameFromMessages(all);
    const personaName = configuredPersonaName || inferredPersonaName;
    const legalStatusIdentities = [
      ...(personaName
        ? [{ name: personaName, aliases: [], isPersona: true }]
        : []),
      ...preRefreshGraph.nodes.map((node) => ({
        name: node.name,
        aliases: [],
        isPersona: Boolean(node.isPersona),
      })),
    ];
    const trustedLegalStatusUserTexts = decryptedAll
      .filter((message) => message.role === "user")
      .map((message) => String(message.content || ""));
    // 이미 저장된 서술은 확정 사실이다. 요약을 만들기 전에 이걸 근거에서 빼면
    // 서술로만 성립한 사건(예: 구속)이 사라진 채로 장기기억이 굳어버린다.
    const trustedLegalStatusNarrationTexts = decryptedAll
      .filter((message) => message.role === "assistant" || message.role === "model")
      .map((message) => String(message.content || ""));
    all = all.map((message) => {
      if (message.role !== "assistant" && message.role !== "model") return message;
      return {
        ...message,
        content: removeUnsupportedLegalStatusClaims({
          text: message.content,
          trustedUserTexts: trustedLegalStatusUserTexts,
          trustedNarrationTexts: trustedLegalStatusNarrationTexts,
          identities: legalStatusIdentities,
        }).text,
      };
    });
    const personaAge = Math.max(0, Math.trunc(Number(st?.personaAge) || 0));
    const personaGender = String(st?.personaGender || "").trim();
    const personaInfo = String(st?.personaInfo || "").trim();
    const authoritativePersona = buildAuthoritativePersonaFacts({
      name: personaName,
      age: personaAge,
      gender: personaGender,
      info: personaInfo,
    });

    if (!configuredPersonaName && inferredPersonaName) {
      db.prepare(
        `UPDATE chat_settings SET personaName=?, updatedAt=? WHERE chatId=?`
      ).run(inferredPersonaName, Date.now(), chatId);
    }

    // Only summarize complete blocks.
    const boundaryEndTurn = Math.floor(completedTurnCount / summaryEveryVal) * summaryEveryVal;
    if (boundaryEndTurn <= 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: "no_complete_block", summarizedEndTurn: 0, boundaryEndTurn, morePending: false });
    }

    // current cached summary
    const cache = db
      .prepare(
        `SELECT recentSummary, summarizedEndTurn, rolledUpCount, lastSummarizedAt
         FROM chat_memory_cache WHERE chatId=?`
      )
      .get(chatId) as any;

    let recentSummary = decryptIfPossible(String(cache?.recentSummary || ""));
    recentSummary = normalizeStoredMemorySummary(recentSummary, summaryEveryVal);
    const normalizedSummary = sanitizeLongMemorySummary(normalizeSummaryTail(recentSummary), summaryEveryVal);
    const didNormalizeSummary = normalizedSummary !== recentSummary;
    recentSummary = normalizedSummary;
    let memoryBlocksBackfilled = backfillMemoryBlocksFromSummary({
      chatId,
      summary: recentSummary,
      summaryEvery: summaryEveryVal,
      summaryLength: perTurnCharsVal,
      now: Date.now(),
    });

    const summarizedEndTurnText = Math.max(0, getSummarizedEndTurn(recentSummary));

    // IMPORTANT: Trust the actual stored summary content over the DB cursor.
    // Never revive a non-zero cursor when normalization removed every section.
    // Cursor/text mismatch otherwise skips the missing first window forever.
    const summarizedEndTurn = summarizedEndTurnText;

    const persistNormalizedSummaryIfNeeded = (nextSummarizedEndTurn: number) => {
      if (!didNormalizeSummary) return;
      const now = Date.now();
      const safeSummary = String(recentSummary || "");
      const contentEndTurn = Math.max(0, getSummarizedEndTurn(safeSummary));
      const requestedEndTurn = Math.max(0, Math.floor(Number(nextSummarizedEndTurn) || 0));
      const safeEndTurn = Math.min(requestedEndTurn, contentEndTurn);
      const safeSummaryChars = strlenSummary(safeSummary);
      db.prepare(
        `UPDATE chat_memory_cache
         SET recentSummary=?, recentSummaryChars=?, summarizedEndTurn=?, updatedAt=?
         WHERE chatId=?`
      ).run(
        encryptIfPossible(safeSummary),
        safeSummaryChars,
        safeEndTurn,
        now,
        chatId
      );
    };

    // Existing corrupted sections are repaired automatically before new windows advance.
    const repair = repairCorrupted ? firstBadSectionRange(recentSummary, boundaryEndTurn) : null;

    // 이미 장기요약이 끝난 기존 채팅이라도 roster가 비어 있으면 수동 새로고침에서
    // 마지막 12턴을 한 번 재분석한다. 관계 추출 실패가 요약 포인터 뒤에 영구히
    // 묻히던 문제를 복구한다.
    if (summarizedEndTurn >= boundaryEndTurn && !repair) {
      persistNormalizedSummaryIfNeeded(summarizedEndTurn);
      const rosterCount = Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM chat_character_roster WHERE chatId=? AND enabled != 0`)
            .get(chatId) as { count?: unknown }
        )?.count || 0
      );
      const relationshipCount = Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM chat_character_relations WHERE chatId=?`)
            .get(chatId) as { count?: unknown }
        )?.count || 0
      );
      const canonicalFactCount = loadCanonicalCharacterFacts(chatId).length;
      const shouldRepairGraph =
        rosterCount === 0 ||
        canonicalFactCount === 0 ||
        (rosterCount > 1 && relationshipCount === 0);
      if (shouldRepairGraph) {
        const wasRosterEmpty = rosterCount === 0;
        const graphWindowStartTurn = Math.max(
          1,
          boundaryEndTurn - STRUCTURED_GRAPH_WINDOW_TURNS + 1
        );
        const graphRangeTurns = selectMessagesForAssistantTurnRange(
          all,
          graphWindowStartTurn,
          boundaryEndTurn
        );
        const graphWindowText = stripUrlsAndMediaMarkdown(
          formatTurnsLocal(graphRangeTurns)
        );
        const graphOutcome = await refreshStructuredCharacterState({
          chatId,
          personaName,
          personaAge,
          personaGender,
          personaInfo,
          summaryModel,
          graphWindowText,
          graphWindowStartTurn,
          graphWindowEndTurn: boundaryEndTurn,
          now: Date.now(),
        });
        const autoCharactersBackfilled = await backfillAutoCharacterMemories({
          req,
          chatId,
          autoCharactersAdded: graphOutcome.autoCharactersAdded,
          turnLimit: Math.min(STRUCTURED_GRAPH_WINDOW_TURNS, boundaryEndTurn),
        }).catch(() => null);
        const graphChanged =
          graphOutcome.autoCharactersAdded.length > 0 ||
          graphOutcome.autoAliasesUpdated.length > 0 ||
          graphOutcome.autoRelationshipsUpserted > 0 ||
          graphOutcome.autoFactsUpserted > 0;
        return NextResponse.json({
          ok: true,
          refreshed: graphChanged,
          skipped: !graphChanged,
          reason: graphChanged
            ? wasRosterEmpty
              ? "uptodate_graph_bootstrapped"
              : "uptodate_graph_repaired"
            : wasRosterEmpty
              ? "uptodate_graph_still_empty"
              : "uptodate_graph_no_edges_found",
          summarizedEndTurn,
          boundaryEndTurn,
          normalizedSummary: didNormalizeSummary,
          memoryBlocksBackfilled,
          ...graphOutcome,
          autoCharactersBackfilled,
        });
      }
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "uptodate",
        summarizedEndTurn,
        boundaryEndTurn,
        normalizedSummary: didNormalizeSummary,
        memoryBlocksBackfilled,
      });
    }

    // Window to summarize (always aligned to summaryEveryVal)
    // - Normally we summarize the next not-yet-covered window.
    // - If `repair` exists, we regenerate that specific window instead.
    const windowStartTurn = repair ? repair.startTurn : Math.max(1, summarizedEndTurn + 1);
    const windowEndTurn = repair
      ? repair.endTurn
      : Math.min(windowStartTurn + summaryEveryVal - 1, boundaryEndTurn);

    // Guard: do not generate partial windows
    if (windowEndTurn !== windowStartTurn + summaryEveryVal - 1) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "partial_window_not_allowed",
        windowStartTurn,
        windowEndTurn,
        summarizedEndTurn,
        boundaryEndTurn,
        morePending: summarizedEndTurn < boundaryEndTurn,
      });
    }

    // If this window already exists, also skip.
    // However, when we're repairing a bad section, we MUST re-generate even if the range exists.
    if (!repair && hasRangeBlock(recentSummary, windowStartTurn, windowEndTurn)) {
      const nextEndTurn = Math.max(summarizedEndTurn, windowEndTurn);
      persistNormalizedSummaryIfNeeded(nextEndTurn);
      db.prepare(
        `UPDATE chat_memory_cache
         SET summarizedEndTurn=?, updatedAt=?
         WHERE chatId=?`
      ).run(nextEndTurn, Date.now(), chatId);

      const morePending = nextEndTurn < boundaryEndTurn;

      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "range_block_exists",
        windowStartTurn,
        windowEndTurn,
        summarizedEndTurn: nextEndTurn,
        boundaryEndTurn,
        morePending,
        normalizedSummary: didNormalizeSummary,
      });
    }


    // Exclude tail (last K user turns) to reduce overlap with recent raw context.
    const tail = selectRecentByUserTurns(all, keepUserTurnsVal);
    // NOTE: 대화가 짧거나(또는 K가 큰 경우) tail이 전체를 다 먹어 capIndex=0이 되면
    // capped selector가 항상 []가 되어 요약이 '영원히' 생성되지 않는 문제가 있었다.
    // 이런 경우에는 중복을 감수하고 uncapped로 fallback한다.
    let capIndex = Math.max(0, all.length - tail.length);
    if (capIndex <= 0) capIndex = all.length;

    let rangeTurns = selectMessagesForAssistantTurnRangeCapped(all, windowStartTurn, windowEndTurn, capIndex);
    if (!rangeTurns.length) {
      rangeTurns = selectMessagesForAssistantTurnRange(all, windowStartTurn, windowEndTurn);
    }
    if (!rangeTurns.length) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "empty_range_turns",
        windowStartTurn,
        windowEndTurn,
        summarizedEndTurn,
        boundaryEndTurn,
        morePending: summarizedEndTurn < boundaryEndTurn,
        capIndex,
      });
    }

    // Snapshot only the selected range.
    // New messages appended after this point should NOT invalidate this window summary.
    const sourceSig0 = rangeTurns.map((m) => ({
      id: String(m?.id ?? ""),
      role: String(m?.role ?? ""),
      createdAt: Number(m?.createdAt || 0),
      updatedAt: Number(m?.updatedAt || 0),
    }));

    const rawText = formatTurnsLocal(rangeTurns);
    const cleanedText = stripUrlsAndMediaMarkdown(rawText);

    const llmOpts = {
      model: summaryModel,
      maxOutputTokens: clampInt(runtime?.maxOutputTokens ?? st?.maxOutputTokens, 256, 8192, 2048),
      maxReasoningTokens: clampInt(runtime?.maxReasoningTokens ?? st?.maxReasoningTokens, 0, 8192, 0),
      thinkingBudget: clampInt(runtime?.thinkingBudget ?? st?.thinkingBudget, 0, 8192, 0),

      // Summaries should be stable/deterministic. Keep sampling conservative.
      temperature: 0.2,
      topP: 0.9,
    };

    // Generate a single section: "### <title> (a-b턴)\n<body>"
    const targetChars = Math.min(100000, Math.max(80, perTurnCharsVal * summaryEveryVal));
    const identityCharacters = (db
      .prepare(
        `SELECT name, aliases, role, profile, relationshipNote, emotionNote, status
         FROM chat_character_roster
         WHERE chatId=? AND enabled != 0
         ORDER BY updatedAt DESC, name ASC
         LIMIT 60`
      )
      .all(chatId) as any[]).map((row) => ({
      name: String(row?.name || "").trim(),
      aliases: decryptIfPossible(String(row?.aliases || "")),
      role: decryptIfPossible(String(row?.role || "")),
      profile: decryptIfPossible(String(row?.profile || "")),
      relationshipNote: decryptIfPossible(String(row?.relationshipNote || "")),
      emotionNote: decryptIfPossible(String(row?.emotionNote || "")),
      status: decryptIfPossible(String(row?.status || "")),
    }));
    const identityKnownNames = identityCharacters
      .map((row) => row.name)
      .filter(Boolean);
    const identityCanon = buildIdentityCanonBlock({
      messages: all,
      knownNames: identityKnownNames,
      personaName,
      characterSources: identityCharacters,
    });
    const currentRelationshipGraph = loadRelationshipGraph(chatId);
    const relationshipGraphBlock = formatRelationshipGraphBlock(
      omitWorldOnlyRelationshipsFromPrompt(
        currentRelationshipGraph,
        buildEpistemicPromptFirewall(currentRelationshipGraph)
      )
    );
    const canonicalFacts = loadCanonicalCharacterFacts(chatId);
    const canonicalFactsBlock = formatCanonicalCharacterFactsBlock({
      persona: authoritativePersona,
      facts: canonicalFacts,
    });
    const spatialCanon = buildSpatialCanon({
      messages: all,
      knownNames: identityKnownNames,
      identities: [
        ...identityCharacters.map((identity) => ({
          canonicalName: identity.name,
          aliases: identity.aliases,
        })),
        ...identityCanon.canon.nameFacts.map((fact) => ({
          canonicalName: fact.canonicalName,
          aliases: fact.aliases,
        })),
      ],
      personaName,
      focusText: cleanedText,
    });

    const sourceNameSet = collectLikelyKoreanNames(cleanedText);
    for (const fact of identityCanon.canon.nameFacts) {
      sourceNameSet.add(fact.canonicalName);
      for (const alias of fact.aliases) sourceNameSet.add(alias);
    }
    if (personaName) sourceNameSet.add(personaName);
    const sourceNameList = [...sourceNameSet].sort((a, b) => a.localeCompare(b, "ko-KR"));
    const nameLockGuidance = sourceNameList.length
      ? `- (필수) 인명은 [${sourceNameList.join(", ")}] 목록에서만 사용. 목록에 없는 새 인명 생성 금지.`
      : "- (필수) 대화에 없는 새 인명 생성 금지.";

    const relationshipCorrectionGuidance = buildRelationshipCorrectionGuidance(cleanedText);
    const baseGuidance = [
      LONG_MEMORY_SUMMARY_RULES,
      relationshipCorrectionGuidance,
      identityCanon.block,
      canonicalFactsBlock,
      spatialCanon.block,
      relationshipGraphBlock,
      nameLockGuidance,
      "- 저장된 관계도는 인물별 가족관계·서사 관계 성격·현재 나이·호감도를 지키기 위한 연속성 기준이다.",
      "- 세계관 정사와 인물 개인 지식을 구분한다. 현장에 없었거나 잠들었거나 보지 못했거나 정체를 확인하지 못한 인물이 비밀·진범·배후를 안다고 요약하지 않는다.",
      "- 관계도에서 '알고 있는 인물'로 표시되지 않은 NPC에게 비밀 관계 사실을 옮기지 않는다. 객관적 사건을 요약하더라도 피해자·가족·목격자의 실제 지식 상태는 원문대로 유지한다.",
      "- 관계도 정보를 다른 인물에게 옮기지 말고, 이번 요약 구간 원문에 없는 과거 사건을 이번 구간 사건처럼 새로 쓰지 않는다.",
    ]
      .filter(Boolean)
      .join("\n");
    const strictGuidance = [
      baseGuidance,
      "- (필수) 본문에 영어(알파벳 A-Z,a-z) 사용 금지. 'thought', 'Characters:', 'Setting:' 같은 영어 라벨 금지.",
      "- (필수) 영문 고유명사는 가능하면 한국어 표기로 옮겨 적는다(예: Shin-chan -> 짱구).",
    ].join("\n");

    const normalizeSection = (raw: string) => {
      const clean = normalizeSummaryTail(
        stripUrlsAndMediaMarkdown(String(raw || ""), { keepHeadings: true })
      );
      const secs = extractSummarySections(clean);
      const sec =
        secs.find((s) => s.startTurn === windowStartTurn && s.endTurn === windowEndTurn) || secs[0] || null;
      const body = sec
        ? String(sec.body || "").trim()
        : String(clean.split("\n").slice(1).join("\n") || "").trim();
      return { clean, body };
    };

    const generationErrors: string[] = [];
    const runSummaryAttempt = async (label: string, run: () => Promise<string>) => {
      try {
        return String((await run()) || "");
      } catch (error: any) {
        generationErrors.push(`${label}:${String(error?.message || error || "failed").slice(0, 180)}`);
        return "";
      }
    };

    // 1) fast path (downshifted model, stable sampling)
    let sectionRaw = await runSummaryAttempt("primary", () =>
      summarizeLongMemorySectionKorean({
        text: cleanedText,
        startTurn: windowStartTurn,
        endTurn: windowEndTurn,
        targetChars,
        guidance: baseGuidance,
        personaName,
        opts: { ...llmOpts, noDownshift: true },
      })
    );

    let norm = normalizeSection(sectionRaw);
    let q = analyzeGeneratedLongMemoryBody(norm.body);
    let ndrift = analyzeNameDrift(norm.body, sourceNameSet, [personaName]);
    let relationshipDrift = analyzeRelationshipCorrectionDrift(cleanedText, norm.body);
    let identityDrift = analyzeIdentityCanonDrift({
      sourceText: cleanedText,
      summary: norm.body,
      canon: identityCanon.canon,
    });
    let canonicalFactDrift = analyzeCanonicalFactDrift({
      sourceText: cleanedText,
      summary: norm.body,
      persona: authoritativePersona,
      facts: canonicalFacts,
    });

    // 2) retry with stricter prompt and without model downshift (more reliable, higher cost, rare)
    if (!q.ok || !ndrift.ok || !relationshipDrift.ok || !identityDrift.ok || !canonicalFactDrift.ok) {
      const retryOpts = {
        ...llmOpts,
        noDownshift: true,
        temperature: 0.15,
        topP: 0.9,
      };
      sectionRaw = await runSummaryAttempt("strict", () =>
        summarizeLongMemorySectionKorean({
          text: cleanedText,
          startTurn: windowStartTurn,
          endTurn: windowEndTurn,
          targetChars,
          guidance: strictGuidance,
          personaName,
          opts: retryOpts,
        })
      );
      norm = normalizeSection(sectionRaw);
      q = analyzeGeneratedLongMemoryBody(norm.body);
      ndrift = analyzeNameDrift(norm.body, sourceNameSet, [personaName]);
      relationshipDrift = analyzeRelationshipCorrectionDrift(cleanedText, norm.body);
      identityDrift = analyzeIdentityCanonDrift({
        sourceText: cleanedText,
        summary: norm.body,
        canon: identityCanon.canon,
      });
      canonicalFactDrift = analyzeCanonicalFactDrift({
        sourceText: cleanedText,
        summary: norm.body,
        persona: authoritativePersona,
        facts: canonicalFacts,
      });
    }

    // 3) last-resort: fallback summarizer (body-only) then wrap into a section.
    if (!q.ok || !ndrift.ok || !relationshipDrift.ok || !identityDrift.ok || !canonicalFactDrift.ok) {
      const retryOpts = {
        ...llmOpts,
        noDownshift: true,
        temperature: 0.1,
        topP: 0.9,
      };
      const body = await runSummaryAttempt("body_fallback", () =>
        summarizeLongMemoryKorean({
          text: cleanedText,
          targetChars,
          guidance: strictGuidance,
          opts: retryOpts,
        })
      );
      const fallbackTitle = extractSectionTitle(sectionRaw) || "요약";
      sectionRaw = `### ${fallbackTitle} (${windowStartTurn}-${windowEndTurn}턴)\n${body}`;
      norm = normalizeSection(sectionRaw);
      q = analyzeGeneratedLongMemoryBody(norm.body);
      ndrift = analyzeNameDrift(norm.body, sourceNameSet, [personaName]);
      relationshipDrift = analyzeRelationshipCorrectionDrift(cleanedText, norm.body);
      identityDrift = analyzeIdentityCanonDrift({
        sourceText: cleanedText,
        summary: norm.body,
        canon: identityCanon.canon,
      });
      canonicalFactDrift = analyzeCanonicalFactDrift({
        sourceText: cleanedText,
        summary: norm.body,
        persona: authoritativePersona,
        facts: canonicalFacts,
      });
    }

    // 4) optional rescue pass: only when LONG_MEMORY_SUMMARY_FALLBACK_MODEL is explicitly set.
    // Default policy is flash-only (no automatic model bounce).
    if (!q.ok || !ndrift.ok || !relationshipDrift.ok || !identityDrift.ok || !canonicalFactDrift.ok) {
      const fallbackModel = pickLongMemorySummaryFallbackModel();
      if (fallbackModel) {
        const rescueOpts = {
          ...llmOpts,
          model: fallbackModel,
          noDownshift: true,
          temperature: 0.1,
          topP: 0.9,
        };
        const rescued = await runSummaryAttempt("fallback_model", () =>
          summarizeLongMemorySectionKorean({
            text: cleanedText,
            startTurn: windowStartTurn,
            endTurn: windowEndTurn,
            targetChars,
            guidance: strictGuidance,
            personaName,
            opts: rescueOpts,
          })
        );
        if (rescued) {
          sectionRaw = rescued;
          norm = normalizeSection(sectionRaw);
          q = analyzeGeneratedLongMemoryBody(norm.body);
          ndrift = analyzeNameDrift(norm.body, sourceNameSet, [personaName]);
          relationshipDrift = analyzeRelationshipCorrectionDrift(cleanedText, norm.body);
          identityDrift = analyzeIdentityCanonDrift({
            sourceText: cleanedText,
            summary: norm.body,
            canon: identityCanon.canon,
          });
          canonicalFactDrift = analyzeCanonicalFactDrift({
            sourceText: cleanedText,
            summary: norm.body,
            persona: authoritativePersona,
            facts: canonicalFacts,
          });
        }
      }
    }

    // 한 구간의 모델 거부·빈 응답·품질 실패 때문에 이후 모든 구간이 영원히
    // 막히지 않도록, 실제 저장된 assistant 원문에서 결정론적 보존 요약을 만든다.
    let deterministicFallbackUsed = false;
    let deterministicFallbackReason = "";
    if (!q.ok || !ndrift.ok || !relationshipDrift.ok || !identityDrift.ok || !canonicalFactDrift.ok) {
      deterministicFallbackReason = [
        !q.ok ? `quality:${q.reason}` : "",
        !ndrift.ok ? `name:${ndrift.reason}` : "",
        !relationshipDrift.ok ? `relationship:${relationshipDrift.reason}` : "",
        !identityDrift.ok ? `identity:${identityDrift.reason}` : "",
        !canonicalFactDrift.ok ? `canonical_fact:${canonicalFactDrift.reason}` : "",
        ...generationErrors,
      ]
        .filter(Boolean)
        .join(" | ");
      sectionRaw = buildDeterministicMemorySection({
        turns: rangeTurns,
        startTurn: windowStartTurn,
        endTurn: windowEndTurn,
        targetChars,
      });
      norm = normalizeSection(sectionRaw);
      q = analyzeGeneratedLongMemoryBody(norm.body);
      ndrift = analyzeNameDrift(norm.body, sourceNameSet, [personaName]);
      relationshipDrift = analyzeRelationshipCorrectionDrift(cleanedText, norm.body);
      identityDrift = analyzeIdentityCanonDrift({
        sourceText: cleanedText,
        summary: norm.body,
        canon: identityCanon.canon,
      });
      canonicalFactDrift = analyzeCanonicalFactDrift({
        sourceText: cleanedText,
        summary: norm.body,
        persona: authoritativePersona,
        facts: canonicalFacts,
      });
      deterministicFallbackUsed = true;
    }

    let forcedBadOutputSaved = false;
    let sectionRawForStore = String(sectionRaw || "");

    // Relationship/identity conflicts are semantic corruption, not formatting defects.
    // Never save it even when the debug-only bad-output override is enabled.
    if (!relationshipDrift.ok || !identityDrift.ok || !canonicalFactDrift.ok) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: !canonicalFactDrift.ok
          ? "canonical_fact_conflict"
          : !identityDrift.ok
            ? "identity_canon_conflict"
            : "relationship_correction_conflict",
        windowStartTurn,
        windowEndTurn,
        boundaryEndTurn,
        relationshipDrift,
        identityDrift,
        canonicalFactDrift,
      });
    }

    if (!q.ok || !ndrift.ok) {
      if (!allowBadOutputSave) {
        // Do NOT overwrite stored memory with garbage.
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "bad_output",
          windowStartTurn,
          windowEndTurn,
          boundaryEndTurn,
          quality: q,
          nameDrift: ndrift,
          relationshipDrift,
          identityDrift,
          repairing: Boolean(repair),
          repairRange: repair ? { startTurn: repair.startTurn, endTurn: repair.endTurn, title: repair.title } : null,
        });
      }

      forcedBadOutputSaved = true;
      // 최소 안전장치: 헤더를 강제하고 비어 있으면 짧은 안내문으로 채운다.
      // (검증 실패라도 "어떻게 저장되는지" 확인할 수 있게 저장 경로를 유지)
      const fallbackBody =
        String(norm.body || "").trim() ||
        String(sectionRaw || "").replace(/\r\n/g, "\n").split("\n").slice(1).join("\n").trim() ||
        "자동검증 실패로 임시 저장된 요약입니다.";
      const fallbackTitle = extractSectionTitle(sectionRawForStore) || extractSectionTitle(sectionRaw) || "요약";
      sectionRawForStore = `### ${fallbackTitle} (${windowStartTurn}-${windowEndTurn}턴)\n${fallbackBody}`;
    }

    // Re-check selected range rows before persisting.
    // If selected rows changed/deleted, skip writing to avoid stale resurrection after edits/deletes.
    const sourceSig1 = (() => {
      const ids = sourceSig0.map((s) => s.id).filter(Boolean);
      if (!ids.length) {
        return { changed: true, reason: "missing_range_ids", scope: "selected_range", beforeCount: sourceSig0.length, afterCount: 0 };
      }
      try {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT id, role, createdAt, updatedAt
             FROM messages
             WHERE chatId=? AND id IN (${placeholders})`
          )
          .all(chatId, ...ids) as Array<{ id: unknown; role: unknown; createdAt: unknown; updatedAt: unknown }>;

        if (rows.length !== ids.length) {
          return {
            changed: true,
            reason: "range_row_count_mismatch",
            scope: "selected_range",
            beforeCount: ids.length,
            afterCount: rows.length,
          };
        }

        const byId = new Map(rows.map((r) => [String(r.id), r]));
        for (const prev of sourceSig0) {
          const now = byId.get(prev.id);
          if (!now) {
            return {
              changed: true,
              reason: "range_row_missing",
              scope: "selected_range",
              beforeCount: ids.length,
              afterCount: rows.length,
            };
          }
          if (
            Number(now.createdAt || 0) !== prev.createdAt ||
            Number(now.updatedAt || 0) !== prev.updatedAt ||
            String(now.role || "").toLowerCase() !== prev.role.toLowerCase()
          ) {
            return {
              changed: true,
              reason: "range_row_changed",
              scope: "selected_range",
              beforeCount: ids.length,
              afterCount: rows.length,
            };
          }
        }

        return {
          changed: false,
          reason: "ok",
          scope: "selected_range",
          beforeCount: ids.length,
          afterCount: rows.length,
        };
      } catch {
        return { changed: true, reason: "range_recheck_failed", scope: "selected_range", beforeCount: ids.length, afterCount: 0 };
      }
    })();

    if (sourceSig1.changed) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "stale_source_changed",
        windowStartTurn,
        windowEndTurn,
        summarizedEndTurn,
        boundaryEndTurn,
        morePending: summarizedEndTurn < boundaryEndTurn,
        sourceSig0,
        sourceSig1,
      });
    }

    // Clean & upsert
    const sectionClean = normalizeSummaryTail(
      stripUrlsAndMediaMarkdown(String(sectionRawForStore || ""), { keepHeadings: true })
    );

    let nextSummary = upsertSummaryRangeBlock(recentSummary, sectionClean, windowStartTurn, windowEndTurn);
    nextSummary = forcedBadOutputSaved
      ? normalizeStoredMemorySummary(normalizeSummaryTail(nextSummary), summaryEveryVal)
      : sanitizeLongMemorySummary(normalizeSummaryTail(nextSummary), summaryEveryVal);

    // 강제 저장 모드에서도 본문이 비정상적으로 짧아 섹션이 사라질 수 있어 1회 보정한다.
    if (forcedBadOutputSaved && !hasRangeBlock(nextSummary, windowStartTurn, windowEndTurn)) {
      const forceTitle = extractSectionTitle(sectionRawForStore) || "요약";
      const forceSection = `### ${forceTitle} (${windowStartTurn}-${windowEndTurn}턴)\n자동검증 실패로 임시 저장됨. 상세 검토 필요.`;
      nextSummary = upsertSummaryRangeBlock(recentSummary, forceSection, windowStartTurn, windowEndTurn);
      nextSummary = normalizeStoredMemorySummary(normalizeSummaryTail(nextSummary), summaryEveryVal);
    }

    // (가드 2026-08) 아카이브 축소 방지.
    // 실제 사고: repairCorrupted 경로로 1-3턴을 재생성했더니 저장 직후 캐시가
    // 66섹션(1-198턴, 14,376자) → 1섹션(1-3턴, 1,085자)으로 잘리고 커서가 198→3으로 후퇴했다.
    // (정규화 체인 어딘가에서 연속성이 깨지면 그 뒤 섹션이 통째로 폐기되는데,
    //  그 결과가 무가드로 DB에 덮어써져 자력 복구가 불가능해진다.)
    // 새 요약의 섹션 수가 기존보다 줄어들면 저장하지 않고 건너뛴다.
    // (정상 경로는 섹션이 늘거나 같으므로 영향 없음)
    const prevSectionCount = extractSummarySections(String(recentSummary || "")).length;
    const nextSectionCount = extractSummarySections(String(nextSummary || "")).length;
    if (prevSectionCount > 0 && nextSectionCount < prevSectionCount) {
      console.error("[memory/refresh] archive shrink blocked", {
        chatId,
        windowStartTurn,
        windowEndTurn,
        prevSectionCount,
        nextSectionCount,
        prevChars: strlenSummary(recentSummary),
        nextChars: strlenSummary(nextSummary),
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "archive_shrink_blocked",
        windowStartTurn,
        windowEndTurn,
        prevSectionCount,
        nextSectionCount,
      });
    }

    const nextEndTurn = Math.max(summarizedEndTurn, getSummarizedEndTurn(nextSummary));

    // Persist
    const now = Date.now();
    const recentSummaryChars = strlenSummary(nextSummary);

    db.prepare(
      `INSERT INTO chat_memory_cache (chatId, recentSummary, summarizedEndTurn, rolledUpCount, lastSummarizedAt, updatedAt, recentSummaryChars)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chatId) DO UPDATE SET
         recentSummary=excluded.recentSummary,
         summarizedEndTurn=excluded.summarizedEndTurn,
         rolledUpCount=excluded.rolledUpCount,
         lastSummarizedAt=excluded.lastSummarizedAt,
         updatedAt=excluded.updatedAt,
         recentSummaryChars=excluded.recentSummaryChars`
    ).run(
      chatId,
      encryptIfPossible(nextSummary),
      nextEndTurn,
      Math.max(0, Number(cache?.rolledUpCount || 0)),
      now,
      now,
      recentSummaryChars
    );

    const storedSection = extractSummarySections(nextSummary).find(
      (section) => section.startTurn === windowStartTurn && section.endTurn === windowEndTurn
    );
    const blockSummary = storedSection ? formatMemoryBlockSection(storedSection) : sectionClean;
    upsertMemoryBlock({
      chatId,
      startTurn: windowStartTurn,
      endTurn: windowEndTurn,
      summary: blockSummary,
      summaryEvery: summaryEveryVal,
      summaryLength: targetChars,
      model: summaryModel,
      meta: {
        source: "memory_refresh",
        forcedBadOutputSaved,
        deterministicFallbackUsed,
        deterministicFallbackReason,
        generationErrors,
        quality: q,
        nameDrift: ndrift,
        relationshipDrift,
        identityDrift,
        sourceSig: sourceSig1,
      },
      now,
    });
    memoryBlocksBackfilled += 1;

    // 새 채팅은 첫 완성 구간(3턴)에서 roster를 만들고, 이후에는 12턴마다
    // 관계·별칭을 갱신한다. roster 부트스트랩이 실패한 동안에는 다음 3턴
    // 구간에서 다시 시도해 캐릭터 기억이 영구히 0개로 고정되지 않게 한다.
    const rosterCountBeforeGraph = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM chat_character_roster WHERE chatId=? AND enabled != 0`)
          .get(chatId) as { count?: unknown }
      )?.count || 0
    );
    const isRosterBootstrap = rosterCountBeforeGraph === 0;
    const shouldRefreshStructuredGraph =
      isRosterBootstrap ||
      (windowEndTurn >= STRUCTURED_GRAPH_WINDOW_TURNS &&
        windowEndTurn % STRUCTURED_GRAPH_WINDOW_TURNS === 0);
    let autoCharactersAdded: string[] = [];
    let autoAliasesUpdated: string[] = [];
    let autoRelationshipsUpserted = 0;
    let autoFactsUpserted = 0;
    let structuredGraphParsed = false;
    let structuredGraphRefreshed = false;
    let structuredGraphFallbackUsed = false;
    let structuredGraphCandidateNames: string[] = [];
    let structuredGraphMissingCandidateNames: string[] = [];
    if (shouldRefreshStructuredGraph) {
      const graphWindowTurnCount = isRosterBootstrap
        ? Math.min(STRUCTURED_GRAPH_WINDOW_TURNS, windowEndTurn)
        : STRUCTURED_GRAPH_WINDOW_TURNS;
      const graphWindowStartTurn = Math.max(
        1,
        windowEndTurn - graphWindowTurnCount + 1
      );
      const graphRangeTurns = selectMessagesForAssistantTurnRange(
        all,
        graphWindowStartTurn,
        windowEndTurn
      );
      const graphWindowText = stripUrlsAndMediaMarkdown(
        formatTurnsLocal(graphRangeTurns)
      );
      const graphOutcome = await refreshStructuredCharacterState({
        chatId,
        personaName,
        personaAge,
        personaGender,
        personaInfo,
        summaryModel,
        graphWindowText,
        graphWindowStartTurn,
        graphWindowEndTurn: windowEndTurn,
        now,
      });
      autoCharactersAdded = graphOutcome.autoCharactersAdded;
      autoAliasesUpdated = graphOutcome.autoAliasesUpdated;
      autoRelationshipsUpserted = graphOutcome.autoRelationshipsUpserted;
      autoFactsUpserted = graphOutcome.autoFactsUpserted;
      structuredGraphParsed = graphOutcome.structuredGraphParsed;
      structuredGraphRefreshed = graphOutcome.structuredGraphRefreshed;
      structuredGraphFallbackUsed = graphOutcome.fallbackUsed;
      structuredGraphCandidateNames = graphOutcome.candidateNames;
      structuredGraphMissingCandidateNames = graphOutcome.missingCandidateNames;
    }

    const autoCharactersBackfilled = await backfillAutoCharacterMemories({
      req,
      chatId,
      autoCharactersAdded,
      turnLimit: Math.min(AUTO_CHARACTER_BACKFILL_TURNS, windowEndTurn),
    }).catch(() => null);

    const morePending = nextEndTurn < boundaryEndTurn;

    return NextResponse.json({
      ok: true,
      refreshed: true,
      windowStartTurn,
      windowEndTurn,
      summarizedEndTurn: nextEndTurn,
      boundaryEndTurn,
      morePending,
      forcedBadOutputSaved,
      deterministicFallbackUsed,
      deterministicFallbackReason,
      quality: q,
      nameDrift: ndrift,
      relationshipDrift,
      identityDrift,
      canonicalFactDrift,
      memoryBlocksBackfilled,
      autoCharactersAdded,
      autoCharactersBackfilled,
      autoAliasesUpdated,
      autoRelationshipsUpserted,
      autoFactsUpserted,
      structuredGraphParsed,
      structuredGraphRefreshed,
      structuredGraphFallbackUsed,
      structuredGraphCandidateNames,
      structuredGraphMissingCandidateNames,
      structuredGraphWindowTurns: STRUCTURED_GRAPH_WINDOW_TURNS,
      policy: {
        summaryEvery: summaryEveryVal,
        perTurnChars: perTurnCharsVal,
        keepUserTurns: keepUserTurnsVal,
        targetChars,
      },
    });
  } catch (e: any) {
    console.error("/api/chat/memory/refresh error", e);
    return bad(e?.message || "refresh_failed", 500);
  }
}
