console.log("[chat/send] module loaded", new Date().toISOString());
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";
import { randomUUID } from "crypto";
import { countTokens, generateText, generateTextStream, summarizeKorean, summarizeLongMemoryKorean, isRefusalText, REFUSAL_FALLBACK_MODEL } from "@/lib/ai";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { DEFAULT_CHAT_MODEL, coerceChatModelId, defaultReasoningTokensForModel, isGemini3FlashModel, isGemini3ProModel } from "@/lib/models";

import {
  postprocessLongMemorySummary,
  stripUrlsAndMediaMarkdown,
} from "@/lib/memory_sanitize";
import {
  buildRelationshipCorrectionGuidance,
  findFocusedCharacterIds,
} from "@/lib/relationship_memory";
import {
  buildIdentityCanonBlock,
  formatIdentityCanonBlock,
  inferPersonaNameFromMessages,
} from "@/lib/identity_memory";
import { syncCharacterVitals } from "@/lib/character_vitals";
import {
  loadRelationshipGraph,
  syncIdentityCanonRelations,
  type RelationshipGraphData,
} from "@/lib/relationship_graph";
import { formatAddressDirectionGuard } from "@/lib/relationship_direction";
import { buildDynamicCharacterContext } from "@/lib/dynamic_character_context";
import {
  buildGroundedEpistemicFactIds,
  buildEpistemicPromptFirewall,
  sanitizeGeneratedEpistemicText,
  sanitizeRecentAssistantEpistemicText,
  sanitizeSharedEpistemicText,
} from "@/lib/epistemic_prompt_firewall";
import {
  removeUnsupportedLegalStatusClaims,
  type LegalStatusIdentity,
} from "@/lib/legal_status_consistency_guard";
import {
  isAuthorityClaimContext,
  removeUnsupportedAuthorityClaims,
} from "@/lib/authority_claim_consistency_guard";
import { removeUnsupportedVitalStatusClaims } from "@/lib/vital_status_consistency_guard";
import {
  formatRelationshipCanonGuardBlock,
  removeUnsupportedRelationshipClaims,
} from "@/lib/relationship_claim_consistency_guard";
import { createGuardedTextStream } from "@/lib/guarded_text_stream";
import {
  deriveCurrentSceneExclusions,
  deriveCurrentScenePresence,
  findRecognitionContradiction,
  findScenePresenceContradiction,
  removeRecognitionContradictionPassages,
  removeScenePresenceContradictionPassages,
} from "@/lib/recognition_consistency_guard";
import { selectConservativeMemoryRows } from "@/lib/character_memory_quality";
import {
  buildMemorySearchFtsQuery,
  buildMemorySearchIndex,
} from "@/lib/memory_search_index";
import {
  buildAuthoritativePersonaFacts,
  formatCanonicalCharacterFactsBlock,
  loadCanonicalCharacterFacts,
} from "@/lib/canonical_character_facts";
import {
  buildPhysicalFactIdentities,
  enforcePhysicalFactOwnership,
  formatPhysicalFactOwnershipBlock,
  type PhysicalFactIdentity,
} from "@/lib/physical_fact_consistency_guard";
import { buildSpatialCanon } from "@/lib/spatial_canon";
import { resolveActiveCharacterFocus } from "@/lib/active_character_focus";
import {
  normalizeNovelParagraphMarkers,
  repairUnbalancedNovelBodyMarkers,
} from "@/lib/novel_output_balance";
import {
  buildPreviousStatusPanelSnapshot,
  mergeStatusPanelContinuity,
} from "@/lib/status_panel_continuity";

const LOCAL_POINTS_DISABLED = true;
// ---- 비용 추정(간단 버전) ----
import { isChatDebug, dbg } from "./_server/debug";
import { estimateCost } from "./_server/billing";
import { resolvePersona, persistPersonaIfMissing, type PersonaOverride } from "./_server/persona";
import {
  extractSummarySections,
  strlenSummary,
  normalizeStoredMemorySummary,
  getSummarizedEndTurn,
} from "./_server/summaryStored";
import {
  selectMessagesForAssistantTurnRange,
  selectMessagesForAssistantTurnRangeCapped,
} from "./_server/turnRange";
import { computeSendOutputBudget, strlen } from "./_server/charBudget";
import { distribute } from "./_server/distribute";
import {
  formatTurns,
  selectRecentByUserTurns,
  selectPromptHistoryWithSummaryCoverage,
  selectMessagesBeforeContinuationTurn,
  selectMessagesBeforeCurrentUser,
  formatStoryTurnsForMode,
  buildUserLineForMode,
  isOocMetaInstruction,
  hasExplicitNovelNarration,
  ensurePrefix,
  stripNamePrefixFromNarration,
  stripDialogueWrappedNarration,
  normalizeAnyFenceOpen,
  repairUnclosedAnyFence,
  wrapLooseMetaAsFence,
  stripTrailingTextAfterFinalFence,
  splitTrailingFenceBlockAtEnd,
  stripEndMarker,
  normalizeNovelPlain,
  normalizeNovelChannelLayout,
  enforceNovelOnlyOutput,
  estTokens,
  trimToComplete,
  preserveTrailingMetaFenceBlocksOutsideBudget,
  finalizeOneShotOutputWithMeta,
  buildLocalFallbackMetaFence,
  isMetaFenceLikelyIncomplete,
} from "./_server/textPolicy";
import { sanitizePromptCached } from "./_server/promptCache";
import { buildFormatGuide } from "./_server/formatGuide";
import {
  buildTemporalCanon,
  extractPastDatedAnchors,
  findTemporalContradiction,
  formatTemporalCanonBlock,
  hasTemporalOverrideRequest,
} from "./_server/temporalCanon";
import { normalizeSummaryTail, sanitizeLongMemorySummary, upsertSummaryRangeBlock } from "./_server/memory";
import {
  memorySearchTokens,
  rankMemoryRetrievalCandidates,
  selectHybridMemory,
} from "./_server/memorySelection";
import { buildContinuityLedgerBlock } from "./_server/continuityState";
import {
  _reEsc,
  applyPromptPlaceholders,
  endsWithCompleteFence,
  extractFenceLabelFromFenceBlock,
  extractLastMetaContextFromMessages,
  fenceLabelCandidates,
  findLastStatusFenceCloseEnd,
  isMetaFenceClosed,
  looksLikeMetaPanelFence,
  normalizeFenceLabelToken,
  normalizeStatusFenceOpen,
  repairUnclosedStatusFence,
  stripStandaloneSeparatorLines,
  trimAfterClosedStatusFence,
} from "./_server/fence";
import { buildModelCallOpts, runBufferedOne, runOptionalShortContinue, runStreamMainGeneration } from "./_server/streamRunner";
import { makeContinueUserPrompt, mergeStreamUsage } from "./_server/streamHelpers";
import { buildRecentExpressionAvoidanceBlock } from "./_server/repetitionGuard";
import { buildWorldDirectorBlock } from "./_server/worldDirector";
import { applyStreamFinalizeUsageStats, finalizeStreamResult } from "./_server/streamFinal";
import { consumeMainStreamDeltas } from "./_server/streamLoop";
import {
  applyMetaCompletionFence,
  maybeStartDoneOnlyMetaOverlap,
  maybeStartStreamMetaOverlap,
  resolveMetaCompletionFence,
} from "./_server/streamOverlap";




// Gemini Developer API(유료) 가격표(프롬프트 <= 200k tokens 구간)의 input/output 단가만 사용한다.
// 참고: https://ai.google.dev/gemini-api/docs/pricing
// 환율은 실시간이 아니라 기본값(환경변수로 덮어쓰기 가능)로 처리한다.
const DEFAULT_USD_TO_KRW = Number(process.env.USD_TO_KRW) || 1350;

// One-shot mode: never make additional LLM calls (auto-continue / rewrite / status fallback).
// Default ON. Set CHAT_ONE_SHOT="0" to restore legacy multi-call behavior.
const ONE_SHOT = true; // hard: disable all multi-call flows (no 2nd model call)

const GEMINI_3_PRO_FAMILY_RE = /gemini-3(?:\.\d+)?-pro/i;

function isGemini3ProFamilyModel(model: string): boolean {
  return GEMINI_3_PRO_FAMILY_RE.test(String(model || ""));
}

function bad(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

function sanitizeUsageForViewer(usage: any, canViewDeveloper: boolean) {
  if (!usage || typeof usage !== "object") return null;
  if (canViewDeveloper) return usage;

  const out = { ...(usage as any) };
  // Non-admin users should not receive developer/debug flow details.
  delete out.debugReasons;
  delete out.tokenBreakdown;
  delete out.estPromptTotal;
  delete out.promptMaxChars;
  delete out.outputTargetChars;
  delete out.metaFenceLabels;
  delete out.metaCompleted;
  delete out.metaCompletedLabel;
  delete out.finalBodyChars;
  delete out.finalMetaChars;
  return out;
}

function usageStoreExtras(usage: any, debugReasons?: string[]) {
  const src = usage && typeof usage === "object" ? usage : {};
  const num = (v: any) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const text = (v: any) => String(v ?? "").trim();
  const meta = {
    finishReason: text(src.finishReason),
    maxOutputTokensRequested: num(src.maxOutputTokensRequested),
    maxOutputTokensForProvider: num(src.maxOutputTokensForProvider),
    effectiveMaxOutputTokens: num(src.effectiveMaxOutputTokens),
    reasoningHeadroomTokens: num(src.reasoningHeadroomTokens),
    thinkingBudget: num(src.thinkingBudget),
    thinkingLevel: text(src.thinkingLevel),
    outputChars: num(src.outputChars),
    targetChars: num(src.targetChars),
    promptMaxChars: num(src.promptMaxChars),
    promptBreakdownMethod: text(src.promptBreakdownMethod),
    debugReasons: Array.isArray(debugReasons) ? debugReasons.slice(-40) : [],
  };
  return {
    ...meta,
    usageMetaJson: JSON.stringify(meta),
  };
}

type RelatedMemoryBlock = {
  startTurn: number;
  endTurn: number;
  summary: string;
  score: number;
  primaryMatches: number;
  primaryScore: number;
  contextScore: number;
  explicitMatch: boolean;
};

const relatedMemoryStatementCache = new Map<string, ReturnType<typeof db.prepare>>();
function relatedMemoryStatement(sql: string) {
  const cached = relatedMemoryStatementCache.get(sql);
  if (cached) return cached;
  const statement = db.prepare(sql);
  relatedMemoryStatementCache.set(sql, statement);
  return statement;
}

function buildRelatedMemoryBlocks(params: {
  chatId: string;
  queryText: string;
  primaryQueryText?: string;
  historySummary: string;
  maxBlocks?: number;
  maxChars?: number;
}): { blockText: string; blocks: RelatedMemoryBlock[] } {
  const chatId = String(params.chatId || "").trim();
  if (!chatId) return { blockText: "", blocks: [] };

  const maxBlocks = Math.max(0, Math.min(10, Number(params.maxBlocks ?? 5) || 5));
  const maxChars = Math.max(0, Math.min(6000, Number(params.maxChars ?? 1800) || 1800));
  if (maxBlocks <= 0 || maxChars <= 0) return { blockText: "", blocks: [] };

  const queryText = stripUrlsAndMediaMarkdown(String(params.queryText || ""));
  const primaryQueryText = stripUrlsAndMediaMarkdown(
    String(params.primaryQueryText || params.queryText || "")
  );
  const tokens = memorySearchTokens(queryText);
  if (!tokens.length && !primaryQueryText.trim()) return { blockText: "", blocks: [] };

  const historySummary = String(params.historySummary || "");
  const allowDuplicate = String(process.env.AI_MEMORY_BLOCKS_INCLUDE_DUPLICATES || "").trim() === "1";

  // (최적화/안정성) historySummary에 이미 포함된 턴 구간을 미리 파싱해둔다.
  // - 기존엔 `historySummary.includes(summary)` 부분문자열 매칭으로 dedupe했는데,
  //   문장 일부만 우연히 일치하면 좋은 블록까지 통째로 누락되는 부작용이 있었다.
  // - 같은 startTurn-endTurn 구간이 요약에 이미 있는 경우만 dedupe하도록 바꾼다.
  const summarizedRanges: Array<{ start: number; end: number }> = (() => {
    if (!historySummary) return [];
    const ranges: Array<{ start: number; end: number }> = [];
    const re = /\(\s*(\d{1,6})\s*[-–~]\s*(\d{1,6})\s*턴\s*\)/gu;
    const reSingle = /\(\s*(\d{1,6})\s*턴\s*\)/gu;
    for (const m of historySummary.matchAll(re)) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        ranges.push({ start: Math.min(a, b), end: Math.max(a, b) });
      }
    }
    for (const m of historySummary.matchAll(reSingle)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) ranges.push({ start: n, end: n });
    }
    return ranges;
  })();
  const isAlreadySummarized = (st: number, ed: number) => {
    if (!summarizedRanges.length) return false;
    return summarizedRanges.some((r) => r.start <= st && r.end >= ed);
  };
  type SearchRow = {
    id: number;
    startTurn: number;
    endTurn: number;
    summary: string;
    _searchBoost?: number;
  };

  const candidateRows = new Map<number, SearchRow>();
  const addCandidateRows = (rows: any[], boost = 0) => {
    for (const raw of rows) {
      const id = Number(raw?.id || 0);
      if (id <= 0) continue;
      const previous = candidateRows.get(id);
      const nextBoost = Math.max(Number(previous?._searchBoost || 0), boost);
      candidateRows.set(id, {
        id,
        startTurn: Number(raw?.startTurn || 0),
        endTurn: Number(raw?.endTurn || 0),
        summary: String(raw?.summary || ""),
        _searchBoost: nextBoost,
      });
    }
  };

  // Always retain a small origin/recent safety window. This preserves early
  // foundational events and immediate continuity without scanning 1,200 rows.
  const earliestRows = relatedMemoryStatement(
      `SELECT id, startTurn, endTurn, summary
       FROM chat_memory_blocks
       WHERE chatId=?
       ORDER BY startTurn ASC
       LIMIT 40`
    )
    .all(chatId) as any[];
  const latestRows = relatedMemoryStatement(
      `SELECT id, startTurn, endTurn, summary
       FROM chat_memory_blocks
       WHERE chatId=?
       ORDER BY endTurn DESC
       LIMIT 48`
    )
    .all(chatId) as any[];
  addCandidateRows(earliestRows);
  addCandidateRows(latestRows);

  // Explicit turn requests bypass lexical search entirely.
  const requestedRanges: Array<{ start: number; end: number }> = [];
  const turnLookupText = `${primaryQueryText}\n${queryText}`;
  for (const match of turnLookupText.matchAll(/(\d{1,6})\s*(?:[-~–—]|부터|에서)\s*(\d{1,6})\s*턴/gu)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      requestedRanges.push({ start: Math.min(a, b), end: Math.max(a, b) });
    }
  }
  for (const match of turnLookupText.matchAll(/(\d{1,6})\s*턴/gu)) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) requestedRanges.push({ start: n, end: n });
  }
  const directRangeStatement = relatedMemoryStatement(
    `SELECT id, startTurn, endTurn, summary
     FROM chat_memory_blocks
     WHERE chatId=? AND startTurn <= ? AND endTurn >= ?
     ORDER BY startTurn ASC
     LIMIT 12`
  );
  for (const range of requestedRanges.slice(0, 8)) {
    addCandidateRows(directRangeStatement.all(chatId, range.end, range.start) as any[], 20);
  }

  const primaryTokens = memorySearchTokens(primaryQueryText);
  const ftsQuery = buildMemorySearchFtsQuery(
    primaryTokens.slice(0, 18).concat(tokens.slice(0, 14)),
    28
  );
  let v2Available = false;
  let v2Hits: any[] = [];
  try {
    // This also distinguishes "no matches" from "index unavailable" so a
    // vague request does not accidentally trigger the legacy full scan.
    const indexedChatRow = relatedMemoryStatement(
      `SELECT rowid FROM chat_memory_blocks_search_fts_v2 WHERE chatId=? LIMIT 1`
    )
      .get(chatId) as any;
    const plaintextMemoryRow = relatedMemoryStatement(
        `SELECT id
         FROM chat_memory_blocks
         WHERE chatId=? AND substr(summary, 1, 7)!='enc:v1:'
         LIMIT 1`
      )
      .get(chatId) as any;
    v2Available = Boolean(indexedChatRow?.rowid) || !plaintextMemoryRow?.id;
    if (v2Available && ftsQuery) {
      v2Hits = relatedMemoryStatement(
          `SELECT b.id, b.startTurn, b.endTurn, b.summary,
                  f.entities, f.places, f.events,
                  bm25(chat_memory_blocks_search_fts_v2, 0.0, 9.0, 12.0, 7.0, 8.0, 4.0, 1.0) AS searchRank
           FROM chat_memory_blocks_search_fts_v2 f
           JOIN chat_memory_blocks b ON b.id=f.rowid
           WHERE f.chatId = ? AND chat_memory_blocks_search_fts_v2 MATCH ?
           ORDER BY searchRank ASC
           LIMIT 240`
        )
        .all(chatId, ftsQuery) as any[];
    }
  } catch {
    v2Available = false;
    v2Hits = [];
  }

  if (v2Hits.length > 0) {
    const indexedRows = v2Hits;
    for (let rank = 0; rank < indexedRows.length; rank += 1) {
      const row = indexedRows[rank];
      addCandidateRows([row], Math.max(1, 6 - Math.floor(rank / 40)));
    }

    // Pull the immediately adjacent block only when it shares a structured
    // entity/place/event. This recovers causes and consequences without adding
    // a large chronological window to every prompt.
    const indexedRowsById = new Map(
      indexedRows.map((row) => [Number(row?.id || 0), row] as const)
    );
    const previousStatement = relatedMemoryStatement(
      `SELECT id, startTurn, endTurn, summary
       FROM chat_memory_blocks
       WHERE chatId=? AND endTurn < ?
       ORDER BY endTurn DESC
       LIMIT 1`
    );
    const nextStatement = relatedMemoryStatement(
      `SELECT id, startTurn, endTurn, summary
       FROM chat_memory_blocks
       WHERE chatId=? AND startTurn > ?
       ORDER BY startTurn ASC
       LIMIT 1`
    );
    const structuredTerms = (value: unknown) =>
      new Set(String(value || "").split(/\s+/u).filter((term) => term.length >= 2));
    const overlaps = (a: Set<string>, b: Set<string>) => {
      for (const term of a) if (b.has(term)) return true;
      return false;
    };

    for (const hit of v2Hits.slice(0, 10)) {
      const hitRow = indexedRowsById.get(Number(hit?.id || 0));
      if (!hitRow) continue;
      const hitTerms = structuredTerms(`${hit?.entities || ""} ${hit?.places || ""} ${hit?.events || ""}`);
      if (hitTerms.size === 0) continue;
      const adjacent = [
        previousStatement.get(chatId, Number(hitRow.startTurn || 0)) as any,
        nextStatement.get(chatId, Number(hitRow.endTurn || 0)) as any,
      ].filter(Boolean);
      for (const neighbor of adjacent) {
        const gap = Number(neighbor.startTurn) > Number(hitRow.endTurn)
          ? Number(neighbor.startTurn) - Number(hitRow.endTurn)
          : Number(hitRow.startTurn) - Number(neighbor.endTurn);
        if (gap > 2) continue;
        const plain = decryptIfPossible(String(neighbor.summary || ""));
        const index = buildMemorySearchIndex(plain);
        const neighborTerms = structuredTerms(`${index.entities} ${index.places} ${index.events}`);
        if (overlaps(hitTerms, neighborTerms)) addCandidateRows([neighbor], 3);
      }
    }
  }

  // Old or encrypted deployments remain readable. This is deliberately an
  // exceptional path; normal plaintext chats use the bounded v2 shortlist.
  if (!v2Available) {
    const legacyRows = relatedMemoryStatement(
        `SELECT id, startTurn, endTurn, summary
         FROM chat_memory_blocks
         WHERE chatId=?
         ORDER BY startTurn ASC
         LIMIT 1200`
      )
      .all(chatId) as any[];
    addCandidateRows(legacyRows);
  } else {
    const hasEncryptedRow = relatedMemoryStatement(
        `SELECT 1 AS found
         FROM chat_memory_blocks
         WHERE chatId=? AND substr(summary, 1, 7)='enc:v1:'
         LIMIT 1`
      )
      .get(chatId) as any;
    if (hasEncryptedRow?.found) {
      const encryptedRows = relatedMemoryStatement(
          `SELECT id, startTurn, endTurn, summary
           FROM chat_memory_blocks
           WHERE chatId=? AND substr(summary, 1, 7)='enc:v1:'
           ORDER BY startTurn ASC
           LIMIT 1200`
        )
        .all(chatId) as any[];
      addCandidateRows(encryptedRows);
    }
  }

  const rows = [...candidateRows.values()];

  const candidates: Array<{
    startTurn: number;
    endTurn: number;
    summary: string;
    text: string;
    boost?: number;
  }> = [];
  for (const row of rows) {
    const startTurn = Math.max(1, Math.floor(Number(row?.startTurn) || 0));
    const endTurn = Math.max(startTurn, Math.floor(Number(row?.endTurn) || startTurn));
    const summary = postprocessLongMemorySummary(
      stripUrlsAndMediaMarkdown(decryptIfPossible(String(row?.summary || "")), {
        keepHeadings: true,
      })
    ).trim();
    if (!summary) continue;
    // (개선) 부분문자열 dedupe → 턴 범위 기반 dedupe.
    // historySummary에 [startTurn..endTurn]을 포괄하는 구간 헤더가 이미 있으면 스킵.
    if (!allowDuplicate && isAlreadySummarized(startTurn, endTurn)) continue;

    candidates.push({
      startTurn,
      endTurn,
      summary,
      text: summary,
      boost: Math.max(0, Number(row?._searchBoost || 0)),
    });
  }

  const picked: RelatedMemoryBlock[] = rankMemoryRetrievalCandidates({
    candidates,
    primaryQueryText,
    contextQueryText: queryText,
    maxItems: maxBlocks,
    maxChars,
  });
  if (!picked.length) return { blockText: "", blocks: [] };

  const blockText = [
    "# (2-B) 관련 장기기억 블록 원장",
    "- 기존 장기기억 요약을 대체하지 않고, 현재 입력과 관련된 사건 블록만 보강한다.",
    "- 기존 요약과 충돌하면 더 구체적인 블록 내용을 우선 참고한다.",
    "- 조회된 과거 사건의 장소·대상·행동·순서를 다른 최근 사건이나 관계 정보와 섞거나 옮기지 않는다.",
    picked.map((b) => b.summary).join("\n\n"),
  ].join("\n");

  return { blockText, blocks: picked };
}

function hasKoreanBatchimForCharacterMemory(s: string) {
  const ch = String(s || "").trim().slice(-1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function withKoreanParticleForCharacterMemory(name: string, pair: "은는" | "이가" | "을를" | "과와") {
  const n = String(name || "").trim();
  if (!n) return "";
  const batchim = hasKoreanBatchimForCharacterMemory(n);
  if (pair === "은는") return n + (batchim ? "은" : "는");
  if (pair === "이가") return n + (batchim ? "이" : "가");
  if (pair === "을를") return n + (batchim ? "을" : "를");
  return n + (batchim ? "과" : "와");
}

// (최적화) Persona-ref replacer를 personaName별로 캐싱.
// 기존엔 매 호출마다 39개 RegExp(3 refs × 13 패턴)를 새로 컴파일했고,
// roster 30명 × turn_memories 80개 = 약 2400회 호출 × 39 = 93k 컴파일/send.
// 이제 personaName당 1회만 컴파일하고 캐시.
type PersonaRefReplacer = (text: string) => string;
const personaRefReplacerCache = new Map<string, PersonaRefReplacer>();

function getPersonaRefReplacer(personaName: string): PersonaRefReplacer {
  const name = String(personaName || "").trim();
  if (!name) return (s) => String(s || "");
  const cached = personaRefReplacerCache.get(name);
  if (cached) return cached;

  const replacements: Array<[RegExp, string]> = [];
  for (const ref of ["사용자", "주인공", "플레이어"]) {
    replacements.push([new RegExp(`${ref}와`, "g"), withKoreanParticleForCharacterMemory(name, "과와")]);
    replacements.push([new RegExp(`${ref}과`, "g"), withKoreanParticleForCharacterMemory(name, "과와")]);
    replacements.push([new RegExp(`${ref}는`, "g"), withKoreanParticleForCharacterMemory(name, "은는")]);
    replacements.push([new RegExp(`${ref}은`, "g"), withKoreanParticleForCharacterMemory(name, "은는")]);
    replacements.push([new RegExp(`${ref}가`, "g"), withKoreanParticleForCharacterMemory(name, "이가")]);
    replacements.push([new RegExp(`${ref}이`, "g"), withKoreanParticleForCharacterMemory(name, "이가")]);
    replacements.push([new RegExp(`${ref}를`, "g"), withKoreanParticleForCharacterMemory(name, "을를")]);
    replacements.push([new RegExp(`${ref}을`, "g"), withKoreanParticleForCharacterMemory(name, "을를")]);
    replacements.push([new RegExp(`${ref}에게`, "g"), `${name}에게`]);
    replacements.push([new RegExp(`${ref}한테`, "g"), `${name}한테`]);
    replacements.push([new RegExp(`${ref}로부터`, "g"), `${name}로부터`]);
    replacements.push([new RegExp(`${ref}의`, "g"), `${name}의`]);
    replacements.push([new RegExp(ref, "g"), name]);
  }
  const replacer: PersonaRefReplacer = (text: string) => {
    let out = String(text || "");
    for (const [re, sub] of replacements) out = out.replace(re, sub);
    return out;
  };

  if (personaRefReplacerCache.size > 32) {
    const firstKey = personaRefReplacerCache.keys().next().value;
    if (firstKey) personaRefReplacerCache.delete(firstKey);
  }
  personaRefReplacerCache.set(name, replacer);
  return replacer;
}

function replaceGenericPersonaRefsForCharacterMemory(text: string, personaName: string) {
  return getPersonaRefReplacer(personaName)(text);
}

// (최적화) preset.lorebooks 파싱 결과 캐시.
// 동일한 raw 문자열에 대해 매 send마다 JSON.parse 하던 비용을 제거.
// 캐시 키는 (길이:첫24자) — preset 갱신 시 raw 문자열도 거의 확실히 변함.
const lorebooksParseCache = new Map<string, any[]>();
function parseLorebooksCached(raw: string): any[] {
  const s = String(raw || "");
  if (!s || s === "[]") return [];
  const key = `${s.length}:${s.slice(0, 24)}`;
  const cached = lorebooksParseCache.get(key);
  if (cached) return cached;
  let arr: any[] = [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) arr = parsed;
  } catch {
    arr = [];
  }
  if (lorebooksParseCache.size > 64) {
    const firstKey = lorebooksParseCache.keys().next().value;
    if (firstKey) lorebooksParseCache.delete(firstKey);
  }
  lorebooksParseCache.set(key, arr);
  return arr;
}

// 상세 블록을 붙일 캐릭터 수 상한. 현재 입력에서 걸린 인물이 먼저 채우고, 남는
// 자리에 최근 턴 등장 인물이 들어간다. 실측 장면 인물은 2~3명이라 넉넉하다.
const MANUAL_ROSTER_DETAIL_LIMIT = 8;

function buildManualCharacterRosterBlock(
  chatIdRaw: string,
  focusTextRaw = "",
  personaNameOverride = "",
  recentFocusTextRaw = "",
  physicalFactIdentities: PhysicalFactIdentity[] = [],
  includeDetailedContext = true
) {
  const chatId = String(chatIdRaw || "").trim();
  if (!chatId) return "";

  // (최적화) Empty roster early-out — 등록 캐릭터가 0이면 전체 로직 스킵.
  // 새 채팅/초기 turn에서 매 send마다 빈 SELECT + decrypt 반복하던 비용 제거.
  const rosterCount = db
    .prepare(`SELECT COUNT(*) AS n FROM chat_character_roster WHERE chatId=? AND enabled != 0`)
    .get(chatId) as any;
  if (Number(rosterCount?.n || 0) === 0) return "";

  const settings = db.prepare(`SELECT personaName FROM chat_settings WHERE chatId=?`).get(chatId) as any;
  const personaName =
    String(personaNameOverride || "").trim() ||
    String(settings?.personaName || "").trim() ||
    "나";

  const rosterRows = db
    .prepare(
      `SELECT id, name, aliases, role, profile, relationshipNote, emotionNote, status
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0
       ORDER BY updatedAt DESC, name ASC
       LIMIT 30`
    )
    .all(chatId) as any[];
  const personaKey = personaName.toLowerCase();
  const rows = rosterRows.filter((row) => {
    const name = String(row?.name || "").trim().toLowerCase();
    if (name && name === personaKey) return false;
    const aliases = decryptIfPossible(String(row?.aliases || ""))
      .split(/[\n,;\/|]+/g)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return !aliases.includes(personaKey);
  });
  if (!rows.length) return "";

  const scopeRows = rows.map((row) => ({
    id: String(row?.id || ""),
    name: String(row?.name || ""),
    aliases: decryptIfPossible(String(row?.aliases || "")),
  }));
  const focusedIds = findFocusedCharacterIds(scopeRows, focusTextRaw);

  // 최근 몇 턴에 등장한 캐릭터도 장면 인물로 본다.
  //
  // 이 블록은 이제 항상 주입되는데(AI_ALWAYS_INJECT_ROSTER), 포커스를 현재 입력
  // 한 줄로만 잡으면 대부분의 턴에서 아무도 안 걸린다. 실측(로스터 13명) 최근 유저
  // 턴 5개 중 4개가 현재 입력만으로는 0명이고 최근 4메시지로는 2~3명이었다. 그
  // 차이만큼 관계·호칭·약속·조우 로그가 빠지고 이름만 남았다.
  //
  // 상세 블록은 캐릭터별 heading 안에만 들어가므로 대상을 넓혀도 관계가 다른
  // 인물로 번지지는 않는다. 다만 대사가 큰 방에서 프롬프트가 붇지 않게 총량은
  // 현재 입력에서 걸린 인물을 우선해 제한한다.
  const recentFocusedIds = findFocusedCharacterIds(scopeRows, recentFocusTextRaw);
  for (const id of recentFocusedIds) {
    if (focusedIds.size >= MANUAL_ROSTER_DETAIL_LIMIT) break;
    focusedIds.add(id);
  }

  // 이름이 생략된 턴은 가장 최근에 실제 대화를 나눈 캐릭터를 장면 인물로 본다.
  // 모든 캐릭터의 상세 로그를 한꺼번에 넣으면 한 인물의 관계/호칭이 다른 인물로 번지기 쉽다.
  if (focusedIds.size === 0) {
    const latestRows = db
      .prepare(
        `SELECT rosterId, MAX(turnNo) AS latestTurn
         FROM chat_character_turn_memories
         WHERE chatId=?
         GROUP BY rosterId
         ORDER BY latestTurn DESC`
      )
      .all(chatId) as Array<{ rosterId: string; latestTurn: number }>;
    const latestTurn = Math.max(0, Number(latestRows[0]?.latestTurn || 0));
    for (const row of latestRows) {
      if (Number(row?.latestTurn || 0) !== latestTurn) break;
      if (latestTurn > 0) focusedIds.add(String(row?.rosterId || ""));
    }
  }
  if (focusedIds.size === 0 && rows.length === 1) focusedIds.add(String(rows[0]?.id || ""));

  const detailedRows = rows.filter((row) => focusedIds.has(String(row?.id || "")));

  // 정상 동적 컨텍스트 생성이 실패하더라도 같은 보존 정책을 쓴다.
  // 고정 개수 제한 없이 전체 이력을 읽고, 사실상 같은 요약+근거만 합쳐
  // 오래된 사건이나 반응성 기록도 조회 단계에서 사라지지 않게 한다.
  const memoriesByRoster = new Map<string, any[]>();
  if (includeDetailedContext) {
    const rosterIds: string[] = [];
    for (const r of detailedRows) {
      const rid = String(r?.id || "").trim();
      if (rid) rosterIds.push(rid);
    }
    if (rosterIds.length > 0) {
      const placeholders = rosterIds.map(() => "?").join(",");
      const rawMemoryRows = db
        .prepare(
          `SELECT rosterId, turnNo, summary, evidence, memoryType, importance
           FROM chat_character_turn_memories
           WHERE chatId=? AND rosterId IN (${placeholders})
           ORDER BY rosterId ASC, turnNo ASC`
        )
        .all(chatId, ...rosterIds) as any[];
      const normalizedMemoryRows = rawMemoryRows.map((memory) => ({
          ...memory,
          rosterId: String(memory?.rosterId || ""),
          turnNo: Math.max(0, Number(memory?.turnNo || 0)),
          summary: decryptIfPossible(String(memory?.summary || "")),
          evidence: decryptIfPossible(String(memory?.evidence || "")),
          importance: Math.max(1, Math.min(3, Number(memory?.importance || 1))),
        }));
      const memoryRows = selectConservativeMemoryRows(
        [
          ...normalizedMemoryRows.filter((memory) => memory.importance >= 2),
          ...normalizedMemoryRows.filter((memory) => memory.importance < 2).slice(-12),
        ].sort((a, b) => a.turnNo - b.turnNo)
      );
      for (const m of memoryRows) {
        const k = String(m?.rosterId || "");
        if (!k) continue;
        const arr = memoriesByRoster.get(k) || [];
        arr.push(m);
        memoriesByRoster.set(k, arr);
      }
    }
  }

  const lines: string[] = [];
  for (const row of detailedRows) {
    const name = String(row?.name || "").trim();
    if (!name) continue;
    const aliases = includeDetailedContext
      ? decryptIfPossible(String(row?.aliases || "")).trim()
      : "";
    const role = includeDetailedContext
      ? decryptIfPossible(String(row?.role || "")).trim()
      : "";
    const profile = includeDetailedContext
      ? decryptIfPossible(String(row?.profile || "")).trim()
      : "";
    const relationshipNote = includeDetailedContext
      ? decryptIfPossible(String(row?.relationshipNote || "")).trim()
      : "";
    const emotionNote = includeDetailedContext
      ? decryptIfPossible(String(row?.emotionNote || "")).trim()
      : "";
    const status = includeDetailedContext
      ? decryptIfPossible(String(row?.status || "")).trim()
      : "";
    const memories = includeDetailedContext
      ? memoriesByRoster.get(String(row?.id || "")) || []
      : [];
    // (최적화) replacer를 미리 만들어 두면 모든 메모리 라인이 같은 캐싱된 함수를 사용 → regex 컴파일 0회.
    const replacer = getPersonaRefReplacer(personaName);
    const memoryLines = memories
      .map((m: any) => {
        const turnNo = Math.max(0, Math.floor(Number(m?.turnNo || 0)));
        const summary = enforcePhysicalFactOwnership({
          text: replacer(String(m?.summary || "").trim()),
          identities: physicalFactIdentities,
        }).text;
        return turnNo > 0 && summary ? `  - ${turnNo}턴: ${summary}` : "";
      })
      .filter(Boolean);

    const item = [
      `## ${name}`,
      aliases ? `- aliases: ${aliases}` : "",
      role ? `- role: ${role}` : "",
      profile ? `- profile: ${profile}` : "",
      relationshipNote ? `- relationship/dialogue: ${relationshipNote}` : "",
      emotionNote ? `- psychology/emotion: ${emotionNote}` : "",
      status ? `- current status: ${status}` : "",
      memoryLines.length ? `- encounter log:\n${memoryLines.join("\n")}` : "",
    ].filter(Boolean);
    lines.push(item.join("\n"));
  }

  const inactiveNames = rows
    .filter((row) => !focusedIds.has(String(row?.id || "")))
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
  if (!lines.length && !inactiveNames.length) return "";
  const body = lines.join("\n\n");
  return [
    "# (2-C) manual character registry",
    "- These are user-pinned characters to remember across the chat.",
    includeDetailedContext
      ? "- Each ## heading is the memory owner: the character whose relationship/emotion continuity is being stored. It is not the grammatical subject or physical-attribute owner of every sentence in that encounter."
      : "",
    includeDetailedContext
      ? `- An encounter can describe both ${personaName} and the memory owner. Keep every height, weight, build, appearance, action, and spoken line attached to the participant explicitly named in that sentence; never attach an unnamed physical value to the ## heading character.`
      : "",
    includeDetailedContext
      ? "- Never transfer a relationship, title, promise, emotion, or dialogue style from one character heading to another."
      : "",
    includeDetailedContext
      ? "- A title used by one character does not authorize any other character to use it."
      : "",
    includeDetailedContext
      ? "- Preserve relationship, dialogue distance, emotional residue, unresolved conflicts, promises, and aliases only for that same character."
      : "",
    includeDetailedContext
      ? "- Encounter logs are ordered by turn number from oldest to newest; treat later turn numbers as happening after earlier turn numbers."
      : "",
    includeDetailedContext
      ? `- The persona name is "${personaName}". Do not refer to the persona as 사용자, 주인공, or 플레이어 in character memory.`
      : "",
    includeDetailedContext
      ? `- Use the encounter logs mainly to remember what happened between ${personaName} and each character.`
      : "",
    "- This registry is not a complete cast list. An unregistered or role-only NPC present in recent conversation remains a separate current-scene character.",
    "- Never omit, merge, or silence an unregistered current-scene NPC merely because only registered characters have detailed memory below.",
    detailedRows.length
      ? `- Current-scene ${includeDetailedContext ? "detailed characters" : "registered names (details already supplied by dynamic context)"}: ${detailedRows.map((row) => row.name).join(", ")}`
      : "",
    body,
    inactiveNames.length ? `- Other registered but currently inactive characters (names only): ${inactiveNames.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

type PromptBreakdownWeights = {
  presetPrompt: number;
  lorebookPrompt: number;
  persona: number;
  userNote: number;
  longMemorySummary: number;
  recentTurns: number;
  userInput: number;
  systemAndRules: number;
};

function tokenWeightFromText(text: string) {
  const src = String(text || "");
  const t = estTokens(src);
  return src.trim().length > 0 ? Math.max(1, t) : 0;
}

function buildFallbackPromptWeights(params: {
  systemMain: string;
  presetBlock: string;
  loreBlock: string;
  personaBlock: string;
  noteBlock: string;
  historySummary: string;
  context: string;
  userLine: string;
}): PromptBreakdownWeights {
  const presetPrompt = tokenWeightFromText(params.presetBlock);
  const lorebookPrompt = tokenWeightFromText(params.loreBlock);
  const persona = tokenWeightFromText(params.personaBlock);
  const userNote = tokenWeightFromText(params.noteBlock);
  const longMemorySummary = tokenWeightFromText(params.historySummary);
  const recentTurns = tokenWeightFromText(params.context);
  const userInput = tokenWeightFromText(params.userLine);
  const systemW = estTokens(params.systemMain);
  const systemAndRules = Math.max(0, systemW - (presetPrompt + lorebookPrompt + persona + userNote + longMemorySummary));
  return {
    presetPrompt,
    lorebookPrompt,
    persona,
    userNote,
    longMemorySummary,
    recentTurns,
    userInput,
    systemAndRules,
  };
}

async function buildPromptBreakdownWeights(params: {
  model: string;
  promptTokens: number;
  systemMain: string;
  presetBlock: string;
  loreBlock: string;
  personaBlock: string;
  noteBlock: string;
  historySummary: string;
  context: string;
  userLine: string;
}): Promise<{ weights: PromptBreakdownWeights; method: "countTokens" | "estimate" }> {
  // (최적화) fallback weights는 estimate 경로 또는 exact 일부 실패 시에만 사용된다.
  // exact 경로가 성공하면 fallback은 폐기되므로 lazy 계산으로 미루어 estTokens 8회 호출 비용 절약.
  let _fallback: PromptBreakdownWeights | null = null;
  const getFallback = (): PromptBreakdownWeights => {
    if (_fallback) return _fallback;
    _fallback = buildFallbackPromptWeights({
      systemMain: params.systemMain,
      presetBlock: params.presetBlock,
      loreBlock: params.loreBlock,
      personaBlock: params.personaBlock,
      noteBlock: params.noteBlock,
      historySummary: params.historySummary,
      context: params.context,
      userLine: params.userLine,
    });
    return _fallback;
  };

  const exactOn = String(process.env.CHAT_EXACT_PROMPT_BREAKDOWN ?? "0").trim() === "1";
  const model = String(params.model || "").trim();
  const promptTokens = Math.max(0, Math.floor(Number(params.promptTokens) || 0));
  if (!exactOn || !model || promptTokens <= 0) {
    return { weights: getFallback(), method: "estimate" };
  }

  const MAX_COUNT_CHARS = Number(process.env.CHAT_EXACT_PROMPT_BREAKDOWN_MAX_CHARS ?? 120000);
  const safeCount = async (text: string) => {
    const src = String(text || "");
    if (!src.trim()) return { ok: true as const, value: 0, counted: false as const };
    if (src.length > MAX_COUNT_CHARS) return { ok: false as const, value: null as number | null, counted: false as const };
    const n = await countTokens({ model, text: src });
    if (!Number.isFinite(n as any) || Number(n) < 0) return { ok: false as const, value: null as number | null, counted: false as const };
    const v = Math.floor(Number(n));
    return { ok: true as const, value: src.trim().length > 0 ? Math.max(1, v) : 0, counted: true as const };
  };

  const entries = [
    ["presetPrompt", params.presetBlock],
    ["lorebookPrompt", params.loreBlock],
    ["persona", params.personaBlock],
    ["userNote", params.noteBlock],
    ["longMemorySummary", params.historySummary],
    ["recentTurns", params.context],
    ["userInput", params.userLine],
  ] as const;

  const counted = await Promise.all(entries.map(async ([k, text]) => ({ k, ...(await safeCount(text)) })));
  const measured: any = {};
  let anyCounted = false;

  for (const row of counted) {
    if (row.ok) {
      measured[row.k] = Number(row.value || 0);
      if (row.counted) anyCounted = true;
      continue;
    }
    measured[row.k] = Number((getFallback() as any)[row.k] || 0);
  }

  if (!anyCounted) {
    return { weights: getFallback(), method: "estimate" };
  }

  const known =
    Number(measured.presetPrompt || 0) +
    Number(measured.lorebookPrompt || 0) +
    Number(measured.persona || 0) +
    Number(measured.userNote || 0) +
    Number(measured.longMemorySummary || 0) +
    Number(measured.recentTurns || 0) +
    Number(measured.userInput || 0);

  const weights: PromptBreakdownWeights = {
    presetPrompt: Number(measured.presetPrompt || 0),
    lorebookPrompt: Number(measured.lorebookPrompt || 0),
    persona: Number(measured.persona || 0),
    userNote: Number(measured.userNote || 0),
    longMemorySummary: Number(measured.longMemorySummary || 0),
    recentTurns: Number(measured.recentTurns || 0),
    userInput: Number(measured.userInput || 0),
    systemAndRules: Math.max(0, promptTokens - known),
  };

  return { weights, method: "countTokens" };
}

function mergeContinuationBase(baseRaw: string, deltaRaw: string): string {
  const base = String(baseRaw || "").trimEnd();
  let delta = String(deltaRaw || "").trim();
  if (!base) return delta;
  if (!delta) return base;

  // Model occasionally returns the whole text again; keep the longer stable copy.
  if (delta.startsWith(base)) return delta;
  if (base.startsWith(delta) && delta.length >= Math.floor(base.length * 0.7)) return base;

  const max = Math.min(900, base.length, delta.length);
  for (let k = max; k >= 24; k--) {
    if (base.slice(-k) === delta.slice(0, k)) {
      delta = delta.slice(k).trimStart();
      break;
    }
  }
  if (!delta) return base;
  return `${base}\n${delta}`.trim();
}

export async function POST(req: Request) {
  const _reqId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const _url = new URL(req.url);
  console.log(`[chat/send][${_reqId}] -> ${req.method} ${_url.pathname}${_url.search}`);
  // 요청 헤더(ua/referer...) 로그는 너무 시끄러워서 기본 비활성.
  // 필요 시 CHAT_DEBUG_HEADERS=1 로만 켠다.
  if (process.env.CHAT_DEBUG_HEADERS === "1") {
    console.log(
      `[chat/send][${_reqId}] ua=${req.headers.get("user-agent") || ""} referer=${req.headers.get("referer") || ""}`
    );
  }
  // try/catch 경계에서 사용할 최소 로그 컨텍스트(블록 스코프 이슈 방지)
  let _cidForLog = "";
  let _reqIdForLog = "";
  let debugReasons: string[] = [];
  let _tEnd: (label: string) => void = () => {};
  let _tSendTotal = "";
  let _tPost = "";
  let _pendingUserMsgId = "";
  let _assistantPersisted = false;
  const cleanupPendingUserOnFailure = (chatIdHint: string) => {
    if (!_pendingUserMsgId || _assistantPersisted) return;
    try {
      db.prepare(`DELETE FROM messages WHERE id=? AND chatId=? AND role='user'`).run(_pendingUserMsgId, String(chatIdHint || ""));
      _pendingUserMsgId = "";
    } catch {
      // ignore
    }
  };
  try {
    const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const isConfiguredAdmin = isAdminEmail(u.email);
    const roleRow = isConfiguredAdmin ? null : (db.prepare(`SELECT role FROM users WHERE email=?`).get(u.email) as any);
    const canViewDeveloper = isConfiguredAdmin || String(roleRow?.role || "").toLowerCase() === "admin";

	  const body = await req.json();
	  const wantStreamRaw = Boolean((body as any)?.stream);
	  // Respect client streaming flag. (Some models may be force-buffered later.)
	  let wantStream = wantStreamRaw;

    // body.userText 는 프론트에서 보내는 입력 텍스트.
    // 아래에서 동일 변수명을 다시 선언하지 않도록 별칭을 준다.
	    const {
	      chatId,
	      message,
      userText: userTextInput,
      personaOverride,
      regenerate,
      userMessageId,
      replaceAssistantId,
      continueFromAssistantId,
      runtime,
	    } = body || {};

	    const cid = String(chatId || "").trim();
		    _cidForLog = cid;
	    if (!cid) return bad("채팅이 없습니다. 먼저 '새 채팅 만들기'를 눌러주세요.");
	    const finalUserText = String((typeof userTextInput === "string" ? userTextInput : message) || "").trim();
	    const regen = Boolean(regenerate);
	    const continueAid = String(continueFromAssistantId || "").trim();
	    let replaceAid = String(replaceAssistantId || "").trim();
	    if (continueAid && !replaceAid) replaceAid = continueAid;
    if (continueAid) wantStream = false;
    const userMid = String(userMessageId || "").trim();

	    let effectiveUserText = finalUserText;

	    // 재생성 모드면: userMessageId 기준으로 DB에서 읽어와 정확한 원문을 사용
	    if (continueAid) {
      // Client continuation helpers used to send the previous answer tail in
      // userText. Treating that transport hint as the active story input made
      // memory/focus/scene guards replay the already answered user turn.
      // The authoritative continuation source is continueBaseText below.
      effectiveUserText = "이어쓰기";
	    } else if (regen && userMid) {
	      const row = db.prepare(`SELECT content FROM messages WHERE id=? AND chatId=? AND userEmail=?`).get(userMid, cid, u.email) as any;
	      const raw = row?.content ? decryptIfPossible(row.content) : "";
	      effectiveUserText = String(raw || finalUserText || "").trim();
	    }

	    const userText = effectiveUserText;
    const currentOocInstruction = isOocMetaInstruction(userText) ? userText : "";
    const hasCurrentUserNarration = !currentOocInstruction && hasExplicitNovelNarration(userText);
	    if (!userText) return bad("메시지를 입력해 주세요.");

	    if (!LOCAL_POINTS_DISABLED) {
	      // FriendFee 서버 가드:
	      // 클라이언트 체크(localStorage)를 우회해도, 잔액 0 이하 계정은 서버에서 전송을 차단한다.
	      try {
	        const nowWallet = Date.now();
	        db.prepare(
	          `INSERT INTO friendfee_wallet (userEmail, balance, updatedAt)
	           VALUES (?, 0, ?)
	           ON CONFLICT(userEmail) DO NOTHING`
	        ).run(u.email, nowWallet);
	        const wallet = db.prepare(`SELECT balance FROM friendfee_wallet WHERE userEmail = ?`).get(u.email) as any;
	        const bal = Number(wallet?.balance ?? 0);
	        if (bal <= 0) {
	          return NextResponse.json(
	            { error: "친구비가 부족합니다.", code: "insufficient_friendfee", balance: bal, balanceRounded: Math.round(bal) },
	            { status: 402 }
	          );
	        }
	      } catch {
	        // wallet 조회 실패 시 기존 흐름 유지 (fail-open)
	      }
	    }

		    const reqId = randomUUID();
		    _reqIdForLog = reqId;
    const tSendTotal = `send.total:${cid}:${reqId}`;
    const tPrompt = `send.prompt.build:${cid}:${reqId}`;
    const tGemini = `send.gemini.call:${cid}:${reqId}`;
    const tPost = `send.postprocess:${cid}:${reqId}`;
	    _tSendTotal = tSendTotal;
	    _tPost = tPost;

    // console.time/timeEnd는 dev/서버 환경에서 라벨 중복/예외 미종료로 경고가 자주 뜬다.
    // 대신 Date.now() 기반으로 안정적인 타이밍 로그를 남긴다.
    const _marks = new Map<string, number>();
    const _timings: Array<{ label: string; ms: number }> = [];
    function tStart(label: string) {
      _marks.set(label, Date.now());
      return label;
    }
    function tEnd(label: string) {
      const t0 = _marks.get(label);
      if (typeof t0 !== "number") return;
      const ms = Date.now() - t0;
      const s = ms >= 1000 ? `${(ms / 1000).toFixed(3)}s` : `${ms.toFixed(3)}ms`;
      console.log(`${label}: ${s}`);
      _timings.push({ label: String(label || ""), ms });
      _marks.delete(label);
    }
    function attachServerTimings(usage: any) {
      if (!usage || typeof usage !== "object") return usage;
      usage.serverTimings = _timings.slice(-120);
      return usage;
    }
	    _tEnd = tEnd;

	    tStart(tSendTotal);
	    tStart(tPrompt);
	    debugReasons = [];

	    const tDbChat = `step.db.채팅:${cid}:${reqId}`;
	    tStart(tDbChat);
	    const chat = db.prepare(`SELECT id, presetId FROM chats WHERE id=? AND userEmail=?`).get(cid, u.email) as any;
	    tEnd(tDbChat);
	    if (!chat) return NextResponse.json({ error: "채팅을 찾지 못했습니다." }, { status: 404 });

    const tDbPreset = `step.db.프리셋:${cid}:${reqId}`;
    tStart(tDbPreset);
    const preset = db
      .prepare(
        `SELECT id, name, background, characterName, characterAge, character, systemPrompt,
                firstMessages, lorebooks
         FROM presets WHERE id=?`
      )
      .get(chat.presetId) as any;
    tEnd(tDbPreset);

    if (!preset) return NextResponse.json({ error: "프리셋을 찾지 못했습니다." }, { status: 404 });

    // chat_settings가 없는 경우(마이그레이션/생성 중 누락 등)에는 여기서 기본값으로 자동 생성한다.
    // 404로 떨어지면 프론트에서는 "라우트가 없다"로 오해하기 쉬워 디버깅이 매우 어려워진다.
    const tDbSettings = `step.db.설정:${cid}:${reqId}`;
    tStart(tDbSettings);
    let settings = db.prepare(`SELECT * FROM chat_settings WHERE chatId=?`).get(cid) as any;
    tEnd(tDbSettings);
    if (!settings) {
      try {
        db.prepare(`INSERT OR IGNORE INTO chat_settings (chatId, updatedAt) VALUES (?, ?)`).run(cid, Date.now());
      } catch {
        // ignore
      }
      settings = db.prepare(`SELECT * FROM chat_settings WHERE chatId=?`).get(cid) as any;
    }
    if (!settings) return NextResponse.json({ error: "채팅 설정을 찾지 못했습니다." }, { status: 400 });

    // (중요) 페르소나는 "settings"(DB 저장값) + "personaOverride"(프론트 임시값)을 합쳐서 결정한다.
    // settings에 이름이 비어있으면, override 기반으로 1회 저장해 다음 호출부터 안정적으로 유지한다.
    const persona = resolvePersona(settings, (personaOverride || null) as PersonaOverride);
    persistPersonaIfMissing(db, cid, settings, persona);

	    const continueMode = Boolean(continueAid);
	    let continueBaseText = "";
	    if (replaceAid) {
	      const replaceRow = db
	        .prepare(
	          `SELECT id FROM messages
	           WHERE id=? AND chatId=? AND userEmail=? AND (role='assistant' OR role='model')
	           LIMIT 1`
	        )
	        .get(replaceAid, cid, u.email) as any;
	      if (!replaceRow) {
	        return bad("교체 대상 메시지를 찾지 못했습니다.");
	      }
	    }
	    if (continueMode) {
	      const row = db
	        .prepare(`SELECT role, content FROM messages WHERE id=? AND chatId=? AND userEmail=?`)
	        .get(continueAid, cid, u.email) as any;
	      const role = String(row?.role || "").toLowerCase();
	      if (!row || (role !== "assistant" && role !== "model")) {
	        return bad("이어쓰기 대상 메시지를 찾지 못했습니다.");
	      }
      continueBaseText = String(decryptIfPossible(row?.content || "") || "").trim();
      if (!continueBaseText) return bad("이어쓰기 대상 메시지가 비어 있습니다.");
    }


    const renderMode: "novel" = "novel";

    const now = Date.now();

    // 1) 유저 메시지 저장(재생성/이어쓰기 모드면 저장하지 않음)
    const userMsg = {
      id: regen && userMid ? userMid : randomUUID(),
      chatId: cid,
      role: "user" as const,
      content: userText,
      createdAt: now,
    };

    if (!regen && !continueMode) {
      db.prepare(`INSERT INTO messages (id, chatId, role, content, createdAt, updatedAt, userEmail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        userMsg.id,
        userMsg.chatId,
        userMsg.role,
        encryptIfPossible(userMsg.content),
        userMsg.createdAt,
        userMsg.createdAt,
        u.email
      );
      _pendingUserMsgId = userMsg.id;
    }

    // 2) 전체 메시지 로드
    // (최적화) 모든 메시지를 즉시 복호화하지 않는다.
    // - 실제로 content가 필요한 건 tail(최근 K턴)/recentMsgs/메타 추출 정도
    // - 매우 긴 채팅에서 매 요청마다 전부 복호화하던 비용을 lazy getter로 줄인다.
    // - role/createdAt만 쓰는 카운트 루프는 getter를 건드리지 않으므로 무료.
    const tDbMsgs = tStart("db.전체메시지 로드");
    const _allRowsRaw = db
      .prepare(`SELECT id, role, content, createdAt FROM messages WHERE chatId=? ORDER BY createdAt ASC`)
      .all(cid) as any[];
    const _contentDecryptCache: (string | undefined)[] = new Array(_allRowsRaw.length);
    const all = _allRowsRaw.map((row: any, i: number) => {
      const m: any = { id: row?.id, role: row?.role, createdAt: row?.createdAt };
      Object.defineProperty(m, "content", {
        get() {
          const cached = _contentDecryptCache[i];
          if (cached !== undefined) return cached;
          const v = decryptIfPossible(String(row?.content || ""));
          _contentDecryptCache[i] = v;
          return v;
        },
        enumerable: true,
        configurable: true,
      });
      return m;
    });
    tEnd(tDbMsgs);
    // 3) 메모리 구성:
    // - 최근 컨텍스트는 "유저 입력 K턴" 기준으로 포함한다 (user 메시지 1개 = 1턴)
    // - 장기기억(요약)은 '유저 입력 턴' 기준으로 [memoryFrom..memoryTo] 범위의 대화를 요약
    // - 요약은 매 요청마다 다시 만들지 않고, summaryEvery(5~10턴)마다 갱신 + 설정 변경 시 강제 갱신

    // 최근 K턴(= user 메시지 K개) 원문을 그대로 프롬프트에 포함한다.
// - UI에서는 최근 K턴 조절을 제거했으므로, 서버 기본값을 사용한다.
	// - 요약은 3턴 boundary마다 갱신(summaryEveryVal=3)이라,
	//   keepUserTurns가 너무 작으면 "raw도 없고 요약도 아직 안 된" 갭이 생긴다.
	//   2 * summaryEveryVal + 1 = 7로 두면 boundary 직후에도 항상 직전 1구간을 raw로 보유.
	const keepUserTurns = 7;
    const tTail = tStart("유저프롬프트.최근K턴 선별");
    const tail = selectRecentByUserTurns(all, keepUserTurns);
    tEnd(tTail);

    // 유저 입력만 카운트해서 "입력 턴"을 만든다. (user 메시지 1개 = 1턴)
    let userTurnCount = 0;
    for (const m of all) {
      if (m.role === "user") userTurnCount += 1;
    }

        const rtModel = String((runtime && typeof runtime === "object") ? runtime.model : "").trim();
    const rtOut = Number((runtime && typeof runtime === "object") ? runtime.maxOutputTokens : NaN);
    const rtReason = Number((runtime && typeof runtime === "object") ? runtime.maxReasoningTokens : NaN);

    // (중요) 서버 기본값이 UI/DB 기본값과 어긋나면, "LOW로 설정했는데 실제 요청은 HIGH" 같은
    // 혼선이 생길 수 있다. 따라서 모델별 기본값을 /api/chat/settings의 defaultReasoningTokens와 맞춘다.
    function defaultReasoningTokensByModel(model: string): number {
      return defaultReasoningTokensForModel(model);
      // gemini-2.5-pro (및 기타)
    }
    function defaultOutputCharsByModel(): number {
      // UX 기본 출력 길이(글자수)
      return 1200;
    }

    const chosenModel = coerceChatModelId(rtModel || settings.model || DEFAULT_CHAT_MODEL);

    const sOut = Number(settings?.maxOutputTokens);
    const sReason = Number(settings?.maxReasoningTokens);

    const outRaw = Number.isFinite(rtOut)
      ? rtOut
      : Number.isFinite(sOut)
        ? sOut
        : defaultOutputCharsByModel();

    const reasonRaw = Number.isFinite(rtReason)
      ? rtReason
      : Number.isFinite(sReason)
        ? sReason
        : defaultReasoningTokensByModel(chosenModel);

    const generationAbortController = new AbortController();
    const abortGeneration = () => {
      if (generationAbortController.signal.aborted) return;
      try {
        generationAbortController.abort(req.signal.reason);
      } catch {
        generationAbortController.abort();
      }
    };
    if (req.signal.aborted) abortGeneration();
    else req.signal.addEventListener("abort", abortGeneration, { once: true });

    const opts = {
      model: chosenModel,
      maxOutputTokens: (() => {
        const v = Number(outRaw);
        return Math.max(800, Math.min(5000, Math.floor(v)));
      })(),
      maxReasoningTokens: (() => {
        const v = Number(reasonRaw);
        // UI 선택값(low/mid/high)을 그대로 반영하되, 안전 범위만 클램프한다.
        const minReasoning = isGemini3FlashModel(chosenModel) || isGemini3ProModel(chosenModel) ? 0 : 384;
        return Math.max(minReasoning, Math.min(8192, Math.floor(v)));
      })(),
      signal: generationAbortController.signal,
      // ONE_SHOT is also a billing contract: internal max-token/refusal
      // fallbacks must not silently issue another provider request.
      disableMaxTokensFallback: ONE_SHOT,
      disableRefusalFallback: ONE_SHOT,
    };

    try {
    console.log(JSON.stringify({
      tag: "send.runtime.pick",
      chatId: cid,
      reqId,
      model: opts.model,
      rtOut: Number.isFinite(rtOut) ? rtOut : null,
      rtReason: Number.isFinite(rtReason) ? rtReason : null,
      sOut: Number.isFinite(sOut) ? sOut : null,
      sReason: Number.isFinite(sReason) ? sReason : null,
      pickedOut: opts.maxOutputTokens,
      pickedReason: opts.maxReasoningTokens,
      outSource: Number.isFinite(rtOut) ? "runtime" : Number.isFinite(sOut) ? "settings" : "default",
      reasonSource: Number.isFinite(rtReason) ? "runtime" : Number.isFinite(sReason) ? "settings" : "default",
    }));
  } catch {
    // ignore
  }
// 요약 대상: tail(최근 원문) 제외한 과거 메시지 전체
    // (디버그 로그에서도 참조하므로 먼저 계산한다)
    const olderMsgs = all.slice(0, Math.max(0, all.length - tail.length));

    dbg({
      tag: "send.context",
      chatId: cid,
      reqId,
      model: opts.model,
      maxOutputTokens: opts.maxOutputTokens,
      maxReasoningTokens: opts.maxReasoningTokens,
      keepUserTurns,
      totalMessages: all.length,
      totalUserTurns: userTurnCount,
      tailMessages: tail.length,
      olderMessages: olderMsgs.length,
    });

    // NOTE: 과거 로깅 추가 중 'summaryEvery' 식별자에서 TDZ(Temporal Dead Zone) ReferenceError가
    // 발생한 케이스가 있어, dev 번들(Turbopack)에서도 안전하도록 다른 변수명으로 분리한다.
	// 요약 주기: 고정 3턴 (assistant 응답 3개마다 장기기억 블록 생성)
	const summaryEveryVal = 3;

    // 턴당 글자수: chat_settings.longMemoryPerTurnChars를 사용한다.
    // - 허용값: 80, 140, 160, 200, 260, 320
    const perTurnCharsVal = (() => {
      const n = Number((settings as any)?.longMemoryPerTurnChars ?? 80);
      if (n === 80 || n === 140 || n === 160 || n === 200 || n === 260 || n === 320) return n;
      return 80;
    })();

    

    // '턴'은 기본적으로 1개의 assistant 응답(=완료된 대화 1턴)으로 계산한다.
    // - UI에서 '요약 주기 N턴'은 사용자 체감 기준(문답 1회 = 1턴)에 맞추기 위해 assistant 기준으로 맞춘다.
    const isAsstRole = (role: any) => {
      const r = String(role || "").toLowerCase();
      return r === "assistant" || r === "model";
    };
    const countAssistantTurns = (msgs: any[]) => {
      const firstUserPos = msgs.findIndex((m) => String(m?.role || "").toLowerCase() === "user");
      if (firstUserPos < 0) return 0;
      let turns = 0;
      for (let i = firstUserPos; i < msgs.length; i++) {
        if (isAsstRole(msgs[i]?.role)) turns++;
      }
      return turns;
    };
    const completedTurnCount = countAssistantTurns(all);
    const completedTurnCountNext = completedTurnCount + 1;
// 4) 장기기억 요약 캐시 로드 (UI의 "요약 보기" 및 누적 요약 갱신에 사용)
    const cache = (() => {
      try {
        return db
          .prepare(
            `SELECT recentSummary, updatedAt, lastSummarizedAt, rolledUpCount
             FROM chat_memory_cache
             WHERE chatId=?`
          )
          .get(cid) as any;
      } catch {
        return null;
      }
    })();

    // (중요) 장기기억 캐시는 encryptIfPossible()로 저장될 수 있으므로 항상 복호화 시도
    // - 복호화를 안 하면 normalizeStoredMemorySummary가 빈 문자열로 만들고
    //   UI/프롬프트에서 "장기기억이 갑자기 0"처럼 보이는 문제가 생긴다.
    let historySummary = cache?.recentSummary ? decryptIfPossible(String(cache.recentSummary)) : "";
    // 현재 설정(summaryEvery)에 맞는 블록만 남겨서 prompt/UI 혼란을 방지
    historySummary = sanitizeLongMemorySummary(
      normalizeStoredMemorySummary(historySummary, summaryEveryVal),
      summaryEveryVal
    );
    let lastSummarizedAt = Number(cache?.lastSummarizedAt || 0);
    let rolledUpCount = Number(cache?.rolledUpCount || 0);

// 장기기억(요약.txt) 누적 저장은 "무한"으로 유지한다.
// - 기존에는 10,000자 초과 시 5,000자로 롤업(압축)했는데, 이로 인해 사용자 체감상 "기억이 바뀌거나/초기화"처럼 보이는 문제가 있었다.
// - 이제 기본값은 롤업을 비활성화(무제한)한다.
// - 단, 모델 컨텍스트/비용/지연을 고려해 필요하면 환경변수로 롤업을 다시 켤 수 있다.
//   예) AI_LONG_MEMORY_ROLLUP_MAX_CHARS=10000
const summaryMaxChars = (() => {
  const raw = String(process.env.AI_LONG_MEMORY_ROLLUP_MAX_CHARS ?? "").trim();
  if (!raw) return Number.POSITIVE_INFINITY; // default: unlimited
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
  // 너무 작은 값은 실수로 요약이 과도하게 압축되는 걸 막기 위해 하한을 둔다.
  return Math.max(2000, Math.floor(n));
})();



    async function rollupIfNeeded(summary: string) {
      // 10,000자를 넘기면 기존 요약을 5,000자로 다시 요약(압축)하고 계속 누적
      if (strlenSummary(summary) <= summaryMaxChars) return { summary, rolledUpCount };
      const tLbl = `send.summary.rollup:${cid}:${reqId}`;
      tStart(tLbl);
      dbg({ tag: "send.summary.rollup.start", chatId: cid, reqId, inputChars: strlenSummary(summary) });
	      const endTurn = getSummarizedEndTurn(
	        sanitizeLongMemorySummary(String(summary || ""), summaryEveryVal)
	      );
      const rollupEnd = endTurn > 0 ? endTurn : summaryEveryVal;
      const compact = await summarizeKorean({
        text: summary,
        targetChars: 5000,
        opts,
        turnRangeLabel: `1-${rollupEnd}턴`,
        perTurnChars: perTurnCharsVal,
        guidance: "롤업(압축) 요약: 기존 요약을 더 짧고 조밀하게 유지",
      });
      tEnd(tLbl);
      dbg({ tag: "send.summary.rollup.end", chatId: cid, reqId, outputChars: strlenSummary(compact) });
      rolledUpCount += 1;
      return { summary: compact, rolledUpCount };
    }

// (보정) summarizeKorean 결과의 턴 라벨/구간을 다루는 로직은 _server/summaryStored 로 분리했다.
const summarizedEndTurn = getSummarizedEndTurn(
  sanitizeLongMemorySummary(String(historySummary || ""), summaryEveryVal)
);
const boundaryEndTurn = Math.floor(completedTurnCountNext / summaryEveryVal) * summaryEveryVal;

// 이번 경계(boundaryEndTurn)에서 요약할 고정 구간: [boundary-summaryEvery+1 .. boundary]
const windowStartTurn = Math.max(1, boundaryEndTurn - summaryEveryVal + 1);
const windowEndTurn = Math.max(windowStartTurn, boundaryEndTurn);

const hasRangeBlock = (() => {
  const s = String(historySummary || "");
  if (!s.trim()) return false;
  const re = new RegExp(
    `^##\\s*장기\\s*기억\\s*\\(\\s*${windowStartTurn}\\s*-\\s*${windowEndTurn}\\s*턴\\s*\\)`,
    "m"
  );
  return re.test(s);
})();

const shouldRefresh = (() => {
  if (completedTurnCountNext < summaryEveryVal) return false;
  if (boundaryEndTurn <= 0) return false;

  // 이미 요약된 구간이면 갱신 불필요
  if (boundaryEndTurn <= summarizedEndTurn) return false;

  // 캐시가 없거나 비어 있으면 생성
  if (!cache) return true;
  if (!String(historySummary || "").trim()) return true;

  // 현재 window 블록이 누락/손상되면 재생성
  if (!hasRangeBlock) return true;

  // 그 외는 boundary 진입(=새 window 도달)로 갱신
  return true;
})();

	// 단일 요약 텍스트(요약.txt)만 유지: 캐릭터/씬 스토리메모리 갱신 신호는 제거
	const mode = shouldRefresh ? "all" : null;
	const memoryRefresh = {
	  shouldRefresh,
	  mode,
	  boundaryEndTurn,
	  windowStartTurn,
	  windowEndTurn,
	  runtime: runtime || null,
	  completedTurnCount: completedTurnCountNext,
	};



// Legacy helper kept for future manual refresh strategies.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _refreshLongMemoryNow = async () => {
  // 이번 갱신에서 요약할 턴 구간(항상 summaryEveryVal 크기의 고정 구간)
  const startTurn = windowStartTurn;
  const endTurn = windowEndTurn;
const tailStartIdx = Math.max(0, all.length - tail.length);
const rangeMsgs = selectMessagesForAssistantTurnRangeCapped(all, startTurn, endTurn, tailStartIdx);
let rangeMsgs2 = rangeMsgs;
      // 장기기억 요약용 원문(미디어 제거된 평문)
// 첫 요약 블록(예: 1- )에서 cap 때문에 원문이 비는 경우가 있어 seed 요약은 uncapped로 생성한다.
if (rangeMsgs2.length === 0 && summarizedEndTurn <= 0 && startTurn === 1) {
  rangeMsgs2 = selectMessagesForAssistantTurnRange(all, startTurn, endTurn);
}
      if (rangeMsgs2.length > 0) {
	  const raw = formatTurns(rangeMsgs2);
	  // (중요) 요약 입력이 빈 문자열로 들어가던 버그 방지: 실제 대화 원문(raw)을 사용
	  const rawForSummary = stripUrlsAndMediaMarkdown(raw);
        const tLbl = summarizedEndTurn <= 0 ? `send.summary.full:${cid}:${reqId}` : `send.summary.delta:${cid}:${reqId}`;
        tStart(tLbl);

        const turnCountInRange = Math.max(1, endTurn - startTurn + 1);
        const targetChars = Math.min(100000, Math.max(50, perTurnCharsVal * turnCountInRange));
        const rangeLabel = startTurn === endTurn ? `${startTurn}턴` : `${startTurn}-${endTurn}턴`;

        dbg({
          tag: summarizedEndTurn <= 0 ? "send.summary.full.start" : "send.summary.delta.start",
          chatId: cid,
          reqId,
          startTurn,
          endTurn,
          turns: turnCountInRange,
          inputChars: raw.length,
          targetChars,
          rangeMessages: rangeMsgs.length,
          rangeLabel,
        });

        // 장기기억 요약은 "라벨 요약"(summarizeKorean) 대신, 자연 문장(1~3문장) 기반 요약을 사용한다.
        // - LOW/MID/HIGH는 targetChars(=턴당 글자수 * N턴)로만 조절
        // - 하드컷 대신 문장 마무리를 위해 약간(약 15%)의 여유를 허용
        // - 대명사로 시작하는 주어 생략 문장을 피하고, "누가 무엇을 했다" 형태를 강제
        const extraGuidance = [
          String(settings.longMemoryGuidance || "").trim(),
          "문장은 인물/기관을 주어로 명시해 '누가 무엇을 했다' 형태로 쓴다.",
          "대명사(그/그녀/당신/너)로 문장을 시작하지 않는다.",
          "말투는 반말(해체, '~다')로 통일하고 '~요/~습니다' 존댓말 종결을 쓰지 않는다.",
          "문장 앞에 '!' '*' 같은 기호를 붙이지 않는다.",
        ].filter(Boolean).join(" / ");

        const body = await summarizeLongMemoryKorean({
          text: rawForSummary,
          targetChars,
          guidance: extraGuidance,
          opts,
        });

        // 범위 헤더를 서버가 직접 강제해 구간 파싱/증분 갱신을 안정화한다.
        const chunkWithHeader = `## 장기 기억 (${rangeLabel})

${body}`.trim();
        const cleanedChunk = sanitizeLongMemorySummary(normalizeSummaryTail(chunkWithHeader), summaryEveryVal);

        tEnd(tLbl);

        dbg({
          tag: summarizedEndTurn <= 0 ? "send.summary.full.end" : "send.summary.delta.end",
          chatId: cid,
          reqId,
          outputChars: strlenSummary(cleanedChunk),
          rangeLabel,
        });

        const combined = sanitizeLongMemorySummary(
          upsertSummaryRangeBlock(historySummary || "", cleanedChunk, startTurn, endTurn).trim(),
          summaryEveryVal
        );

        // 10,000자 제한 + 롤업(5,000자 압축)
        let rolled = await rollupIfNeeded(combined);
        historySummary = sanitizeLongMemorySummary(normalizeSummaryTail(rolled.summary), summaryEveryVal);
        rolledUpCount = rolled.rolledUpCount;

        // 롤업 이후에도 여전히 10,000자 넘는다면 한 번 더 압축(안전장치)
        if (strlenSummary(historySummary) > summaryMaxChars) {
          const rolled2 = await rollupIfNeeded(historySummary);
          historySummary = sanitizeLongMemorySummary(normalizeSummaryTail(rolled2.summary), summaryEveryVal);
          rolledUpCount = rolled2.rolledUpCount;
        }

        // lastSummarizedAt은 "마지막으로 요약에 포함된 메시지 createdAt의 최대값"으로 유지한다.
        const newestAt = rangeMsgs.reduce((mx, m) => Math.max(mx, Number(m?.createdAt || 0)), 0);
        lastSummarizedAt = newestAt || Number(lastSummarizedAt || 0) || Date.now();
      } else {
        // 메시지가 없으면 갱신하지 않음
      }

      // 요약 캐시 저장(조회용) - UI에서 "요약 보기"로 확인
      try {
        // (중요) 저장 시 헤더(## 장기 기억 (a-b턴)) 구조를 유지해야 다음 증분 갱신 파싱이 안정적이다.
        // - postprocessLongMemorySummary()는 ##/### 구조를 지워버려 누적 갱신을 깨뜨릴 수 있으므로 제거
        // Keep headings in storage (## / ###) for "요약.txt" style.
        const historySummaryToStore = stripUrlsAndMediaMarkdown(String(historySummary || ""), { keepHeadings: true });
        const summaryChars = strlenSummary(historySummaryToStore);
        db.prepare(
          `INSERT INTO chat_memory_cache (chatId, recentSummary, recentSummaryChars, updatedAt, lastSummarizedAt, rolledUpCount)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(chatId) DO UPDATE SET
             recentSummary=excluded.recentSummary,
             recentSummaryChars=excluded.recentSummaryChars,
             updatedAt=excluded.updatedAt,
             lastSummarizedAt=excluded.lastSummarizedAt,
             rolledUpCount=excluded.rolledUpCount`
        ).run(
          cid,
          encryptIfPossible(historySummaryToStore),
          summaryChars,
          Date.now(),
          Number(lastSummarizedAt || 0),
          Number(rolledUpCount || 0)
        );


      } catch {
        // 캐시 실패는 치명적이지 않으므로 무시
      }
    
};

// (중요) 스트리밍 응답을 우선한다.
// - 장기기억/스토리메모리 갱신(LLM 호출)은 /api/chat/send 경로에서 실행하지 않는다.
// - 필요 시 클라이언트가 /api/chat/memory/refresh 를 별도 호출하도록 memoryRefresh 신호만 내려준다.

    // 5) 시스템 프롬프트 구성
    // (병목 분석 로그용) 구성 요소별 시간 측정: 페르소나설정 / 프리셋 / 로어북 / 유저노트 / 장기기억
    const tPersonaBlock = tStart("페르소나설정");
    // NOTE: personaOverride(프론트 임시값) + settings(DB 저장값)을 이미 resolvePersona로 합쳤다.
    // user 입력 1턴 기준(=user 메시지)으로 프롬프트가 흔들리지 않도록 여기서는 persona만 사용한다.
    const inferredPersonaName = persona.name ? "" : inferPersonaNameFromMessages(all);
    if (!persona.name && inferredPersonaName) {
      persona.name = inferredPersonaName;
      persistPersonaIfMissing(db, cid, settings, persona);
    }
    const personaNameFinal = persona.name || inferredPersonaName || "주인공";
    const personaAgeFinal = persona.age || 0;
    const personaGenderFinal = persona.gender;
    const personaInfoFinal = persona.info;
    const authoritativePersonaFacts = buildAuthoritativePersonaFacts({
      name: personaNameFinal,
      age: personaAgeFinal,
      gender: personaGenderFinal,
      info: personaInfoFinal,
    });

    const personaBlock = [
      // (G9) 페르소나 헤더에 "사용자 소유" 영역임을 명시 — NPC가 대신 말하거나 감정/행동을 단정할 수 없는 영역.
      // 이 한 줄이 1.1/1.2/3.6/3.7 규칙의 anchor 역할을 한다.
      `# (1) 페르소나(주인공 = 사용자가 조종하는 인물. NPC가 대신 말하거나 감정·행동·심리를 단정할 수 없는 영역)`,
      `- 이름: ${personaNameFinal || "(미입력)"}`,
      `- 나이: ${personaAgeFinal ? String(personaAgeFinal) : "(미입력)"}`,
      `- 성별: ${personaGenderFinal || "(미입력)"}`,
      `- 상세 정보: ${personaInfoFinal || ""}`,
    ].join("\n");
    tEnd(tPersonaBlock);

    const tPresetBlock = tStart("프리셋");

    // IMPORTANT:
    // `preset.systemPrompt` may start with fenced blocks (e.g. ```STATUS templates).
    // If we inline it on the same line as the "- 추가지침:" label, the opening ``` is no longer
    // at the start of a line. That breaks BOTH:
    // 1) Prompt-side meta template detection (regex anchored at line-start)
    // 2) The model's own recognition of fenced blocks
    // Result: missing/garbled status panels and "미상" fallbacks.
    // So we render the systemPrompt on its own lines.
    const presetBlock = [
      `# 프리셋`,
      `- 배경: ${preset.background}`,
      `- 상대방 캐릭터 이름: ${preset.characterName || ""}`,
      `- 상대방 나이: ${preset.characterAge || 0}`,
      `- 상대방 캐릭터(성격/말투/행동 원칙): ${preset.character}`,
      `- 추가지침(금칙/우선순위/형식):`,
      `${preset.systemPrompt || ""}`,
    ].join("\n");
    tEnd(tPresetBlock);

    // (요구사항)
    // 작업실(캐릭터 제작)에서 저장한 로어북을 대화 프롬프트에 반영한다.
    // - 로어는 기본적으로 '활성화 키'가 최근 대화/입력에 등장하면 포함한다.
    // - 키가 비어있거나 매칭되는 항목이 없으면, 활성화된 로어 중 앞부분 일부를 포함한다.
    const pickLorebooks = () => {
      const tLore = tStart("로어북");
      try {
        const raw = String(preset?.lorebooks || "[]");
        // (최적화) preset.lorebooks는 큰 JSON일 수 있고 매 send마다 같은 string을 파싱하던 비용을 캐싱.
        // 키: raw 문자열 자체 길이 + 첫 24자(시그니처). 다른 preset/버전이면 자연스럽게 캐시 미스.
        const arr = parseLorebooksCached(raw);

        const enabled = arr
          .filter((x) => x && typeof x === "object")
          .filter((x) => x.enabled !== false);

        // (로어 활성화 기준: 최근 3턴 + 이번 유저 입력)
        // - 장기요약(historySummary), 유저 노트(userNote), 제작 프롬프트/페르소나는
        //   '활성화 조건'에서 제외하여 불필요한 로어 호출 토큰 폭탄을 방지한다.
        const recentMsgs = selectRecentByUserTurns(all, 3);
        const recentMsgsText = recentMsgs.map((m: any) => String(m?.content || "")).join("\n");
        const recentText = `${recentMsgsText}\n${userText || ""}`;

        const norm = (s: string) => String(s || "").toLowerCase();
        const h = norm(recentText);

        const scored = enabled.map((lb, idx) => {
          // NOTE: Workspace saves activation keys as `activationKeys: string[]`.
          // Keep backward-compat with older shapes (activationKey/key/keys) as well.
          const keyRaw = lb.activationKeys ?? lb.activationKey ?? lb.key ?? lb.keys ?? "";
          const keys = Array.isArray(keyRaw)
            ? keyRaw.map((k: any) => String(k || "").trim()).filter(Boolean)
            : String(keyRaw || "")
                .split(/[,\r\n]+/)
                .map((k) => String(k || "").trim())
                .filter(Boolean);

          const alwaysOn = lb?.alwaysOn === true;

          let score = 0;
          for (const k of keys) {
            const kk = norm(k);
            if (kk && h.includes(kk)) score += 10;
          }
          return { lb, idx, score, keys, alwaysOn };
        });

        // 상시 포함(alwaysOn): 상단(정렬 전 원래 순서) 5개까지만 "무조건" 포함
        const always = scored
          .filter((x) => x.alwaysOn)
          .sort((a, b) => a.idx - b.idx)
          .slice(0, 5);

        // 키 매칭: 점수순 (상시 제외), 남은 슬롯만 채움
        scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
        const matched = scored
          .filter((x) => x.score > 0 && !x.alwaysOn)
          .slice(0, Math.max(0, 12 - always.length));

        // merge unique (always first), cap total 12
        const seen = new Set<string>();
        const pickedRaw = [...always, ...matched].filter((x) => {
          const id = String(x.lb?.id || x.lb?.name || x.idx);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }).slice(0, 12);

        const picked = pickedRaw
          .map((x) => ({
            name: String(x.lb?.name || "").trim(),
            content: String(x.lb?.content || x.lb?.text || "").trim(),
            keys: x.keys,
          }))
          .filter((x) => x.name || x.content);

        // (옵션 A) 매칭/상시 포함이 없으면 로어북을 프롬프트에 넣지 않는다(토큰 절약)
        if (!picked.length) return "";

        const lines: string[] = ["# 로어북(작업실)"];
        for (const lb of picked) {
          const k = lb.keys && lb.keys.length ? ` (키: ${lb.keys.join(", ")})` : "";
          lines.push(`- ${lb.name || "(무제)"}${k}`);
          if (lb.content) lines.push(`  - ${lb.content}`);
        }
        return lines.join("\n");
      } finally {
        tEnd(tLore);
      }
    };

    const loreBlock = pickLorebooks();
    const temporalCanon = buildTemporalCanon(all);
    const pastDatedAnchors = temporalCanon?.confirmed
      ? extractPastDatedAnchors([presetBlock, loreBlock].filter(Boolean).join("\n\n"), temporalCanon)
      : [];
    const temporalOverrideRequested = hasTemporalOverrideRequest(userText);
    const temporalPriorityBlock = temporalOverrideRequested
      ? ""
      : formatTemporalCanonBlock(temporalCanon, pastDatedAnchors);

    const tUserNote = tStart("유저노트");
    const noteBlock = settings.userNote
      ? `# (3) 유저노트(답변 생성 시 참고)\n${settings.userNote}`
      : `# (3) 유저노트(답변 생성 시 참고)\n(없음)`;
    tEnd(tUserNote);

    const tLongMemoryBlock = tStart("장기기억");
    const memoryQueryText = [
      userText,
      tail
        .slice(-8)
        .map((m: any) => String(m?.content || ""))
        .join("\n"),
    ].join("\n");
    const hybridMemory = selectHybridMemory({
      historySummary,
      queryText: memoryQueryText,
      primaryQueryText: userText,
      currentArcTurns: 15,
      currentArcMaxChars: 3200,
      maxRelatedSections: 6,
      maxRelatedChars: 2400,
      fallbackSections: 3,
    });
    // Search the indexed block ledger on every turn. Passing an empty archive
    // prevents the cumulative summary from suppressing the same detailed range.
    const indexedRelatedMemory = buildRelatedMemoryBlocks({
      chatId: cid,
      queryText: memoryQueryText,
      primaryQueryText: userText,
      historySummary: "",
      maxBlocks: 5,
      maxChars: 1800,
    });
    const indexedArchiveText = String(indexedRelatedMemory.blockText || "").trim();
    const hybridArchiveText = String(hybridMemory.relatedArchiveText || "").trim();
    let relatedArchiveText = indexedArchiveText || hybridArchiveText;
    if (indexedArchiveText && hybridArchiveText) {
      const indexedRanges = new Set(
        indexedRelatedMemory.blocks.map(
          (block) => `${block.startTurn}:${block.endTurn}`
        )
      );
      const hybridSupplementCandidates = extractSummarySections(hybridArchiveText)
        .filter(
          (section) =>
            !indexedRanges.has(`${section.startTurn}:${section.endTurn}`)
        )
        .map((section) => {
          const range =
            section.startTurn === section.endTurn
              ? `${section.endTurn}턴`
              : `${section.startTurn}-${section.endTurn}턴`;
          const text = `### ${section.title} (${range})\n${section.body}`.trim();
          return {
            section,
            text,
            startTurn: section.startTurn,
            endTurn: section.endTurn,
          };
        });
      const hybridSupplements = rankMemoryRetrievalCandidates({
        candidates: hybridSupplementCandidates,
        primaryQueryText: userText,
        contextQueryText: memoryQueryText,
        maxItems: 3,
        maxChars: 1200,
      });
      if (hybridSupplements.length > 0) {
        relatedArchiveText = [
          indexedArchiveText,
          "# (2-B2) 누락 구간 보완 장기기억",
          "- 인덱스 검색과 겹치지 않는 원인·후속 사건만 전체 요약에서 보완한다.",
          hybridSupplements.map((item) => item.text).join("\n\n"),
        ].join("\n\n");
      }
    }
    const characterFocusText = userText;
    let recentCharacterFocusText = "";

    // The active-state ledger must see the full enabled roster, including the
    // persona. The narrower NPC-only list remains for identity canon/world
    // direction so a large cast cannot bloat those unrelated prompt blocks.
    const continuityLedgerIdentities = (db
      .prepare(
        `SELECT id, name, aliases, role, profile, relationshipNote,
                emotionNote, status
         FROM chat_character_roster
         WHERE chatId=? AND enabled != 0
         ORDER BY updatedAt DESC, name ASC`
      )
      .all(cid) as any[]).map((row) => ({
        id: String(row?.id || ""),
        name: String(row?.name || ""),
        aliases: decryptIfPossible(String(row?.aliases || "")),
        role: decryptIfPossible(String(row?.role || "")),
        profile: decryptIfPossible(String(row?.profile || "")),
        relationshipNote: decryptIfPossible(String(row?.relationshipNote || "")),
        emotionNote: decryptIfPossible(String(row?.emotionNote || "")),
        status: decryptIfPossible(String(row?.status || "")),
      }));
    const continuityIdentities = continuityLedgerIdentities
      .filter((identity) => {
        const personaKey = personaNameFinal.trim().toLowerCase();
        if (!personaKey) return true;
        if (identity.name.trim().toLowerCase() === personaKey) return false;
        return !identity.aliases
          .split(/[\n,;\/|]+/g)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .includes(personaKey);
      })
      .slice(0, 40);
    const previousUserTextsForFocus: string[] = [];
    for (let i = all.length - 1; i >= 0 && previousUserTextsForFocus.length < 12; i -= 1) {
      const message: any = all[i];
      if (String(message?.role || "").toLowerCase() !== "user") continue;
      if (String(message?.id || "") === String(userMsg.id || "")) continue;
      previousUserTextsForFocus.push(String(message?.content || ""));
    }
    const activeCharacterFocus = resolveActiveCharacterFocus({
      identities: continuityIdentities.map((identity) => ({
        id: identity.id,
        name: identity.name,
        aliases: identity.aliases,
      })),
      currentUserText: userText,
      previousUserTexts: previousUserTextsForFocus,
      maxPreviousTurns: 12,
    });
    // Assistant narration is intentionally excluded here. A hallucinated speaker
    // must not become the next turn's interlocutor merely because the model named it.
    recentCharacterFocusText = activeCharacterFocus.anchorText;
    const continuityLedger = buildContinuityLedgerBlock({
      historySummary,
      identities: continuityLedgerIdentities,
      userText,
      focusNames: [personaNameFinal],
    });
    const identityCanon = buildIdentityCanonBlock({
      messages: all,
      knownNames: continuityIdentities.map((identity) => identity.name),
      personaName: personaNameFinal,
      characterSources: continuityIdentities,
    });
    // Scene membership is persistent state. Earlier versions tried to retire
    // frequently mentioned NPCs automatically; that directly conflicted with
    // recent user-authored locations and caused arbitrary exits or incapacitation.
    let dynamicCharacterContext = {
      block: "",
      focusedRosterIds: [] as string[],
      focusedNames: [] as string[],
      includedNames: [] as string[],
      personaAliases: [] as string[],
      recognition: [] as Array<{
        characterId: string;
        characterName: string;
        characterAliases: string[];
        firstInteractionTurn: number;
        lastInteractionTurn: number;
        evidence: string;
      }>,
      relationshipCount: 0,
      eventCount: 0,
    };
    let relationshipGraph: RelationshipGraphData = {
      personaName: personaNameFinal,
      nodes: [],
      relations: [],
      affinities: [],
    };
    try {
      syncIdentityCanonRelations({
        chatId: cid,
        canon: identityCanon.canon,
        turnNo: completedTurnCountNext,
      });
      syncCharacterVitals({
        chatId: cid,
        messages: all,
        canon: identityCanon.canon,
        personaName: personaNameFinal,
        personaAge: personaAgeFinal,
      });
      relationshipGraph = loadRelationshipGraph(cid);
      dynamicCharacterContext = buildDynamicCharacterContext({
        chatId: cid,
        personaName: personaNameFinal,
        focusText: characterFocusText,
        recentFocusText: recentCharacterFocusText,
        // The active user-authored focus anchors pronouns without changing who
        // is physically present in the scene.
        userMentionText: activeCharacterFocus.anchorText || characterFocusText,
        priorityNames: continuityLedger.promptStates.map((state) => state.name),
        graph: relationshipGraph,
      });
    } catch (error) {
      console.error("[chat/send] dynamic character context failed", {
        chatId: cid,
        reqId,
        error: String((error as { message?: unknown })?.message || error),
      });
    }
    const focusedCanonNames = new Set(
      [
        personaNameFinal,
        ...continuityLedger.promptStates.map((state) => state.name),
        ...dynamicCharacterContext.focusedNames,
        ...dynamicCharacterContext.includedNames,
      ]
        .map((value) => String(value || "").trim().toLocaleLowerCase("ko-KR"))
        .filter(Boolean)
    );
    const focusedCharacterCanonNames = new Set(
      [
        ...continuityLedger.promptStates.map((state) => state.name),
        ...dynamicCharacterContext.focusedNames,
      ]
        .map((value) => String(value || "").trim().toLocaleLowerCase("ko-KR"))
        .filter(Boolean)
    );
    const canonNameMatches = (value: unknown, names: Set<string>) => {
      const text = String(value || "").trim().toLocaleLowerCase("ko-KR");
      if (!text) return false;
      for (const name of names) {
        if (text === name || text.includes(name) || name.includes(text)) return true;
      }
      return false;
    };
    const canonNameMatchesFocus = (value: unknown) =>
      canonNameMatches(value, focusedCanonNames);
    const canonNameMatchesFocusedCharacter = (value: unknown) =>
      canonNameMatches(value, focusedCharacterCanonNames);
    const identityCanonForPrompt = {
      ...identityCanon.canon,
      nameFacts: identityCanon.canon.nameFacts.filter(
        (fact) =>
          canonNameMatchesFocus(fact.canonicalName) ||
          fact.aliases.some(canonNameMatchesFocus) ||
          canonNameMatchesFocus(fact.subject)
      ),
      roleAnchors: identityCanon.canon.roleAnchors.filter(
        (anchor) =>
          canonNameMatchesFocusedCharacter(anchor.subjectName) ||
          canonNameMatchesFocusedCharacter(anchor.relatedName)
      ),
    };
    const identityCanonBlock = formatIdentityCanonBlock(identityCanonForPrompt);
    let canonicalCharacterFacts = [] as ReturnType<typeof loadCanonicalCharacterFacts>;
    let canonicalCharacterFactsBlock = "";
    try {
      canonicalCharacterFacts = loadCanonicalCharacterFacts(cid);
      canonicalCharacterFactsBlock = formatCanonicalCharacterFactsBlock({
        persona: authoritativePersonaFacts,
        facts: canonicalCharacterFacts,
        focusNames: [
          personaNameFinal,
          preset.characterName,
          ...continuityLedger.promptStates.map((state) => state.name),
          ...dynamicCharacterContext.focusedNames,
          ...dynamicCharacterContext.includedNames,
        ],
      });
    } catch (error) {
      console.error("[chat/send] canonical character facts failed", {
        chatId: cid,
        reqId,
        error: String((error as { message?: unknown })?.message || error),
      });
    }
    const physicalFactIdentities = buildPhysicalFactIdentities({
      persona: authoritativePersonaFacts,
      facts: canonicalCharacterFacts,
      characters: continuityLedgerIdentities.map((identity) => ({
        name: identity.name,
        aliases: identity.aliases,
      })),
    });
    const physicalFactOwnershipBlock = formatPhysicalFactOwnershipBlock(
      physicalFactIdentities
    );
    if (dynamicCharacterContext.block) {
      // Event summaries can mention both the memory owner and the persona. Make
      // every exact canonical measurement self-identifying before the JSON is
      // reused, so character_id cannot absorb another participant's body facts.
      dynamicCharacterContext = {
        ...dynamicCharacterContext,
        block: enforcePhysicalFactOwnership({
          text: dynamicCharacterContext.block,
          identities: physicalFactIdentities,
        }).text,
      };
    }
    const spatialCanon = buildSpatialCanon({
      messages: all,
      knownNames: continuityIdentities.map((identity) => identity.name),
      identities: [
        ...continuityLedgerIdentities.map((identity) => ({
          canonicalName: identity.name,
          aliases: identity.aliases,
        })),
        ...identityCanon.canon.nameFacts.map((fact) => ({
          canonicalName: fact.canonicalName,
          aliases: fact.aliases,
        })),
      ],
      personaName: personaNameFinal,
      focusText: [
        characterFocusText,
        recentCharacterFocusText,
        hybridMemory.currentArcText,
        relatedArchiveText,
      ].join("\n"),
    });
    try {
      const replaceSpatialStates = db.transaction(() => {
        db.prepare(`DELETE FROM chat_spatial_states WHERE chatId=?`).run(cid);
        const insert = db.prepare(
          `INSERT INTO chat_spatial_states
             (chatId, stateKey, stateType, subjectName, location, companionsJson,
              evidence, sourceTurn, sourceOrder, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const now = Date.now();
        for (const placement of spatialCanon.temporaryPlacements) {
          insert.run(
            cid,
            `placement:${String(placement.subjectName || "").toLocaleLowerCase("ko-KR")}`,
            "placement",
            placement.subjectName,
            placement.location,
            encryptIfPossible(JSON.stringify(placement.companionNames)),
            encryptIfPossible(placement.evidence),
            placement.sourceTurn,
            placement.sourceOrder,
            now
          );
        }
        if (spatialCanon.currentScene) {
          insert.run(
            cid,
            "scene:current",
            "scene",
            "",
            spatialCanon.currentScene.location,
            encryptIfPossible("[]"),
            encryptIfPossible(spatialCanon.currentScene.evidence),
            spatialCanon.currentScene.sourceTurn,
            spatialCanon.currentScene.sourceOrder,
            now
          );
        }
      });
      replaceSpatialStates();
    } catch (error) {
      console.error("[chat/send] spatial state persistence failed", {
        chatId: cid,
        reqId,
        error: String((error as { message?: unknown })?.message || error),
      });
    }
    // (변경 2026-08) 등록 캐릭터/관계도는 "항상" 주입한다.
    // - 기존에는 동적 조회(dynamicCharacterContext)가 비었을 때만 쓰는 복구 경로였는데,
    //   동적 조회는 현재 입력에 이름이 언급된 캐릭터만 포커스하므로
    //   "이름 없이 지칭한 인물"이나 "오래 안 나온 인물"의 관계가 통째로 빠졌다.
    //   (실제 사고: 사용자가 새 인물을 이름 없이 도입하자 최근 캐릭터로 오인)
    // - 관계도는 전체를 넣어도 1천자 내외라 비용이 미미하고, 관계 혼동을 크게 줄인다.
    // - 롤백: AI_ALWAYS_INJECT_ROSTER=0 이면 기존처럼 fallback 전용으로 동작.
    const alwaysInjectRoster = String(process.env.AI_ALWAYS_INJECT_ROSTER || "1").trim() !== "0";
    let manualCharacterRosterFallback = "";
    if (alwaysInjectRoster || !dynamicCharacterContext.block) {
      try {
        manualCharacterRosterFallback = buildManualCharacterRosterBlock(
          cid,
          characterFocusText,
          personaNameFinal,
          recentCharacterFocusText,
          physicalFactIdentities,
          !dynamicCharacterContext.block
        );
      } catch (error) {
        console.error("[chat/send] manual character context fallback failed", {
          chatId: cid,
          reqId,
          error: String((error as { message?: unknown })?.message || error),
        });
      }
    }
    const epistemicFirewall = buildEpistemicPromptFirewall(relationshipGraph);
    const legalIdentityByName = new Map<string, LegalStatusIdentity>();
    const addLegalIdentity = (identity: LegalStatusIdentity) => {
      const name = String(identity.name || "").replace(/\s+/g, " ").trim();
      if (!name) return;
      const key = name.toLocaleLowerCase("ko-KR");
      const previous = legalIdentityByName.get(key);
      legalIdentityByName.set(key, {
        name,
        aliases: [
          ...new Set([
            ...(previous?.aliases || []),
            ...(identity.aliases || []),
          ].map((alias) => String(alias || "").trim()).filter(Boolean)),
        ],
        isPersona: Boolean(previous?.isPersona || identity.isPersona),
      });
    };
    addLegalIdentity({
      name: personaNameFinal,
      aliases: dynamicCharacterContext.personaAliases,
      isPersona: true,
    });
    for (const identity of continuityIdentities) {
      let aliases: string[] = [];
      const rawAliases = String(identity.aliases || "").trim();
      try {
        const parsed = JSON.parse(rawAliases);
        aliases = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        aliases = rawAliases.split(/[\n,;\/|]+/u);
      }
      addLegalIdentity({ name: identity.name, aliases });
    }
    for (const node of relationshipGraph.nodes) {
      addLegalIdentity({ name: node.name, isPersona: node.isPersona });
    }
    const legalStatusIdentities = [...legalIdentityByName.values()];
    const relationshipClaimIdentities = legalStatusIdentities.map((identity) => ({
      name: identity.name,
      aliases: identity.aliases || [],
    }));
    const trustedLegalStatusUserTexts = all
      .filter((message) => String(message?.role || "") === "user")
      .map((message) => String(message?.content || ""));
    // 저장된 서술도 근거다. 롤플레이 사건은 대부분 서술로 성립하므로, 사용자가
    // 그 단어를 직접 친 적이 없다는 이유로 확정 사실을 지우면 안 된다. 지어내기는
    // 생성 시점 가드가 막는다(아래 createGuardedTextStream).
    const trustedLegalStatusNarrationTexts = all
      .filter((message) => {
        const role = String(message?.role || "");
        return role === "assistant" || role === "model";
      })
      .map((message) => String(message?.content || ""))
      // Dialogue/briefing prose is not allowed to authenticate its own legal
      // claim on later turns. Keep ordinary completed narration (for example a
      // narrated arrest), but exclude authority speech and quoted assertions.
      .filter((text) => !isAuthorityClaimContext(text))
      .map((text) =>
        text
          .replace(/"[^"\n]*"/gu, " ")
          .replace(/“[^”\n]*”/gu, " ")
          .replace(/‘[^’\n]*’/gu, " ")
      );
    const authorityClaimContext = isAuthorityClaimContext(
      [...trustedLegalStatusUserTexts.slice(-4), userText].join("\n")
    );
    const sanitizeAuthorityClaims = (text: unknown) =>
      removeUnsupportedAuthorityClaims({
        text,
        trustedUserTexts: trustedLegalStatusUserTexts,
        identities: legalStatusIdentities,
        authorityContext: authorityClaimContext,
      });
    const vitalStatusIdentities = legalStatusIdentities.map((identity) => ({
      name: identity.name,
      aliases: identity.aliases || [],
    }));
    const establishedDeceasedNames = continuityLedger.states
      .filter((state) => state.kind === "deceased")
      .map((state) => state.name);
    const sanitizeVitalStatus = (text: unknown) =>
      removeUnsupportedVitalStatusClaims({
        text,
        trustedUserTexts: trustedLegalStatusUserTexts,
        identities: vitalStatusIdentities,
        establishedDeceasedNames,
      });
    const sanitizeRelationshipClaims = (text: unknown, contextText: unknown = "") =>
      removeUnsupportedRelationshipClaims({
        text,
        contextText,
        trustedUserTexts: trustedLegalStatusUserTexts,
        identities: relationshipClaimIdentities,
        relations: relationshipGraph.relations,
      });
    const relationshipCanonGuardBlock = formatRelationshipCanonGuardBlock({
      relations: relationshipGraph.relations,
    });
    const groundedEpistemicFactIds = buildGroundedEpistemicFactIds(
      epistemicFirewall,
      trustedLegalStatusUserTexts
    );
    const sanitizeGeneratedFacts = (text: unknown) =>
      sanitizeGeneratedEpistemicText(text, epistemicFirewall, {
        groundedFactIds: groundedEpistemicFactIds,
      });
    const sanitizePhysicalOwnership = (text: unknown) =>
      enforcePhysicalFactOwnership({
        text,
        identities: physicalFactIdentities,
      });
    const recoverAfterOverfilter = (text: unknown) => {
      const original = String(text || "");
      const epistemic = sanitizeGeneratedFacts(text);
      const authorityClaims = sanitizeAuthorityClaims(epistemic.text);
      const legalStatus = removeUnsupportedLegalStatusClaims({
        text: authorityClaims.text,
        trustedUserTexts: trustedLegalStatusUserTexts,
        trustedNarrationTexts: trustedLegalStatusNarrationTexts,
        identities: legalStatusIdentities,
      });
      const vitalStatus = sanitizeVitalStatus(legalStatus.text);
      const relationshipClaims = sanitizeRelationshipClaims(vitalStatus.text);
      const physicalOwnership = sanitizePhysicalOwnership(relationshipClaims.text);
      if (
        epistemic.redactedSegments > 0 ||
        authorityClaims.removed > 0 ||
        legalStatus.removed > 0 ||
        vitalStatus.removed > 0 ||
        relationshipClaims.removed > 0 ||
        relationshipClaims.rewritten > 0 ||
        physicalOwnership.removed > 0 ||
        physicalOwnership.qualified > 0
      ) {
        return String(physicalOwnership.text || "").trim()
          ? physicalOwnership.text
          : "*확인된 사실만 다시 추려, 근거 없는 내용은 단정하지 않았다.*";
      }
      // The guards may remove unsupported local passages, but a false-positive
      // match must never erase an otherwise completed provider response. Keep
      // the single-call draft only when the combined filters would return no
      // visible text at all; partial redactions remain fully enforced.
      return String(physicalOwnership.text || "").trim()
        ? physicalOwnership.text
        : original;
    };
    // Transient presence belongs to the recent raw scene, not long memory or
    // residence canon. Strong entry/active-state evidence keeps a character in
    // the current scene until a recent exit or explicit scene cut removes them.
    let currentScenePresence = deriveCurrentScenePresence({
      messages: tail.map((message: any) => ({
        role: String(message?.role || ""),
        content: String(message?.content || ""),
      })),
      identities: legalStatusIdentities
        .filter((identity) => !identity.isPersona)
        .map((identity) => ({
          name: identity.name,
          aliases: identity.aliases || [],
        })),
      maxMessages: 14,
    });
    const currentSceneExclusions = deriveCurrentSceneExclusions({
      messages: [
        ...tail.map((message: any) => ({
          role: String(message?.role || ""),
          content: String(message?.content || ""),
        })),
        { role: "user", content: userText },
      ],
      identities: legalStatusIdentities
        .filter((identity) => !identity.isPersona)
        .map((identity) => ({
          name: identity.name,
          aliases: identity.aliases || [],
        })),
      maxMessages: 18,
    });
    const excludedSceneNames = new Set(
      currentSceneExclusions.flatMap((item) => [
        item.characterName.trim().toLocaleLowerCase("ko-KR"),
        ...(item.characterAliases || []).map((alias) =>
          alias.trim().toLocaleLowerCase("ko-KR")
        ),
      ])
    );
    currentScenePresence = currentScenePresence.filter(
      (item) =>
        ![
          item.characterName,
          ...(item.characterAliases || []),
        ].some((name) =>
          excludedSceneNames.has(name.trim().toLocaleLowerCase("ko-KR"))
        )
    );
    // 장기기억 전문은 저장/검색 가능 상태로 유지하되, 매 턴 전부 넣지는 않는다.
    // - 기존: 검색으로 최근 15턴(3200자) + 관련 과거 6섹션(2400자)만 주입 → 나머지 아카이브는 버려짐.
    //   키워드 substring 매칭이라 다른 표현으로 물으면 회수 실패, 검색 실패 시 폴백도 '최신 2섹션'이라
    //   초반 기억이 구조적으로 소환되지 않았다.
    // - 기본(auto): 현재 장면 + 검색된 관련 과거만 넣어 오래된 오기와 현재 대상을 섞지 않는다.
    // - 사용자가 전체 회고를 명시적으로 요청하면 그 턴에는 전문을 넣는다.
    // - 상한(AI_FULL_LONG_MEMORY_MAX_CHARS, 기본 64000자 ≈ 4만 토큰) 초과 시에만
    //   섹션 단위로 오래된 구간부터 탈락시킨다. (문장 중간 절단 방지)
    // - AI_FULL_LONG_MEMORY=1/0으로 전문/검색 모드를 명시 고정할 수 있다.
    const fullLongMemoryMode = String(process.env.AI_FULL_LONG_MEMORY ?? "auto").trim().toLowerCase();
    const broadHistoryRequested = /(?:처음부터|지금까지|전\s*과정|일대기|전체\s*(?:대화|기억|내용|요약)|모든\s*(?:일|기억|대화|사건)|전부)/u.test(
      userText
    );
    const fullLongMemoryEnabled =
      ["1", "true", "on"].includes(fullLongMemoryMode) ||
      (fullLongMemoryMode === "auto" && broadHistoryRequested);
    const fullLongMemoryMaxChars = (() => {
      const raw = Number(process.env.AI_FULL_LONG_MEMORY_MAX_CHARS ?? 64000);
      if (!Number.isFinite(raw) || raw <= 0) return 64000;
      return Math.max(4000, Math.floor(raw));
    })();
    const clampLongMemoryBySection = (text: string, maxChars: number) => {
      const s = String(text || "");
      if (s.length <= maxChars) return s;
      const sections = extractSummarySections(s);
      if (!sections.length) return s.slice(-maxChars);
      const kept: string[] = [];
      let used = 0;
      // 최신 섹션부터 채우고, 예산을 넘기면 더 오래된 구간은 제외한다.
      for (let i = sections.length - 1; i >= 0; i -= 1) {
        const section = sections[i];
        const range =
          section.startTurn === section.endTurn
            ? `${section.endTurn}턴`
            : `${section.startTurn}-${section.endTurn}턴`;
        const piece = `### ${section.title} (${range})\n${section.body}`.trim();
        if (used > 0 && used + piece.length + 2 > maxChars) break;
        kept.unshift(piece);
        used += piece.length + 2;
      }
      return kept.join("\n\n");
    };
    const fullLongMemoryText = fullLongMemoryEnabled
      ? clampLongMemoryBySection(String(historySummary || "").trim(), fullLongMemoryMaxChars)
      : "";
    const historySummaryForPromptRaw = (
      fullLongMemoryText
        ? [fullLongMemoryText, manualCharacterRosterFallback]
        : [hybridMemory.currentArcText, relatedArchiveText, manualCharacterRosterFallback]
    )
      .filter((x) => String(x || "").trim())
      .join("\n\n");
    const historyEpistemicView = sanitizeSharedEpistemicText(
      historySummaryForPromptRaw,
      epistemicFirewall
    );
    const historyAuthorityClaimView = sanitizeAuthorityClaims(
      historyEpistemicView.text
    );
    const historyLegalStatusView = removeUnsupportedLegalStatusClaims({
      text: historyAuthorityClaimView.text,
      trustedUserTexts: trustedLegalStatusUserTexts,
      trustedNarrationTexts: trustedLegalStatusNarrationTexts,
      identities: legalStatusIdentities,
    });
    const historyVitalStatusView = sanitizeVitalStatus(historyLegalStatusView.text);
    const historyRelationshipClaimView = sanitizeRelationshipClaims(
      historyVitalStatusView.text
    );
    const historyPhysicalOwnershipView = sanitizePhysicalOwnership(
      historyRelationshipClaimView.text
    );
    const historySummaryForPrompt = historyPhysicalOwnershipView.text;
    dbg({
      tag: "send.memory.blocks",
      chatId: cid,
      reqId,
      totalArchiveSections: hybridMemory.totalSections,
      currentRanges: hybridMemory.currentRanges,
      pickedBlocks: indexedRelatedMemory.blocks.length
        ? indexedRelatedMemory.blocks.map((block) => ({
            startTurn: block.startTurn,
            endTurn: block.endTurn,
            score: block.score,
            primaryMatches: block.primaryMatches,
            primaryScore: block.primaryScore,
            contextScore: block.contextScore,
            explicitMatch: block.explicitMatch,
            fallback: false,
            source: "fts-ledger",
          }))
        : hybridMemory.relatedRanges.map((range) => ({
            ...range,
            source: "summary-archive",
          })),
      indexedMemoryBlocks: indexedRelatedMemory.blocks.length,
      currentArcChars: strlen(hybridMemory.currentArcText),
      pickedChars: strlen(relatedArchiveText),
      continuityStates: continuityLedger.promptStates,
      continuityStateCount: continuityLedger.states.length,
      continuityPromptStateCount: continuityLedger.promptStates.length,
      continuityChars: strlen(continuityLedger.block),
      continuityIdentityCount: continuityLedgerIdentities.length,
      canonIdentityCount: continuityIdentities.length,
      dynamicCharacterContextChars: strlen(dynamicCharacterContext.block),
      authorityClaimContext,
      authorityClaimMemoryRedactions: historyAuthorityClaimView.removed,
      dynamicCharacterFocus: dynamicCharacterContext.focusedNames,
      dynamicRelationshipCount: dynamicCharacterContext.relationshipCount,
      dynamicEventCount: dynamicCharacterContext.eventCount,
      dynamicRecognition: dynamicCharacterContext.recognition.map((item) => ({
        name: item.characterName,
        firstTurn: item.firstInteractionTurn,
        lastTurn: item.lastInteractionTurn,
      })),
      currentScenePresence: currentScenePresence.map((item) => ({
        name: item.characterName,
        evidence: item.evidence,
      })),
      manualCharacterFallbackChars: strlen(manualCharacterRosterFallback),
      // (2026-08) 전체 주입 모드 진단
      fullLongMemory: fullLongMemoryEnabled,
      fullLongMemoryMode,
      broadHistoryRequested,
      fullLongMemoryChars: strlen(fullLongMemoryText),
      fullLongMemoryTruncated: fullLongMemoryEnabled
        ? strlen(String(historySummary || "").trim()) > strlen(fullLongMemoryText)
        : false,
      alwaysInjectRoster,
      identityCanonChars: strlen(identityCanonBlock),
      canonicalCharacterFactChars: strlen(canonicalCharacterFactsBlock),
      activeCharacterFocus: activeCharacterFocus.names,
      activeCharacterFocusReason: activeCharacterFocus.reason,
      spatialCanonChars: strlen(spatialCanon.block),
      spatialResidenceCount: spatialCanon.residences.length,
      spatialRelativeAnchorCount: spatialCanon.relativeAnchors.length,
      spatialTemporaryPlacementCount: spatialCanon.temporaryPlacements.length,
      spatialCurrentScene: spatialCanon.currentScene?.location || "",
      identityNameFacts: identityCanon.canon.nameFacts.length,
      identityRoleAnchors: identityCanon.canon.roleAnchors.length,
      inferredPersonaName: inferredPersonaName || "",
      epistemicProtectedFactCount: epistemicFirewall.facts.length,
      epistemicWorldOnlyFactCount: epistemicFirewall.worldOnlyRelationIds.size,
      epistemicSummaryRedactions: historyEpistemicView.redactedSegments,
      legalStatusSummaryRedactions: historyLegalStatusView.removed,
      physicalOwnershipSummaryQualified: historyPhysicalOwnershipView.qualified,
      physicalOwnershipSummaryRemoved: historyPhysicalOwnershipView.removed,
      relationshipClaimSummaryRemoved: historyRelationshipClaimView.removed,
      relationshipClaimSummaryRewritten: historyRelationshipClaimView.rewritten,
    });
    const memoryBlock = [
      fullLongMemoryText
        ? `# (2) 통합 장기기억(최근 원문 ${keepUserTurns}턴 + 전체 요약 아카이브)`
        : `# (2) 통합 장기기억(최근 원문 ${keepUserTurns}턴 + 최근 15턴 서사 + 관련 과거 사건)`,
      fullLongMemoryText
        ? `- 아래 요약 아카이브는 이 대화의 처음부터 최근까지 전 구간이다. 오래된 구간도 사실 확인에 그대로 사용한다.`
        : `- 최근 서사는 검색 실패와 무관하게 항상 유지한다.`,
      fullLongMemoryText
        ? `- 사용자가 과거 사건/인물/약속을 물으면 이 아카이브에서 근거를 찾아 답하고, 근거가 없으면 지어내지 말고 모른다고 처리한다.`
        : `- 과거 사건은 현재 입력과 관련된 구간만 복원하며, 검색 결과가 없으면 직전 과거 구간을 연속성 보호용으로 포함한다.`,
      `- 구간 정보가 충돌하면 턴 번호가 더 큰(더 최근) 구간을 우선한다.`,
      `- 인물 연속성 장부가 있으면 과거 캐릭터 기록과 최신 일반 장면 지시보다 우선한다.`,
      `- 별도의 인물 정체성·가족관계 정사 블록이 있으면 이 통합 장기기억보다 우선한다.`,
      `- 별도의 공간 정본 블록이 있으면 집·거주지·아랫집·윗집 판단은 그 블록을 우선한다.`,
      historySummaryForPrompt || "(없음)",
    ].join("\n");
    tEnd(tLongMemoryBlock);

    const relationshipConsistencyBlock = [
      `# (4) 관계/호칭 연속성(중요)`,
      `- 직전 대화와 장기기억에서 굳어진 관계/호칭/말투를 유지한다.`,
      `- 캐릭터별 관계와 호칭은 서로 독립이다. 한 캐릭터가 쓰는 호칭을 다른 캐릭터에게 복사하지 않는다.`,
      `- 호칭은 반드시 '말한 사람 → 들은 사람 → 호칭' 방향으로 해석한다. A가 B를 '선배님'이라고 부르면 B가 A를 '선배님'이라고 부르는 뜻이 아니다.`,
      `- 사용자가 '장인어른, 반말하세요'처럼 호칭 뒤에 직접 말을 이으면 사용자가 상대를 그 호칭으로 부른 것이다. 상대가 사용자를 그 호칭으로 부르게 뒤집지 않는다.`,
      `- 강요·농담·위장으로 사용한 가족 호칭은 실제 혈연·혼인 관계를 새로 만든 증거가 아니다.`,
      `- 장기기억이나 캐릭터 기록의 ## 이름 경계를 절대 넘지 않는다. 각 항목은 해당 이름의 인물에게만 적용한다.`,
      `- 같은 인물을 한 답변 안에서 서로 다른 호칭으로 섞지 않는다. (예: "오빠/선배/야" 혼용 금지)`,
      `- '아빠/엄마/딸/아들'은 반드시 누구의 가족인지 대상 인물과 세대를 함께 확인한다. 대상이 다른 가족 호칭을 같은 인물로 합치지 않는다.`,
      `- 대사 속 자칭·질문·추측이나 사진·편지의 발신 사실만으로 혈연과 정체성을 확정하지 않는다.`,
      `- 사용자가 "앞으로 ~라고 불러"처럼 명시적으로 바꾸기 전에는 호칭을 임의 변경하지 않는다.`,
      `- 사용자가 관계나 호칭을 부정·정정하면 그 최신 정정이 이전 어시스턴트 대사와 모든 기억보다 우선한다.`,
      `- 호칭이 불확실하면 새 호칭을 만들지 말고, 호칭 없이 자연스럽게 반응한다.`,
      `- 존댓말/반말 톤은 한 답변 안에서 흔들지 말고 일관되게 유지한다.`,
      buildRelationshipCorrectionGuidance(userText),
    ].filter(Boolean).join("\n");

    // NOTE: 출력길이 슬라이더(런타임)가 즉시 반영되도록 opts(maxOutputTokens)를 우선 사용한다.
    // (DB settings.maxOutputTokens는 '저장'된 값이고, 런타임 슬라이더는 body.runtime으로 넘어옴)
    const maxOut = Number(opts.maxOutputTokens ?? settings.maxOutputTokens ?? 1024);
    const modelName = String((opts as any)?.model || "");
    const isGemini3 = modelName.includes("gemini-3");
    const isGemini3Pro = isGemini3ProFamilyModel(modelName);

    
    // (2026-07) gemini-3-pro 계열도 기본은 실시간 델타 스트리밍.
    // 과거 DONE-ONLY 전환 사유였던 "본문 캡+메타 펜스 직전 문장 잘림"은 streamLoop의
    // 홀드백 버퍼(마지막 N자 보류 → 경계 보정 후 방출)로 해결했다.
    // 롤백: AI_G3PRO_DONE_ONLY=1 이면 기존 DONE-ONLY(버퍼링+done만 전송)로 복귀.
    const G3PRO_DONE_ONLY = Boolean(isGemini3Pro) && String(process.env.AI_G3PRO_DONE_ONLY || "0").trim() === "1";
// Gemini 3 Pro는 1-shot으로 한 번에 출력을 뱉는 경우가 많아서,
    // 이어쓰기(추가 generateText 호출)가 들어가면 대기 시간이 거의 2배가 된다.
    // → 이 모델에 한해 "추가 호출(이어쓰기/짧음 보정/메타 오버랩)"을 금지한다.
    const DISALLOW_G3PRO_CONTINUE = isGemini3Pro;

	    // gemini-3-pro 계열은 "모델 델타 스트리밍"이 불안정할 수 있다.
	    // 다만 transport 자체를 non-stream(JSON)로 강제하면 120s 프록시 타임아웃에 취약해진다.
	    // 따라서 stream=true로 들어오면 NDJSON(keep-alive ping + done-only)로 처리하고,
	    // stream=false면 기존처럼 JSON 응답으로 처리한다.


	    // 제작자/프리셋이 '상태창(메타/INFO)'을 요구하는지 감지한다.
	    // - formatGuide 자체에 STATUS/INFO 단어가 포함될 수 있으므로, preset/persona/note/userNote/lore 쪽만 본다.
	    // - 실제 제작 프리셋에선 ```INFO, "Info" 헤더, 📍/🕒 같은 표기가 쓰이기도 해서 함께 탐지한다.
	    const _statusNeedHaystack = [presetBlock, personaBlock, noteBlock, relationshipConsistencyBlock, String(settings.userNote || ""), loreBlock].filter(Boolean).join("\n");
    // (정확 플래그) '제작자 상태창 요구: YES' 같은 명시 플래그는 무조건 STATUS를 강제한다.
    const authorWantsStatusExplicit =
      /제작자\s*상태\s*창\s*요구\s*:\s*YES/i.test(_statusNeedHaystack) ||
      /producer\s*status\s*panel\s*:\s*YES/i.test(_statusNeedHaystack);

    const hasStatusTemplateFence = (() => {
      const m = _statusNeedHaystack.match(/(?:^|\n)[ \t]*```\s*([^\s`\n]{0,32})[^\n]*\n([\s\S]{0,600})/i);
      if (!m) return false;
      const head = String(m[2] || "");
      return /[📆🌐📜⏲️]/.test(head) || /상황\s*요약|장소|시간|위치/i.test(head);
    })();

    const statusTemplateClosedFenceLenGuess = (() => {
      // Estimate how much room the trailing meta/status fenced block may need.
      // - label-agnostic: any fenced block label is allowed
      // - NO server-made templates: only uses what exists in the author prompt
      try {
        const hay = _statusNeedHaystack.slice(-12000);
        const bad = new Set([
          "TEXT",
          "MD",
          "MARKDOWN",
          "JSON",
          "YAML",
          "TOML",
          "XML",
          "HTML",
          "CSS",
          "SQL",
          "JS",
          "JAVASCRIPT",
          "TS",
          "TYPESCRIPT",
          "PY",
          "PYTHON",
          "BASH",
          "SH",
          "SHELL",
          "LOG",
          "INI",
          "CONF",
        ]);
        const re = /(?:^|\n)[ \t]*```[ \t]*([^\s`\n]{0,32})[^\n]*\n([\s\S]*?)\n[ \t]*```/g;
        let last: string | null = null;
        for (const m of hay.matchAll(re)) {
          const labelRaw = String(m[1] || "").trim();
          const labelU = labelRaw.toUpperCase();
          if (labelU && bad.has(labelU)) continue;
          last = String(m[0] || "").replace(/^\n/, "");
        }
        if (!last) return 0;
        const trimmed = last.length > 2600 ? last.slice(0, 2600) : last;
        return strlen(trimmed);
      } catch {
        return 0;
      }
    })();

const statusTemplateOpenFenceLenGuess = (() => {
  // Some creator presets keep an *open* fenced template (```LABEL ... without a closing fence).
  // In that case, statusTemplateClosedFenceLenGuess becomes 0, and the server reserves too little tail budget,
  // causing the meta/status panel to be clipped mid-line.
  // → Estimate the open template length (best-effort) to reserve enough tail room.
  try {
    const hay = _statusNeedHaystack.slice(-12000);
    const bad = new Set([
      "TEXT",
      "MD",
      "MARKDOWN",
      "JSON",
      "YAML",
      "TOML",
      "XML",
      "HTML",
      "CSS",
      "SQL",
      "JS",
      "JAVASCRIPT",
      "TS",
      "TYPESCRIPT",
      "PY",
      "PYTHON",
      "BASH",
      "SH",
      "SHELL",
      "LOG",
      "INI",
      "CONF",
    ]);
    const reOpen = /(?:^|\n)[ \t]*```[ \t]*([^\s`\n]{0,32})[^\n]*\n/g;
    let lastStart = -1;
    let lastMatch = "";
    for (const m of hay.matchAll(reOpen)) {
      const labelRaw = String(m[1] || "").trim();
      const labelU = labelRaw.toUpperCase();
      if (labelU && bad.has(labelU)) continue;
      const mi = (m as any).index as number;
      if (typeof mi === "number") {
        lastStart = mi;
        lastMatch = String(m[0] || "");
      }
    }
    if (lastStart < 0) return 0;

    // Start from the opening fence line (drop the leading newline if the regex captured it).
    const start = lastStart + (lastMatch.startsWith("\n") ? 1 : 0);
    const s = hay.slice(start);
    const maxScan = 2600;
    let seg = s.slice(0, maxScan);

    // If we can find a second fence line, stop there (treat as the end of the template region).
    // (Even if it's not an actual closing fence, it's safer than over-counting unrelated prompt text.)
    const secondFence = seg.search(/\n[ \t]*```[ \t]*(?:\n|$)/);
    if (secondFence > 0) {
      seg = seg.slice(0, secondFence + 1);
    } else {
      // Common wrapper: "( ... )" in creator prompt.
      const paren = seg.search(/\n\)[ \t]*\n/);
      if (paren > 0) seg = seg.slice(0, paren + 2);
    }

    return strlen(seg);
  } catch {
    return 0;
  }
})();


    const authorWantsStatus =
      authorWantsStatusExplicit ||
      /상태\s*창|캐릭터\s*상태|\[\s*시간\s*\/\s*장소\s*\]|```\s*(?:STATUS|INFO)\b|Info\s*\n\s*📍|📍\s*위치|🕒\s*시간|위치\s*\|\s*시간|#\s*상태\s*창\s*=|항상\s*응답\s*끝.*상태\s*창/i.test(
        _statusNeedHaystack
      ) ||
      hasStatusTemplateFence;

    // (요구사항)
    // 슬라이더 체감 길이(글자수)를 기준으로 char/token 예산을 계산한다.
    // 계산식은 _server/charBudget.ts 의 computeSendOutputBudget()로 분리했다.
    const HARD_CAP_CHARS = 200000; // absolute safety cap to prevent runaway DB growth
    const NO_TRUNCATE_OUTPUT = true; // 원칙: 서버 절단 금지(슬라이더는 '권장' 길이)
    const {
      targetChars,
      bodyBudgetChars,
      promptMinChars,
      tailBudgetChars,
      promptMaxChars,
      minChars,
      maxChars,
      maxOutputTokensForCall,
    } = computeSendOutputBudget({
      maxOut,
      isGemini3,
      modelForBudget: String((opts as any)?.model || (settings as any)?.model || ""),
      g3ProDoneOnly: G3PRO_DONE_ONLY,
      authorWantsStatus,
      statusTemplateClosedFenceLenGuess,
      statusTemplateOpenFenceLenGuess,
      noTruncateOutput: NO_TRUNCATE_OUTPUT,
    });

    // "중간 끊김"이 계속 발생해서, 형식을 단순화하고(LLM이 놓치기 쉬운 규칙 제거)
    // 반드시 짧게라도 완결되도록 강제한다.

	    // 모델이 '상태창 요구'를 추측으로 오판하는 케이스가 있어, 명시적으로 YES/NO를 박아준다.
    let statusRequired = authorWantsStatus ? "YES" : "NO";

	    // Creator/preset may define the meta fence label (INFO/STATUS/other). We must not hardcode STATUS.
	    // We derive candidates from the prompt blocks and use them both:
	    // - as a hint in the prompt (formatGuide)
	    // - as allowed meta labels when preserving meta outside the body budget
	    // NOTE: _statusNeedHaystack is already defined earlier (authorWantsStatus detection).
	    // Use a distinct variable name here to avoid duplicate definitions.
	    const _metaFenceHaystack = [
	      // creator/preset/persona/note/memory/lore blocks (prompt-defined)
	      presetBlock,
	      personaBlock,
	      noteBlock,
	      memoryBlock,
	      loreBlock,
	    ]
	      .filter(Boolean)
	      .join("\n\n");


						const metaFenceTemplatePick = (() => {
    try {
      // NOTE: We scan a reasonably large tail window so we can still detect the author's
      // meta/status template even when preset/systemPrompt is very long.
      // (Previously we only scanned the last 9k chars; if the template was near the top,
      // meta detection silently failed and the UI fell back to "미상".)
      const HAY_TAIL = 24000;
      const hay = _metaFenceHaystack.length > HAY_TAIL ? _metaFenceHaystack.slice(-HAY_TAIL) : _metaFenceHaystack;

      // Closed fence blocks only, anchored at line-start to avoid picking up inline "```" examples.
      const reClosedAny =
        /(?:^|\n)[ \t]*```[ \t]*([^\s`\n]{0,32})[^\n]*\n([\s\S]*?)\n[ \t]*```/g;

      const badLabels = new Set([
        "JSON",
        "YAML",
        "XML",
        "HTML",
        "CSS",
        "JS",
        "JAVASCRIPT",
        "TS",
        "TYPESCRIPT",
        "PY",
        "PYTHON",
        "SQL",
        "BASH",
        "SH",
        "ZSH",
        "POWERSHELL",
        "PS1",
        "MD",
        "MARKDOWN",
        "TEXT",
      ]);

      let best: { labelRaw: string; labelUpper: string; block: string; score: number; idx: number } | null =
        null;

      for (const m of hay.matchAll(reClosedAny)) {
        const idx = typeof m.index === "number" ? m.index : 0;
        const full = String(m[0] || "").replace(/^\n/, "");
        const labelRaw = String(m[1] || "").trim();
        const labelUpper = labelRaw.toUpperCase();
        const body = String(m[2] || "");

        if (labelUpper && badLabels.has(labelUpper)) continue;
        if (body.trim().length < 8) continue;

        const pre = hay.slice(Math.max(0, idx - 260), idx);
        let score = 0;

        // Prefer blocks that look like a status window template.
        if (/#\s*상태창/i.test(pre) || /상태창/i.test(pre)) score += 80;
        // Strong label preference: if the author provided an explicit ```STATUS template,
        // pick it over other fenced blocks (e.g. STREAM snippets, random examples, etc.).
        // This directly fixes the "첫번째처럼 다른 템플릿" 현상.
        if (labelUpper === "STATUS") score += 140;
        else if (labelUpper === "INFO") score += 90;
        else if (labelUpper === "STREAM") score += 20;
        if (/[📆⏲️🌐🎒📜🎭🪙🔻▶️]/.test(body)) score += 20;
        if (/\[[^\]]+\]/.test(body)) score += 6; // bracket-y UI rows
        if (/체력|마나|스탯|레벨|LV\b/i.test(body)) score += 12;
        if (labelUpper) score += 2;

        // Prefer the most recent relevant block.
        score += Math.min(10, Math.floor(idx / 1200));

        if (!best || score > best.score || (score === best.score && idx > best.idx)) {
          best = { labelRaw, labelUpper, block: full.trim(), score, idx };
        }
      }

      return best ? { labelRaw: best.labelRaw, labelUpper: best.labelUpper, block: best.block } : null;
    } catch {
      return null;
    }
  })();;

					const metaLabelHintRaw = String(metaFenceTemplatePick?.labelRaw || "").trim();
					// Use a normalized hint so we don't accidentally include ":\\n"-style suffixes.
					const metaLabelHint = normalizeFenceLabelToken(metaLabelHintRaw);

  // Meta/Status fence label allowlist (derived from creator template; do NOT hardcode)
  // - Include both the raw label and its normalized "core" variant.
  //   (Fixes: creator writes ```커스텀등햔:\n but model outputs ```커스텀등햔)
  const allowedMetaLabels: string[] = [];
  for (const cand of fenceLabelCandidates(metaLabelHintRaw)) {
    const up = String(cand || "").trim();
    if (!up) continue;
    const core = normalizeFenceLabelToken(up);
    if (core) allowedMetaLabels.push(core.toUpperCase());
    allowedMetaLabels.push(up.toUpperCase());
  }
  if (metaLabelHint) allowedMetaLabels.push(metaLabelHint.toUpperCase());
  // Always allow common meta labels as a safety net.
  // (Some presets keep an *open* ```STATUS template without a closing fence, so metaLabelHint may come from elsewhere.)
  if (!allowedMetaLabels.includes("STATUS")) allowedMetaLabels.push("STATUS");
  if (!allowedMetaLabels.includes("INFO")) allowedMetaLabels.push("INFO");
const previousStatusPanelSnapshot = buildPreviousStatusPanelSnapshot(all, 20);
const _compactMetaFenceTemplateHint = (raw: string) => {
	const s = String(raw || "").trim();
	if (!s) return "";
	// Only accept a *closed* fenced template from the creator prompt. (No server-synthesized template)
	const m = s.match(/^```[ \t]*([^\s` ]{1,32})[^\n]*\n([\s\S]*?)\n```/);
	if (!m) return "";
	const label0 = String(m[1] || "").trim();
	const label = normalizeFenceLabelToken(label0) || label0;
	if (!label) return "";
	const body = String(m[2] || "");
	const out: string[] = [];
	let total = 0;
	for (const line of body.split("\n")) {
		out.push(line);
		total += line.length + 1;
		if (total >= 520) break;
		if (out.length >= 18) break;
	}
	const compactBody = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
	const final = (`\`\`\`${label}\n${compactBody}\n\`\`\``).trim();
	return final.length <= 800 ? final : final.slice(0, 800).trimEnd();
};

const metaFenceTemplateHintRaw = String(metaFenceTemplatePick?.block || "").trim();
					const metaFenceTemplateHint = _compactMetaFenceTemplateHint(metaFenceTemplateHintRaw);
					const authorWantsMetaPanel = Boolean(metaFenceTemplateHint);
// If the author wants a status window, reserve meta tail budget even when no closed template was found.
// This prevents the server from hard-capping a model-generated ```STATUS fence to ~80 chars.
const metaRequired = (authorWantsMetaPanel || authorWantsStatus) ? "YES" : "NO";

// statusRequired: explicit author desire wins; otherwise follow metaRequired (for INFO-style meta panels).
statusRequired = (authorWantsStatus || metaRequired === "YES") ? "YES" : "NO";


  // (One-shot meta) The user-facing slider is "body chars" (e.g. 1200/1500/1800),
  // and we allow an extra tail budget (typically +300 chars) to print the meta fence.
  // IMPORTANT: The extra budget is reserved for the fence portion — the body should NOT consume it.
  const META_TAIL_BUDGET_DEFAULT = tailBudgetChars; // reserved tail budget for final fenced meta/status
  // NOTE:
  // - If env is unset/invalid/<=0, fall back to computed default (tailBudgetChars).
  // - Even if env is set very small (or 0), we keep a minimum tail room when the creator prompt includes a meta fence template.
  const META_TAIL_BUDGET_CHARS = (() => {
    // Back-compat: old env name CHAT_META_INLINE_RESERVE_CHARS
    const raw = process.env.CHAT_META_TAIL_BUDGET_CHARS ?? process.env.CHAT_META_INLINE_RESERVE_CHARS;
    const v = raw == null ? NaN : Number(raw);
    const base = META_TAIL_BUDGET_DEFAULT;
    if (!Number.isFinite(v) || v <= 0) return base;
    // Clamp so we never exceed the available tail room.
    const clamped = Math.max(0, Math.min(base, Math.floor(v)));
    // If meta is required, never allow this to collapse to "0 chars".
    return metaRequired === "YES" ? Math.max(240, clamped) : clamped;
  })();

  const metaMaxChars = metaRequired === "YES" ? META_TAIL_BUDGET_CHARS : 0;
  const bodyMaxChars = Math.max(64, Math.floor(bodyBudgetChars));

  const promptMinForGuide = (() => {
    // When meta is required, force the *total* output to be longer than bodyMax so the model has to emit the meta fence.
    // (If we let min == bodyMax, gemini-3-pro often stops around targetChars and drops the meta entirely.)
    if (metaRequired !== "YES" || metaMaxChars <= 0) {
      return Math.min(promptMinChars, promptMaxChars);
    }
    const minMeta = Math.max(80, Math.min(metaMaxChars, Math.floor(metaMaxChars * 0.65)));
    const totalMin = bodyMaxChars + minMeta;
    // Keep min < max to avoid self-contradiction.
    return Math.max(200, Math.min(promptMaxChars - 8, totalMin));
  })();

					
												// Debug: meta-tail budgets (dev visibility)
												try {
												  console.log(
												    JSON.stringify({
												      tag: 'send.meta.detect',
												      reqId,
												      model: String((opts as any)?.model || ""),
												      authorWantsMetaPanel,
												      metaRequired,
												      statusRequired,
												      targetChars,
												      promptMaxChars,
												      promptMinChars_base: promptMinChars,
												      promptMinChars_guide: promptMinForGuide,
												      bodyMaxChars,
												      metaMaxChars,
												      metaLabelHint,
								      metaTemplateSource: metaFenceTemplateHintRaw ? 'author-template' : 'none',
												      metaTailBudgetChars: META_TAIL_BUDGET_CHARS,
												    })
												  );
												} catch {
												  // ignore
												}
const formatGuide = buildFormatGuide({
          statusRequired,
          targetChars,
						promptMinChars: promptMinForGuide,
          promptMaxChars,
          bodyMaxChars,
          metaMaxChars,
          metaLabelHint,
          metaRequired,
          metaTemplateFence: metaFenceTemplateHint ? metaFenceTemplateHint : undefined,
        });
const recentExpressionAvoidanceBlock = buildRecentExpressionAvoidanceBlock(tail);

const worldDirectorBlock = currentOocInstruction || hasCurrentUserNarration
  ? ""
  : buildWorldDirectorBlock({
      messages: tail,
      currentUserText: userText,
      authorConstraintText: [presetBlock, noteBlock].join("\n"),
      registeredNames: continuityIdentities.map((identity) => String(identity?.name || "")),
      chatId: cid,
      userTurnCount,
      focusedConversation: activeCharacterFocus.locked,
    });

// (2026-07) 캐시 친화 배치: Vertex implicit cache는 "앞에서부터 바이트 동일한 프리픽스"만
// 적중하므로, 고정 블록(작품설정/페르소나/유저노트/관계규칙)을 앞에, 매턴 변동 블록
// (로어=키워드 매칭, 장기기억=FTS 검색+N턴 요약)을 뒤에 배치한다. (블록 내용은 동일, 순서만 변경)
// - 카드/프로필/작품설정을 수정하면 바이트가 달라져 자동으로 캐시 미스→재캐싱된다(퍼지 불필요).
// - formatGuide는 형식(상태창 펜스) 준수율을 위해 기존처럼 맨 뒤 유지.
// - 롤백: AI_CACHE_FRIENDLY_PROMPT=0 → 기존 순서(장기기억이 중간).
const cacheFriendlyLayout = String(process.env.AI_CACHE_FRIENDLY_PROMPT || "1").trim() !== "0";
const systemRaw = (cacheFriendlyLayout
    ? [
        `너는 아래 설정을 따르며, 현재 장면의 상대방 캐릭터들과 NPC들을 각각 독립된 인물로 반응시킨다.`,
        ``,
        sanitizePromptCached(presetBlock),
        ``,
        sanitizePromptCached(personaBlock),
        ``,
        sanitizePromptCached(noteBlock),
        ``,
        sanitizePromptCached(relationshipConsistencyBlock),
        ``,
        sanitizePromptCached(loreBlock),
        ``,
        sanitizePromptCached(memoryBlock),
        ``,
        dynamicCharacterContext.block
          ? sanitizePromptCached(dynamicCharacterContext.block)
          : "",
        dynamicCharacterContext.block ? `` : "",
        sanitizePromptCached(formatGuide),
        recentExpressionAvoidanceBlock ? `` : "",
        recentExpressionAvoidanceBlock ? sanitizePromptCached(recentExpressionAvoidanceBlock) : "",
        worldDirectorBlock ? `` : "",
        worldDirectorBlock ? sanitizePromptCached(worldDirectorBlock) : "",
      ]
    : [
        `너는 아래 설정을 따르며, 현재 장면의 상대방 캐릭터들과 NPC들을 각각 독립된 인물로 반응시킨다.`,
        ``,
        sanitizePromptCached(presetBlock),
        ``,
        sanitizePromptCached(personaBlock),
        ``,
        sanitizePromptCached(noteBlock),
        ``,
        sanitizePromptCached(memoryBlock),
        ``,
        sanitizePromptCached(relationshipConsistencyBlock),
        ``,
        sanitizePromptCached(loreBlock),
        ``,
        dynamicCharacterContext.block
          ? sanitizePromptCached(dynamicCharacterContext.block)
          : "",
        dynamicCharacterContext.block ? `` : "",
        sanitizePromptCached(formatGuide),
        recentExpressionAvoidanceBlock ? `` : "",
        recentExpressionAvoidanceBlock ? sanitizePromptCached(recentExpressionAvoidanceBlock) : "",
        worldDirectorBlock ? `` : "",
        worldDirectorBlock ? sanitizePromptCached(worldDirectorBlock) : "",
      ]).join("\n");
    const npcName = preset.characterName || (preset as any).name || "상대";
    const systemBase = applyPromptPlaceholders(systemRaw, { charName: npcName, userName: personaNameFinal || "" });
    const systemWithIdentityCanon = [
      systemBase,
      identityCanonBlock ? sanitizePromptCached(identityCanonBlock) : "",
      canonicalCharacterFactsBlock
        ? sanitizePromptCached(canonicalCharacterFactsBlock)
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const currentNarrationPriorityBlock = hasCurrentUserNarration
      ? [
          `# [CURRENT USER NARRATION — COMPLETED SCENE FACT]`,
          `- 최신 사용자 입력의 *...* 구간은 현재 턴에 이미 일어난 관찰 가능한 사건·행동·장면 변화다.`,
          `- 이를 시도, 상상, 오해, 실패, 취소된 행동으로 바꾸거나 NPC가 선제적으로 막았다고 재작성하지 않는다.`,
          `- 완료된 행동 자체는 존중하되, 그 행동만으로 진행 중인 감시·경호·추적·구금·입원·담당 상태가 자동 해제되지는 않는다. 연속성 장부에 남은 담당자의 관찰·발각·후속 반응을 함께 반영한다.`,
          `- 사용자 지문을 반복하지 말고 그 직후의 NPC 반응과 실제 결과부터 이어간다.`,
          `- 지문 밖의 일반 문장은 주인공 대사다. 지문만으로 고정된 이름·혈연·과거 정사를 바꾸지 않으며, 그런 변경은 OOC/설정/정정 표식을 따른다.`,
        ].join("\n")
      : "";
    const currentOocPriorityBlock = currentOocInstruction
      ? [
          `# [CURRENT OOC OVERRIDE — ABSOLUTE HIGHEST STORY PRIORITY]`,
          `- 아래 OOC 원문은 현재 턴의 사용자 메타 지시다. 캐릭터 대사로 해석하지 않는다.`,
          `- 작품 설정, 프리셋, 최근 대화, 장기기억, 관계·감정, 기존 전개와 충돌하면 아래 OOC를 최우선으로 적용한다.`,
          `- 충돌하는 기존 정보는 이번 응답에서 무시하고, OOC가 적용된 결과부터 메타 설명 없이 바로 출력한다.`,
          ``,
          currentOocInstruction,
        ].join("\n")
      : "";
    // 현재 턴 전용 규칙은 고정 프롬프트 뒤에 둔다. 같은 system role 안에서도
    // 최신 지문/OOC가 오래된 작품·기억 규칙에 묻히지 않게 한다.
    const continuityPriorityBlock = continuityLedger.block
      ? sanitizePromptCached(continuityLedger.block)
      : "";
    // Recognition facts need a short, human-readable guard near the end of the
    // system prompt. The full dynamic JSON intentionally sits at the cacheable
    // prefix, but long prompts can cause the model to overlook a rule buried at
    // the beginning and make established characters react as if meeting the
    // persona for the first time.
    const recognitionPriorityBlock = dynamicCharacterContext.recognition.length
      ? [
          `# [CHARACTER RECOGNITION HARD GUARD — RESPONSE VALIDATION]`,
          `- 아래 인물들은 페르소나 ${personaNameFinal || "주인공"}와 이미 직접 만났고 서로를 알고 있다. 최신 입력에 기억상실·변장·인식 불가가 명시되지 않는 한 초면으로 되돌리지 않는다.`,
          ...dynamicCharacterContext.recognition.map((item) => {
            const range =
              item.firstInteractionTurn === item.lastInteractionTurn
                ? `${item.lastInteractionTurn}턴`
                : `${item.firstInteractionTurn}-${item.lastInteractionTurn}턴`;
            return `- ${item.characterName} ↔ ${personaNameFinal || "주인공"}: 기존 대면 이력 ${range}. ${item.evidence}`;
          }),
          `- 응답에서 위 인물이 페르소나에게 '누구냐', '처음 본다', '낯선 사람'처럼 반응하려 하면 그 문장을 출력하지 말고, 저장된 관계·감정·과거 사건을 알아보는 반응으로 다시 쓴다.`,
          `- 두 사람의 실명이 같은 문장에 없어도 동일 규칙을 적용한다. '노인', '학생', 직업·관계 호칭, 별칭, 대명사로 표현된 인물을 앞뒤 지문과 연결해 같은 인물로 인식한다.`,
          `- 페르소나의 범행·비밀·의도를 모르는 상태는 유지할 수 있지만, 그 사실을 모른다는 이유로 이미 만난 페르소나 자체를 초면으로 처리하지 않는다.`,
        ].join("\n")
      : "";
    const scenePresencePriorityBlock = [
      `# [CURRENT SCENE MEMBERSHIP HARD GUARD — APPLIES TO EVERY CHAT]`,
      `- 최신 사용자 원문이 정한 현재 장면의 인물 구성과 위치는 최상위 정사다. 사용자가 직접 지시하지 않은 퇴장, 실종, 도주, 자기 방으로 이동, 재입장, 인물 교체를 새로 만들지 않는다.`,
      `- 사용자가 둘이/서로/얘들/다 같이처럼 현재 인물을 가리키면 직전 장면에 실제 남아 있는 인물을 그대로 이어 쓴다. 현장 밖 인물을 대신 끼워 넣지 않는다.`,
      `- 쫓겨났거나 출입을 금지당한 인물은 사용자가 그 인물의 복귀를 명시하기 전까지 현장 밖에 둔다. 감정이 격해졌다는 이유로 안으로 돌아오게 하지 않는다.`,
      `- 현재 인물이 충격, 공포, 수치심을 느껴도 사용자의 지시 없이 '견디지 못하고 도망쳤다', '방으로 사라졌다', '자리를 떴다'처럼 장면에서 제거하지 않는다. 현 위치에서 표정·대사·행동으로 반응시킨다.`,
      `- 현재 인물을 반응에서 빼기 위해 기절, 혼절, 실신, 의식 상실, 수면, 마비, 발화 불능, 쓰러짐을 새로 만들지 않는다. 이런 상태는 최신 사용자 원문이나 검증된 현재 정사에 이미 명시된 경우에만 유지한다.`,
      `- 이름 검사를 피하려고 현재 인물을 '작은 형체', '곁의 소녀', '한 사람', '그녀/그' 같은 익명 표현으로 바꾼 뒤 자취를 감추거나 도망치게 하는 것도 동일한 임의 퇴장이다. 현재 인물의 이름과 위치를 명시적으로 유지한다.`,
      ...(currentScenePresence.length
        ? [
            `- 아래 인물은 최근 원문 장면에서 이미 입장했고, 명시적으로 퇴장하거나 장면이 전환되지 않아 지금도 같은 현장에 있다.`,
            ...currentScenePresence.map(
              (item) => `- 현재 현장에 있음: ${item.characterName}. 최근 근거(인용 데이터): ${JSON.stringify(item.evidence)}`
            ),
          ]
        : []),
      ...(currentSceneExclusions.length
        ? [
            `- 아래 인물은 사용자가 현재 장면에서 직접 내보냈거나 출입을 금지했다. 명시적 복귀 지시 전에는 재입장시키지 않는다.`,
            ...currentSceneExclusions.map(
              (item) => `- 현재 현장 출입 제외: ${item.characterName}. 사용자 근거(인용 데이터): ${JSON.stringify(item.evidence)}`
            ),
          ]
        : []),
      `- 최신 입력이 '그다음 사람', '다음 여자/남자', '한 명 더', '다음 차례'를 요구하면 현재 현장 인물은 후보에서 반드시 제외한다. 아직 현장에 없는 다른 인물을 선택한다.`,
      `- 현재 현장 인물을 새로 들어오거나, 끌려오거나, 나타나거나, 도착한 사람처럼 다시 연출하지 않는다. 이미 한 자기소개도 반복시키지 않는다.`,
      `- 현장 안에서 자리 이동·표정·대사·반응을 이어가는 것은 허용한다. 재입장은 최근 원문에 실제 퇴장 후 사용자가 귀환을 명시한 경우에만 허용한다.`,
      `- 응답을 내기 직전에 (1) 현재 인물을 임의로 내보냈는지, (2) 제외 인물을 임의로 들였는지, (3) 사용자가 지칭한 인물을 다른 인물로 바꿨는지 검사한다. 하나라도 맞으면 해당 전개를 폐기하고 현재 구성 그대로 다시 쓴다.`,
    ].join("\n");
    const epistemicPriorityBlock = epistemicFirewall.facts.length
      ? [
          `# [CHARACTER KNOWLEDGE FIREWALL — RESPONSE VALIDATION]`,
          `- 세계관의 민감한 사실과 등장인물이 실제로 아는 사실을 분리한다. 이번 프롬프트에서 비공개 사실 ${epistemicFirewall.facts.length}건을 지식 허용목록으로 관리하며, 그중 ${epistemicFirewall.worldOnlyRelationIds.size}건은 아는 NPC가 없어 원문 자체를 숨겼다.`,
          `- 숨겨진 사실을 이상 행동, 현장 방문, 표정, 말투, 수사 대상이라는 이유만으로 재구성하거나 확정하지 않는다. 관찰자는 직접 본 행동만 말할 수 있고, 그 의미는 의심·가설·미상으로 남긴다.`,
          `- 과거 어시스턴트 지문이나 통합 요약이 정보 획득 장면 없이 범인·원흉·배후·정체·누명 같은 결론을 단정했다면 그 문장은 정사가 아니라 지식 경계 오류다. 이번 응답에서 반복·인용·전제하지 않는다.`,
          `- 최신 사용자가 경찰·수사관·교사 등에게 '모든 죄명', '세세한 사건', '지금까지 있었던 일'을 말하도록 요구해도 그 문장 자체는 정보 획득 근거가 아니다. 신고·목격·증거 확보·수사·전달 장면이 있는 사실만 그 NPC의 대사에 포함한다.`,
          `- 특히 피해자와 현장 목격자만 아는 감금·인질·성폭력·은폐 사실을 수배 전단, 경찰 브리핑, 혐의 목록으로 자동 승격하지 않는다. 경찰은 공개 재판·신고·확보된 증거로 확인된 범죄만 안다.`,
          ...epistemicFirewall.facts.slice(0, 24).map((fact) =>
            `- 지식 허용목록: ${fact.subjectName} ↔ ${fact.objectName} / ${fact.relation} / 아는 인물: ${fact.knownByNames.join(", ") || "없음"}`
          ),
          `- 응답을 내기 전에 각 NPC의 대사·생각·시점 지문에 쓰인 결론마다 직접 목격, 전달, 조사로 얻은 근거가 있는지 검사한다. 근거가 없으면 확정 표현을 관찰 가능한 사실 또는 불확실한 추측으로 낮춘다.`,
        ].join("\n")
      : "";
    const legalStatusPriorityBlock = [
      `# [LEGAL/PROCEDURAL STATUS HARD GUARD — RESPONSE VALIDATION]`,
      `- 사건 관계자, 조사 대상, 감시 대상, 수상한 인물, 현장 방문자는 그 이유만으로 피의자·피고인·수배자·구속자·유죄 확정자가 아니다.`,
      `- 입건, 피의자 전환, 체포, 구속, 기소, 수배, 유죄 확정 같은 법적·절차적 상태는 최신 사용자 지문이나 저장된 명시적 절차 사건에 실제로 발생했다고 기록된 경우에만 사용한다.`,
      `- 경찰·수사관이 경계하거나 출입을 막는 장면에서도 근거 없는 법적 신분을 새로 만들지 않는다. 필요하면 '사건 관계자', '방문자', '신원 확인 대상'처럼 관찰 가능한 중립 표현을 쓴다.`,
      `- 이번 응답에서 법적 지위를 한 단계라도 올리기 전, 누가 언제 어떤 절차를 집행했는지 근거 문장을 확인한다. 근거가 없으면 승격하지 않는다.`,
    ].join("\n");
    const authorityClaimPriorityBlock = [
      `# [OFFICIAL CLAIM GROUNDING HARD GUARD — APPLIES TO EVERY CHAT]`,
      `- 경찰·형사·수사관·검사·의사·기자·공무원의 설명, 기록, 브리핑은 기존 AI 서술을 조합해 새로운 과거사를 만드는 장면이 아니다. 사용자가 직접 확정한 사실과 실제 신고·목격·증거 확보·절차 기록만 말한다.`,
      `- 사용자가 '전부 말해', '모든 죄명', '자세히 설명해'라고 요구한 것은 설명 범위 지시일 뿐, 새 범죄·피해자·전과가 존재한다는 근거가 아니다. 확인된 항목이 적으면 그 항목만 말하고 빈칸을 창작으로 채우지 않는다.`,
      `- 사용자 원문에 없는 피해자 수, 기간, 반복·상습 패턴, 범행 수법, 의학적 후유증, 법적 죄명, 수배·기소·유죄 상태를 추론하거나 단정하지 않는다. 서로 다른 피해자·사건의 기억을 한 사람의 반복 범행 이력으로 합치지 않는다.`,
      `- 이전 AI 응답에만 있고 사용자가 확인하지 않은 고위험 사실은 정사가 아니라 미검증 초안이다. 공식 인물의 대사, 수사 기록, 요약, 회상에서 반복하지 않는다.`,
    ].join("\n");
    const vitalStatusPriorityBlock = [
      `# [LIFE/DEATH CANON HARD GUARD — APPLIES TO EVERY CHAT]`,
      `- 죽음·사망·자살·살해는 인물의 등장 가능성을 영구 변경하는 최상위 정사다. 최신 사용자 지문이나 이미 검증된 연속성 장부에 실제 완료 사건으로 확정된 경우에만 발생한 사실로 쓴다.`,
      `- '죽을지도 모른다', '자살할 수 있다', '죽이면', '죽이겠다', '아빠 없는 게 싫지?' 같은 가정·가능성·협박·조건문·공포·회상은 실제 사망이 아니다. 절대로 '죽었다', '목숨을 잃었다', '죽음 이후'로 승격하거나 요약하지 않는다.`,
      `- 최근 원문에서 그 인물이 말하거나 행동하거나 다른 방에 살아 있는 장면이 확인되면 생존 상태다. 충돌하는 과거 AI 지문이나 요약의 사망 단정은 오기이므로 반복하지 않는다.`,
      `- 응답을 내기 직전에 새 사망 주장마다 누가, 언제, 어떤 완료 사건으로 죽었는지 근거를 확인한다. 명시적 근거가 없으면 그 문장을 삭제하고 생존한 현재 상황을 유지한다.`,
    ].join("\n");
    const activeInterlocutorPriorityBlock = activeCharacterFocus.locked
      ? [
          `# [CURRENT INTERLOCUTOR HARD GUARD — APPLIES TO EVERY CHAT]`,
          `- 최신 사용자 입력의 직접 대상은 ${activeCharacterFocus.names.join(", ")}이다. 이 판정은 최신 사용자 발화와 그 이전 사용자 호명만으로 정했으며, 과거 어시스턴트 서술보다 우선한다.`,
          `- 최신 입력의 '너/넌/널/네가/너한테' 같은 2인칭은 위 인물을 가리킨다. 다른 등록 인물로 바꾸지 않는다.`,
          `- 다른 인물이 장면에 함께 있거나 반응할 수는 있지만, 위 인물의 나이·직업·관계·기억·행동을 다른 인물에게 옮기거나 서로 합치지 않는다.`,
          `- 사용자가 위 인물에게 직접 질문했다면 먼저 그 질문에 구체적으로 답한다. 새 인물·초인종·전화·외부 사건으로 질문을 회피하거나 장면 초점을 빼앗지 않는다.`,
          `- 직전 어시스턴트 응답이나 장기요약이 다른 화자를 잘못 세웠다면 그 오기를 이어 쓰지 말고 위 대상으로 복구한다.`,
        ].join("\n")
      : "";
    const addressDirectionPriorityBlock = formatAddressDirectionGuard(
      relationshipGraph.relations.map((relation) => ({
        id: relation.id,
        speakerKey: relation.addressSpeakerKey,
        speakerName: relation.addressSpeakerName,
        targetKey: relation.addressTargetKey,
        targetName: relation.addressTargetName,
        term: relation.addressTerm,
        sourceRole: relation.sourceRole,
        isManual: relation.isManual,
        lastSeenTurn: relation.lastSeenTurn,
      }))
    );
    const statusContinuityPriorityBlock = previousStatusPanelSnapshot
      ? [
          `# [STATUS PANEL CONTINUITY — APPLIES TO EVERY CHAT]`,
          `- 아래 블록은 직전 상태들을 누적한 기준 상태다. 이번 답변의 상태창은 이 블록의 라벨·항목·줄 순서를 유지한다.`,
          `- 현재 장면에서 명시적으로 변한 값만 갱신하고, 변하지 않았거나 이번 본문에 언급되지 않은 항목을 임의 삭제·초기화하지 않는다.`,
          `- 호감도/친밀도 목록은 기존 인물과 수치를 유지한다. 현재 사건으로 실제 변화한 인물만 수정하고, 제작자 최대 인원 제한 안에서 누락시키지 않는다.`,
          previousStatusPanelSnapshot,
        ].join("\n")
      : "";
    const system = [
      systemWithIdentityCanon,
      sanitizePromptCached(spatialCanon.block),
      currentNarrationPriorityBlock,
      continuityPriorityBlock,
      temporalPriorityBlock,
      recognitionPriorityBlock,
      scenePresencePriorityBlock,
      epistemicPriorityBlock,
      authorityClaimPriorityBlock,
      legalStatusPriorityBlock,
      vitalStatusPriorityBlock,
      relationshipCanonGuardBlock,
      activeInterlocutorPriorityBlock,
      physicalFactOwnershipBlock,
      addressDirectionPriorityBlock,
      statusContinuityPriorityBlock,
      currentOocPriorityBlock,
    ]
      .filter(Boolean)
      .join("\n\n");

		    // (변경) 상태창을 포함한 응답을 '한 번의 호출'로 생성한다.
	    // - Gemini 3 Pro는 streaming 중간에 fenced(STATUS/INFO)가 반쪽으로 보이는 문제가 컸지만,
	    //   Pro에서는 "done-only"(delta 미전송) 방식을 적용하여 UI 깨짐을 줄인다.
	    // - 그래도 MAX_TOKENS로 끊겨 닫힘 펜스가 누락될 수 있어, 아래의 textPolicy 복구(repairUnclosedAnyFence)로 최소 보정한다.
		    // 추가 안전장치(비용 절감): Gemini 3 Pro에서 2단계 메타 fenced 코드블록을 "마지막"에 출력한 뒤,
		    // 즉시 종료되도록 stop sequence를 사용한다.
		    // - 모델이 메타 fence를 닫고도 계속 출력(불필요 토큰 낭비)하는 케이스를 줄인다.
		    // - stopSequences는 해당 문자열을 응답에 포함하지 않고 중단한다.
		    const systemMain = system;
	
	    // 이어쓰기/보강용 시스템 프롬프트
	    // - 이어쓰기에서는 "상태창/메타"를 다시 출력하지 않도록 금지한다(상태창은 첫 호출의 맨 끝 1회만).
	    // - Gemini 3 Pro는 프롬프트가 길수록(특히 memory/lore) 지연이 커져, 이어쓰기에서만 경량 시스템을 사용한다.
	    //   (직전 출력 tail을 user 메시지로 제공하므로, 이어쓰기에는 format+persona 중심으로 충분)
	    const systemForContinuationRaw = (isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")))
	      ? [
	          `너는 아래 설정을 따르며, 현재 장면의 상대방 캐릭터들과 NPC들을 각각 독립된 인물로 반응시킨다.`,
	          ``,
	          sanitizePromptCached(personaBlock),
	          ``,
	          sanitizePromptCached(noteBlock),
	          ``,
	          sanitizePromptCached(relationshipConsistencyBlock),
	          addressDirectionPriorityBlock ? `` : "",
	          addressDirectionPriorityBlock ? sanitizePromptCached(addressDirectionPriorityBlock) : "",
	          ``,
	          sanitizePromptCached(formatGuide),
	          recentExpressionAvoidanceBlock ? `` : "",
	          recentExpressionAvoidanceBlock ? sanitizePromptCached(recentExpressionAvoidanceBlock) : "",
	          identityCanonBlock ? `` : "",
	          identityCanonBlock ? sanitizePromptCached(identityCanonBlock) : "",
	          canonicalCharacterFactsBlock ? `` : "",
	          canonicalCharacterFactsBlock
	            ? sanitizePromptCached(canonicalCharacterFactsBlock)
	            : "",
	          spatialCanon.block ? `` : "",
	          spatialCanon.block ? sanitizePromptCached(spatialCanon.block) : "",
	          ``,
	          "※ (중요) 이 이어쓰기 호출에서는 fenced 코드블록(```...```) 출력 금지. STATUS/INFO/메타 블록도 출력하지 마라.",
	          currentNarrationPriorityBlock ? `` : "",
	          currentNarrationPriorityBlock
	            ? sanitizePromptCached(currentNarrationPriorityBlock)
	            : "",
	          continuityPriorityBlock ? `` : "",
	          continuityPriorityBlock,
	          ``,
	          vitalStatusPriorityBlock,
	          relationshipCanonGuardBlock,
	          currentOocPriorityBlock ? `` : "",
	          currentOocPriorityBlock
	            ? sanitizePromptCached(currentOocPriorityBlock)
	            : "",
	        ].join("\n")
	      : [
	          systemMain,
	          "",
	          sanitizePromptCached(relationshipConsistencyBlock),
	          "",
	          "※ (중요) 이 이어쓰기 호출에서는 fenced 코드블록(```...```) 출력 금지. STATUS/INFO/메타 블록도 출력하지 마라.",
	        ].join("\n");
	    const systemForContinuation = applyPromptPlaceholders(systemForContinuationRaw, { charName: preset.characterName || npcName || "", userName: personaNameFinal || "" });

	    // (Gemini 3 Pro) 상태창/메타가 "반드시" 필요하지만 본문이 먼저 잘려(또는 모델이 누락해) 상태창이 빠지는 케이스가 있다.
	    // 그 경우에만 아주 짧은 2차 호출로 STATUS 블록만 생성해 덧붙인다.
	    // - 프롬프트를 경량화해 지연을 최소화한다.
	    const systemForStatus = (isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")))
	      ? [
	          `너는 아래 설정을 따르며, 현재 장면의 상대방 캐릭터들과 NPC들을 각각 독립된 인물로 반응시킨다.`,
	          ``,
	          sanitizePromptCached(personaBlock),
	          ``,
	          sanitizePromptCached(noteBlock),
	          ``,
	          continuityPriorityBlock,
	          continuityPriorityBlock ? `` : "",
	          // 상태창만 출력하도록 강제
	          `지금부터는 '2단계 메타/상태'만 작성한다.`,
	          `출력은 반드시 하나의 fenced 코드블록으로만 구성한다.`,
	          `코드블록은 첫 줄이 정확히 \`\`\`STATUS 여야 하며, 마지막 줄은 \`\`\` 로 닫는다.`,
	          `코드블록 밖에는 어떤 텍스트도 출력하지 마라.`,
	          ``,
	          // 형식 힌트(중요한 부분만)
	          `STATUS 블록 내부는 '짧고 구조화된' 항목들로 채운다. (예: TARGET/TYPE/DATA/LIVE 등)`,
	        ].join("\n")
	      : system;

	    const systemStatus = system; // (레거시) 별도 상태창 호출용 - 현재는 기본 비활성

    // 6) 모델 호출
    // - 최근 컨텍스트는 "유저 입력 K턴" 기준으로 tail에 포함
    // - 그 이전은 historySummary(요약)로 대체
    const personaName = personaNameFinal;
    // npcName already defined above
    // 최근 대화 컨텍스트는 유지하되, URL/이미지 마크다운(![](), !!https://...)은 모델 입력에서 제거한다.
    // - 토큰 낭비/유출(긴 URL) 방지
    // - 모델이 URL 문자열을 "참고"해서 출력 형식을 깨는 현상 방지
    const stripStatusErrorFences = (s: string) => {
    const src = String(s || "");
    // Remove internal error STATUS blocks (empty/blocked output) so they don't get re-injected into the prompt.
    return src
      .replace(/```STATUS\s*\n[\s\S]*?\berror:\s*(?:empty_output|blocked_output)[\s\S]*?\n```/gi, "")
      .trim();
    };

    let epistemicTailRedactions = 0;
    let authorityClaimTailRedactions = 0;
    let legalStatusTailRedactions = 0;
    let vitalStatusTailRedactions = 0;
    let relationshipClaimTailRemoved = 0;
    let relationshipClaimTailRewritten = 0;
    let physicalOwnershipTailQualified = 0;
    let physicalOwnershipTailRedactions = 0;
    const promptHistorySource = continueMode
      ? selectMessagesBeforeContinuationTurn(all, continueAid)
      : selectMessagesBeforeCurrentUser(all, userMsg.id);
    const promptHistoryTail = selectPromptHistoryWithSummaryCoverage(
      promptHistorySource,
      keepUserTurns,
      summarizedEndTurn
    );
    const recentOnlyHistory = selectRecentByUserTurns(promptHistorySource, keepUserTurns);
    dbg({
      tag: "send.context.coverage",
      chatId: cid,
      reqId,
      summarizedEndTurn,
      completedTurnCount,
      recentOnlyMessages: recentOnlyHistory.length,
      promptHistoryMessages: promptHistoryTail.length,
      gapMessagesAdded: Math.max(0, promptHistoryTail.length - recentOnlyHistory.length),
    });
    const epistemicTail = promptHistoryTail.map((message) => {
      const role = String(message?.role || "");
      if (role !== "assistant" && role !== "model") return message;
      const sanitized = sanitizeRecentAssistantEpistemicText(
        String(message?.content || ""),
        epistemicFirewall
      );
      epistemicTailRedactions += sanitized.redactedSegments;
      const authorityClaims = sanitizeAuthorityClaims(sanitized.text);
      authorityClaimTailRedactions += authorityClaims.removed;
      const legalStatus = removeUnsupportedLegalStatusClaims({
        text: authorityClaims.text,
        trustedUserTexts: trustedLegalStatusUserTexts,
        trustedNarrationTexts: trustedLegalStatusNarrationTexts,
        identities: legalStatusIdentities,
      });
      legalStatusTailRedactions += legalStatus.removed;
      const vitalStatus = sanitizeVitalStatus(legalStatus.text);
      vitalStatusTailRedactions += vitalStatus.removed;
      const relationshipClaims = sanitizeRelationshipClaims(vitalStatus.text);
      relationshipClaimTailRemoved += relationshipClaims.removed;
      relationshipClaimTailRewritten += relationshipClaims.rewritten;
      const physicalOwnership = sanitizePhysicalOwnership(relationshipClaims.text);
      physicalOwnershipTailQualified += physicalOwnership.qualified;
      physicalOwnershipTailRedactions += physicalOwnership.removed;
      return { ...message, content: physicalOwnership.text };
    });
    const contextRaw = formatStoryTurnsForMode(
      epistemicTail,
      personaName,
      npcName,
      renderMode
    );
    const context = stripUrlsAndMediaMarkdown(stripStatusErrorFences(contextRaw));
    if (
      historyEpistemicView.redactedSegments ||
      epistemicTailRedactions ||
      historyAuthorityClaimView.removed ||
      authorityClaimTailRedactions ||
      historyLegalStatusView.removed ||
      legalStatusTailRedactions ||
      historyVitalStatusView.removed ||
      vitalStatusTailRedactions ||
      historyRelationshipClaimView.removed ||
      historyRelationshipClaimView.rewritten ||
      relationshipClaimTailRemoved ||
      relationshipClaimTailRewritten ||
      historyPhysicalOwnershipView.qualified ||
      historyPhysicalOwnershipView.removed ||
      physicalOwnershipTailQualified ||
      physicalOwnershipTailRedactions
    ) {
      dbg({
        tag: "send.epistemic-firewall",
        chatId: cid,
        reqId,
        protectedFacts: epistemicFirewall.facts.length,
        worldOnlyFacts: epistemicFirewall.worldOnlyRelationIds.size,
        summaryRedactions: historyEpistemicView.redactedSegments,
        recentAssistantRedactions: epistemicTailRedactions,
        authorityClaimSummaryRedactions: historyAuthorityClaimView.removed,
        authorityClaimTailRedactions,
        legalStatusSummaryRedactions: historyLegalStatusView.removed,
        vitalStatusSummaryRedactions: historyVitalStatusView.removed,
        vitalStatusTailRedactions,
        relationshipClaimSummaryRemoved: historyRelationshipClaimView.removed,
        relationshipClaimSummaryRewritten: historyRelationshipClaimView.rewritten,
        relationshipClaimTailRemoved,
        relationshipClaimTailRewritten,
        physicalOwnershipSummaryQualified: historyPhysicalOwnershipView.qualified,
        physicalOwnershipSummaryRedactions: historyPhysicalOwnershipView.removed,
        physicalOwnershipTailQualified,
        physicalOwnershipTailRedactions,
        recentLegalStatusRedactions: legalStatusTailRedactions,
      });
    }
    // 사용자 입력을 모드에 맞춰 전달한다.
    const userLine = continueMode ? "[이어쓰기]" : buildUserLineForMode(userText, personaName, renderMode);

    // Gemini Flash(현재 3.7): keep the slider level and reserve HIGH for heavy reasoning.
    // Raise MID to HIGH only when the *user's current request* asks for reasoning over the heavy context.
    // Otherwise long-memory/status/character-heavy chats would make MID behave like HIGH on every turn.
    if (
      isGemini3FlashModel(chosenModel) &&
      opts.maxReasoningTokens > 0 &&
      opts.maxReasoningTokens <= 640 &&
      String(process.env.CHAT_FLASH_AUTO_REASONING ?? "1").trim() !== "0"
    ) {
      const longMemoryChars = strlen(historySummaryForPrompt);
      const recentChars = strlen(context);
      const rosterChars = strlen(
        dynamicCharacterContext.block || manualCharacterRosterFallback
      );
      const contextHits: string[] = [];
      const intentHits: string[] = [];

      if (authorWantsStatus) contextHits.push("status");
      if (longMemoryChars >= 8000) contextHits.push("longMemory");
      if (recentChars >= 6500) contextHits.push("recentTurns");
      if (rosterChars >= 900) contextHits.push("characters");
      if (userTurnCount >= 40) contextHits.push("longChat");

      if (/관계|기억|정리|요약|지난|이전|누가|누구|왜|모순|규칙|순서/.test(userText)) intentHits.push("memory");
      if (/계산|결과|판정|보고|비교|선택|추리|계획|전략|작전|상태/.test(userText)) intentHits.push("reasoning");
      if (/며칠|몇\s*주|일주일|다음날|시간\s*후|개월|년\s*후|스킵|경과/.test(userText)) intentHits.push("timeskip");
      if ((userText.match(/[가-힣A-Za-z0-9]{2,}/g) || []).length >= 12) intentHits.push("denseInput");

      // (2026-08-14) denseInput은 승격 근거에서 제외한다.
      // "입력에 단어가 12개 이상"이라는 뜻일 뿐 추론 요청이 아닌데, 대화가 길어지면
      // contextHits(longMemory/longChat 등)는 항상 2개를 넘으므로 조금만 길게 써도
      // 매 턴 HIGH로 올라갔다. 3.7 실측(동일 프롬프트): low 7.8s / medium 4.7s / high 15.3s
      // (thoughts 0 / 142 / 1416) — 승격 한 번에 3배 느려지고, 그 지연이 요청 취소로 이어졌다.
      // 주석에 적힌 원래 의도대로 "사용자가 실제로 추론을 요구할 때만" 올린다.
      const reasoningIntents = intentHits.filter((hit) => hit !== "denseInput");
      if (reasoningIntents.length > 0 && contextHits.length >= 2) {
        opts.maxReasoningTokens = 1024;
        debugReasons.push(`reason:auto_flash_high(intent=${reasoningIntents.join("+")};ctx=${contextHits.join("+")})`);
      }
    }

    const continueTail = continueMode
      ? stripUrlsAndMediaMarkdown(
          splitTrailingFenceBlockAtEnd(
            stripStatusErrorFences(String(continueBaseText || ""))
          ).body
        ).slice(-1400)
      : "";

    const oneShotBodyTargetChars = Math.max(200, Math.min(bodyMaxChars, targetChars));
    const oneShotBodyFloorChars =
      metaRequired === "YES"
        ? Math.max(200, Math.floor(oneShotBodyTargetChars * 0.72))
        : Math.max(200, Math.floor(targetChars * 0.9));
    const oneShotLengthContract = [
      `[이번 턴 완료 조건]`,
      `- 첫 호출에서 약 ${targetChars}자(최소 약 ${oneShotBodyFloorChars}자)의 완결된 서사 본문을 작성한다. 문장·대사·지문을 중간에 끊지 않는다.`,
      `- 주인공의 다음 행동이나 대사를 대신 쓰지 않고, 현재 NPC 반응과 장면만 전개한다.`,
      `- 현재 입력이 둘 다·각자·모두·너네·너희처럼 복수 NPC에게 답변을 요구하면, 대상 전원의 관찰 가능한 반응과 대답을 본문에서 모두 끝낸 뒤에만 상태창으로 넘어간다. 한 명만 답하고 종료하지 않는다.`,
      `- 메타/상태창이 필요하면 완결된 본문 뒤에 전체 fenced 코드블록을 한 번만 붙이고 닫는다.`,
    ].join("\n");

    const latestInputNoEchoRule = `사용자의 최신 입력은 이미 화면에 표시되고 끝난 사건이다. 절대 다시 직접 인용하거나, "~라는 말/명령/요구"로 간접 인용·요약·재서술하지 마라. 입력을 내뱉는 목소리·태도·행위도 다시 묘사하지 말고, 그 직후의 NPC 반응·행동·장면 변화부터 시작하라.`;

    const user = continueMode
      ? [
          context ? `[최근 대화]\n${context}` : "",
          ``,
          `다음은 직전 어시스턴트 출력의 마지막 부분이다. 반드시 이 내용의 '다음 문장'부터 이어서 작성하라.`,
          `- 이것은 직전 사용자 행동에 다시 답하는 새 턴이 아니다. 직전 질문·명령·행동을 재현하거나 다시 반응하지 않는다.`,
          `- 이미 쓴 문장 반복/요약/재시작 금지.`,
          `- 장면/시점/말투를 유지하고, 전개만 자연스럽게 이어간다.`,
          `- 이번 추가 본문도 약 ${targetChars}자(최소 약 ${Math.max(200, Math.floor(targetChars * 0.9))}자)로 충분히 전개하고 문장을 완결한다.`,
          `- 메타/STATUS/INFO/코드블록/설명문 금지.`,
          `[직전 출력 끝부분]\n${continueTail}`,
          ``,
          `바로 이어서 본문만 출력하라.`,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          context ? `[최근 대화]\n${context}` : "",
          ``,
          oneShotLengthContract,
	          ``,
	          `# [CURRENT USER TURN — 최우선]`,
	          `- [최근 대화]의 PREVIOUS USER TURN은 이미 답변이 끝난 과거 입력이다. 이전 입력의 명령이나 행동에 다시 반응하지 않는다.`,
	          `- 아래 CURRENT USER INPUT만 이번 턴의 활성 입력이다. 대상·행동·상황이 바뀌었으면 즉시 그 변화에 반응한다.`,
	          latestInputNoEchoRule,
	          `상대가 현재 입력을 들었다는 전제에서 반응만 진행하라. (이름 | ... 같은 화자표기는 쓰지 말고 큰따옴표만 사용)`,
	          `[CURRENT USER INPUT]\n${userLine}`,
	          ``,
	          `출력은 곧바로 시작하라.`,
        ]
          .filter(Boolean)
          .join("\n");

    const recognitionOverrideRequested =
      /기억\s*상실|기억을\s*잃|인식\s*(?:불가|실패)|못\s*알아보|알아보지\s*못|(?:변장|복면|가면).{0,24}(?:정체를?\s*숨|인식\s*(?:불가|실패)|못\s*알아보|알아보지\s*못)/.test(
        userText
      );
    const recognitionValidationActive = Boolean(
      !recognitionOverrideRequested &&
        personaNameFinal &&
        dynamicCharacterContext.recognition.length
    );
    const enforceRecognitionConsistency = async (args: {
      text: string;
      usage: any;
    }) => {
      if (!recognitionValidationActive) return args;
      const contradiction = findRecognitionContradiction({
        text: args.text,
        personaName: personaNameFinal,
        personaAliases: dynamicCharacterContext.personaAliases,
        currentUserText: userText,
        sceneCharacterNames: dynamicCharacterContext.includedNames,
        recognition: dynamicCharacterContext.recognition,
      });
      if (!contradiction) return args;

      dbg({
        tag: "send.recognition_guard.detected",
        chatId: cid,
        reqId,
        characterName: contradiction.characterName,
        matchedText: contradiction.matchedText,
      });

      let text = args.text;
      let usage = args.usage;
      if (!ONE_SHOT) try {
        const repairUser = [
          user,
          "",
          "# [서버 검수 실패 — 전체 답변 재작성]",
          `- 초안에서 이미 여러 차례 직접 만난 ${contradiction.characterName}이(가) ${personaNameFinal}을(를) 초면처럼 대하는 관계 모순이 발견됐다.`,
          `- ${contradiction.characterName}은(는) ${personaNameFinal}을(를) 즉시 알아본다. 저장된 관계·감정·과거 사건에 맞는 반응으로 답변 전체를 다시 작성한다.`,
          `- '누구냐', '누군데', '처음 본다', '초면', '낯선 사람', '모르는 사람'이라는 취지의 표현을 두 사람 사이에 사용하지 않는다.`,
          "- 최신 사용자 입력은 반복하지 않고 직후 반응부터 시작하며, 원래 요구된 분량과 상태창 형식은 유지한다.",
          "",
          "[폐기할 초안 — 관계 모순을 고쳐 새로 쓸 것]",
          text,
        ].join("\n");
        const repaired = await generateText({
          system: [systemMain, recognitionPriorityBlock].filter(Boolean).join("\n\n"),
          user: repairUser,
          opts: {
            ...opts,
            maxOutputTokens: maxOutputTokensForCall,
            maxOutputTokensRequested: opts.maxOutputTokens,
          },
        });
        if (String(repaired?.text || "").trim()) {
          text = String(repaired.text).trim();
          usage = mergeStreamUsage(usage, repaired.usage);
        }
      } catch (error) {
        console.error("[chat/send] recognition repair failed", {
          chatId: cid,
          reqId,
          error: String((error as { message?: unknown })?.message || error),
        });
      }

      const remaining = findRecognitionContradiction({
        text,
        personaName: personaNameFinal,
        personaAliases: dynamicCharacterContext.personaAliases,
        currentUserText: userText,
        sceneCharacterNames: dynamicCharacterContext.includedNames,
        recognition: dynamicCharacterContext.recognition,
      });
      if (remaining) {
        const filtered = removeRecognitionContradictionPassages({
          text,
          personaName: personaNameFinal,
          personaAliases: dynamicCharacterContext.personaAliases,
          currentUserText: userText,
          sceneCharacterNames: dynamicCharacterContext.includedNames,
          recognition: dynamicCharacterContext.recognition,
        });
        if (filtered.text) text = filtered.text;
        dbg({
          tag: "send.recognition_guard.filtered",
          chatId: cid,
          reqId,
          characterName: remaining.characterName,
          removedPassages: filtered.removed,
        });
      } else {
        dbg({
          tag: "send.recognition_guard.repaired",
          chatId: cid,
          reqId,
          characterName: contradiction.characterName,
        });
      }
      return { text, usage };
    };

    const temporalValidationActive = Boolean(
      temporalCanon?.confirmed && !temporalOverrideRequested
    );
    const enforceTemporalConsistency = async (args: {
      text: string;
      usage: any;
    }) => {
      if (!temporalValidationActive) return args;
      const contradiction = findTemporalContradiction({
        text: args.text,
        canon: temporalCanon,
        anchors: pastDatedAnchors,
      });
      if (!contradiction) return args;

      dbg({
        tag: "send.temporal_guard.detected",
        chatId: cid,
        reqId,
        kind: contradiction.kind,
        reason: contradiction.reason,
        matchedText: contradiction.matchedText,
      });

      let text = args.text;
      let usage = args.usage;
      if (!ONE_SHOT) try {
        const repairUser = [
          user,
          "",
          "# [서버 시간축 검수 실패 — 전체 답변 재작성]",
          `- 현재 확정 시점은 ${temporalCanon!.label}이다. 초안의 시간축 모순(${contradiction.reason})을 제거하고 답변 전체를 다시 작성한다.`,
          "- 작품 프롬프트나 로어북의 더 오래된 시작 날짜는 현재 날짜가 아니라 이미 지난 역사적 기준점이다.",
          "- 현재보다 과거 날짜에 예정됐던 행사·발매·리허설·콜타임은 이미 끝난 일정이다. 새 일정처럼 다시 호출하지 않는다.",
          "- 최신 사용자 입력은 반복하지 않고 직후 반응부터 시작하며, 원래 분량과 INFO/STATUS 형식을 유지한다.",
          "",
          "[폐기할 초안 — 시간축을 고쳐 새로 쓸 것]",
          text,
        ].join("\n");
        const repaired = await generateText({
          system: [systemMain, temporalPriorityBlock].filter(Boolean).join("\n\n"),
          user: repairUser,
          opts: {
            ...opts,
            maxOutputTokens: maxOutputTokensForCall,
            maxOutputTokensRequested: opts.maxOutputTokens,
          },
        });
        if (String(repaired?.text || "").trim()) {
          text = String(repaired.text).trim();
          usage = mergeStreamUsage(usage, repaired.usage);
        }
      } catch (error) {
        console.error("[chat/send] temporal repair failed", {
          chatId: cid,
          reqId,
          error: String((error as { message?: unknown })?.message || error),
        });
      }

      const remaining = findTemporalContradiction({
        text,
        canon: temporalCanon,
        anchors: pastDatedAnchors,
      });
      dbg({
        tag: remaining ? "send.temporal_guard.remaining" : "send.temporal_guard.repaired",
        chatId: cid,
        reqId,
        kind: remaining?.kind || contradiction.kind,
        reason: remaining?.reason || contradiction.reason,
      });
      return { text, usage };
    };

    const enforceScenePresenceConsistency = async (args: {
      text: string;
      usage: any;
      allowRepair?: boolean;
    }) => {
      if (!currentScenePresence.length && !currentSceneExclusions.length) return args;
      const contradiction = findScenePresenceContradiction({
        text: args.text,
        currentUserText: userText,
        presentCharacters: currentScenePresence,
        excludedCharacters: currentSceneExclusions,
      });
      if (!contradiction) return args;

      dbg({
        tag: "send.scene_presence_guard.detected",
        chatId: cid,
        reqId,
        characterName: contradiction.characterName,
        kind: contradiction.kind,
        matchedText: contradiction.matchedText,
        presentCharacters: currentScenePresence.map((item) => item.characterName),
        excludedCharacters: currentSceneExclusions.map((item) => item.characterName),
      });

      let text = args.text;
      let usage = args.usage;
      if (args.allowRepair !== false && !ONE_SHOT) {
        try {
          const repairUser = [
            user,
            "",
            "# [서버 검수 실패 — 전체 답변 재작성]",
            `- 초안에서 ${contradiction.characterName}의 현재 장면 위치를 사용자 지시 없이 바꾼 연속성 모순(${contradiction.kind})이 발견됐다.`,
            `- 현재 현장 인물: ${currentScenePresence.map((item) => item.characterName).join(", ")}. 이들은 명시적 퇴장 전까지 '그다음 사람/다음 차례' 후보가 아니다.`,
            `- 현재 현장 출입 제외 인물: ${currentSceneExclusions.map((item) => item.characterName).join(", ") || "없음"}. 사용자가 직접 복귀시키기 전에는 안으로 들이지 않는다.`,
            `- ${contradiction.characterName}의 사용자 확정 위치를 유지한다. 현재 인물을 임의로 내보내거나 제외 인물을 임의로 재입장시키지 않는다.`,
            "- 중복 입장, 임의 퇴장·실종·도주, 무단 재입장, 반복 자기소개를 모두 없애고 답변 전체를 처음부터 다시 쓴다.",
            "- 최신 사용자 입력은 반복하지 않고 직후 반응부터 시작하며, 원래 요구된 분량과 상태창 형식은 유지한다.",
            "",
            "[폐기할 초안 — 장면 체류 모순을 고쳐 새로 쓸 것]",
            text,
          ].join("\n");
          const repaired = await generateText({
            system: [systemMain, scenePresencePriorityBlock]
              .filter(Boolean)
              .join("\n\n"),
            user: repairUser,
            opts: {
              ...opts,
              maxOutputTokens: maxOutputTokensForCall,
              maxOutputTokensRequested: opts.maxOutputTokens,
            },
          });
          if (String(repaired?.text || "").trim()) {
            text = String(repaired.text).trim();
            usage = mergeStreamUsage(usage, repaired.usage);
          }
        } catch (error) {
          console.error("[chat/send] scene presence repair failed", {
            chatId: cid,
            reqId,
            error: String((error as { message?: unknown })?.message || error),
          });
        }
      }

      const remaining = findScenePresenceContradiction({
        text,
        currentUserText: userText,
        presentCharacters: currentScenePresence,
        excludedCharacters: currentSceneExclusions,
      });
      if (remaining) {
        const beforeFilter = text;
        const filtered = removeScenePresenceContradictionPassages({
          text,
          currentUserText: userText,
          presentCharacters: currentScenePresence,
          excludedCharacters: currentSceneExclusions,
        });
        // A continuity backstop may remove a local duplicate-arrival passage,
        // but it must never erase the entire generated turn. If every passage
        // matched, the scene detector is over-broad for this response; preserve
        // the draft and let the narrower sentence gate handle local conflicts.
        text = filtered.text.trim() ? filtered.text : beforeFilter;
        dbg({
          tag: filtered.text.trim()
            ? "send.scene_presence_guard.filtered"
            : "send.scene_presence_guard.overfilter_preserved",
          chatId: cid,
          reqId,
          characterName: remaining.characterName,
          kind: remaining.kind,
          removedPassages: filtered.removed,
        });
      } else {
        dbg({
          tag: "send.scene_presence_guard.repaired",
          chatId: cid,
          reqId,
          characterName: contradiction.characterName,
          kind: contradiction.kind,
        });
      }
      return { text, usage };
    };

    const persistCharacterEventsForMessage = (_args: { messageId: string; assistantContent: string; createdAt: number }) => {
      // character card/relationship logging disabled
    };

    
tEnd(tPrompt);



// ---- Streaming (NDJSON) ----
// Debug flags must be available both inside and outside the streaming block.
const STREAM_DEBUG = process.env.STREAM_DEBUG === "1";
if (wantStream) {
const encoder = new TextEncoder();
let cancelStreamWork: (() => void) | null = null;

  // Stream debug logging (set STREAM_DEBUG=1 to enable)
  const STREAM_DEBUG = process.env.STREAM_DEBUG === "1";
  // Whether we are using streaming transport for this request.
  // Used as a hint to keep the server's final text append-only when appropriate.
  const streamDbgId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const streamTag = `[api][chat.send][stream][${streamDbgId}][chat:${String(chatId)}]`;

  // (UX/네트워크 안정화)
  // 모델이 델타를 한동안 안 줄 때도 연결이 살아있음을 알리고,
  // 일부 프록시/버퍼가 응답을 뭉쳐 보내는 현상을 완화하기 위해 heartbeat를 흘려보낸다.
  // - 클라이언트는 type:"ping"을 텍스트에 반영하지 않음(무시)
  // - 하지만 수신 시각 갱신에는 사용 가능

  const rs = new ReadableStream({
    start(controller) {
      (async () => {
        let streamClosed = false;
        let lastPingAt = 0;
        let lastDeltaAt = 0;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

        const enqueueWire = (obj: any) => {
          if (streamClosed) return false;
          try {
            const now = Date.now();
            if (obj?.type === "delta" && typeof obj?.text === "string" && obj.text.length) {
              lastDeltaAt = now;
            }
            if (obj?.type === "ping") {
              const sincePing = lastPingAt ? now - lastPingAt : -1;
              const sinceDelta = lastDeltaAt ? now - lastDeltaAt : -1;
              lastPingAt = now;
              if (STREAM_DEBUG) {
                console.debug(`${streamTag} ping sent (sincePing=${sincePing}ms sinceDelta=${sinceDelta}ms)`, obj);
              }
            }
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
            return true;
          } catch (e: any) {
            streamClosed = true;
            abortGeneration();
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
            if (STREAM_DEBUG) console.warn(`${streamTag} enqueue ignored (closed)`, e?.message || e);
            return false;
          }
        };
        let streamEpistemicRedactions = 0;
        let streamAuthorityClaimRedactions = 0;
        let streamLegalStatusRedactions = 0;
        let streamVitalStatusRedactions = 0;
        let streamRelationshipClaimRemoved = 0;
        let streamRelationshipClaimRewritten = 0;
        let streamRelationshipContext = "";
        let streamPhysicalOwnershipQualified = 0;
        let streamPhysicalOwnershipRedactions = 0;
        let streamScenePresenceRedactions = 0;
        const guardedTextStream = createGuardedTextStream((text) => {
          const epistemic = sanitizeGeneratedFacts(text);
          const authorityClaims = sanitizeAuthorityClaims(epistemic.text);
          const legalStatus = removeUnsupportedLegalStatusClaims({
            text: authorityClaims.text,
            trustedUserTexts: trustedLegalStatusUserTexts,
            trustedNarrationTexts: trustedLegalStatusNarrationTexts,
            identities: legalStatusIdentities,
          });
          const vitalStatus = sanitizeVitalStatus(legalStatus.text);
          const relationshipClaims = sanitizeRelationshipClaims(
            vitalStatus.text,
            streamRelationshipContext
          );
          streamRelationshipContext = `${streamRelationshipContext}\n${text}`.slice(-1200);
          const physicalOwnership = sanitizePhysicalOwnership(relationshipClaims.text);
          const scenePresence = removeScenePresenceContradictionPassages({
            text: physicalOwnership.text,
            currentUserText: userText,
            presentCharacters: currentScenePresence,
            excludedCharacters: currentSceneExclusions,
          });
          streamEpistemicRedactions += epistemic.redactedSegments;
          streamAuthorityClaimRedactions += authorityClaims.removed;
          streamLegalStatusRedactions += legalStatus.removed;
          streamVitalStatusRedactions += vitalStatus.removed;
          streamRelationshipClaimRemoved += relationshipClaims.removed;
          streamRelationshipClaimRewritten += relationshipClaims.rewritten;
          streamPhysicalOwnershipQualified += physicalOwnership.qualified;
          streamPhysicalOwnershipRedactions += physicalOwnership.removed;
          streamScenePresenceRedactions += scenePresence.removed;
          return scenePresence.text;
        });
        const safeEnqueue = (obj: any) => {
          if (obj?.type !== "delta" || typeof obj?.text !== "string") {
            return enqueueWire(obj);
          }
          const safeText = guardedTextStream.push(obj.text);
          if (!safeText) return !streamClosed;
          return enqueueWire({ ...obj, text: safeText });
        };

        const safeClose = () => {
          const wasClosed = streamClosed;
          streamClosed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          if (wasClosed) return;
          try {
            controller.close();
          } catch {}
        };

        cancelStreamWork = () => {
          streamClosed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
        };

        // First-byte flush (keep-alive before Gemini starts producing)
        safeEnqueue({ type: "ping", phase: "start", t: Date.now() });

        // Keep the connection alive while Gemini is thinking (prevents proxy idle timeouts)
        keepaliveTimer = setInterval(() => {
          const now = Date.now();
          const sinceDelta = lastDeltaAt ? now - lastDeltaAt : Number.POSITIVE_INFINITY;
          const sincePing = lastPingAt ? now - lastPingAt : Number.POSITIVE_INFINITY;
          // Only ping when the model hasn't produced any delta for a while (avoid ping spam during active streaming).
          if (sinceDelta >= 15000 && sincePing >= 15000) {
            safeEnqueue({ type: "ping", phase: "keepalive", t: now });
          }
        }, 15000);

        try {
          const tGeminiStream = tStart(`send.gemini.stream`);

          // By default we keep generation to a single model call (no meta-only followups / server injections).
          // Set AI_ALLOW_SECOND_CALLS=1 to re-enable optional follow-up behaviors for debugging.
          const ALLOW_SECOND_CALLS = false; // forced OFF: no 2nd model call / no meta fallback flows


            // (Meta completion overlap state)
            // gemini-3-pro 계열에서 본문 스트리밍이 끝난 뒤 메타만 2차 호출하면 done 확정이 늦어질 수 있어,
            // 본문이 충분히 생성되면(트리거) 메타 전용 호출을 병렬로 미리 시작해 대기 시간을 줄인다.
	            const META_OVERLAP_ENABLED = ALLOW_SECOND_CALLS && (process.env.AI_META_COMPLETION_OVERLAP || "1") !== "0";
	            const _mainModelForOverlap = String((opts as any)?.model || (settings as any)?.model || "");
	            const _metaOverlapEnabled =
	              META_OVERLAP_ENABLED &&
	              String(process.env.AI_META_COMPLETION || "").trim() === "1" &&
	              (isGemini3ProFamilyModel(_mainModelForOverlap) || /gemini-2\.5-pro/i.test(_mainModelForOverlap)) &&
	              Boolean(metaFenceTemplateHint) &&
	              Boolean(metaLabelHint) &&
	              !DISALLOW_G3PRO_CONTINUE;
            const _metaCompletionModel =
              (process.env.AI_META_COMPLETION_MODEL || "").trim() ||
              ((isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")))
                ? "gemini-3.7-flash"
                : String((opts as any)?.model || (settings as any)?.model || ""));
            const _metaOverlapTriggerRatio = (isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || ""))) ? 0.65 : 0.85;
            const _metaOverlapTriggerChars = Math.max(420, Math.min(promptMaxChars, Math.floor(targetChars * _metaOverlapTriggerRatio)));
            const _metaOverlapTimeoutMs = Math.max(
              500,
              Math.min(2500, parseInt(process.env.AI_META_COMPLETION_OVERLAP_TIMEOUT_MS || "1800", 10) || 1800)
            );
            let metaOverlapPromise: Promise<string> | null = null;
            let metaOverlapTriggeredAt = 0;

          // ===== Generation + one bounded completion recovery =====
          // The normal path stays one-shot. A deterministic post-check may replace
          // the draft once when the turn is objectively incomplete.

          const mergeUsage = mergeStreamUsage;
          const makeContinueUser = (combined: string, reasons: readonly string[] = []) =>
            makeContinueUserPrompt(context, combined, reasons, userText);

          // (2026-07) gemini-3-pro 계열도 기본은 실시간 델타 스트리밍(generateTextStream).
          // 과거 DONE-ONLY(전체 버퍼링) 전환 사유였던 "본문 캡(bodyMaxChars) + 메타 펜스 직전 문장 잘림"은
          // streamLoop의 홀드백 버퍼(마지막 N자 보류 → 캡/펜스 경계 보정 후 방출)로 해결했다.
          // - 방출된 델타는 절대 회수/수정하지 않으므로 delta 누적본과 done/DB 본문이 항상 일치한다.
          // 롤백: AI_G3PRO_DONE_ONLY=1 이면 기존 DONE-ONLY(버퍼링+done만 전송) 모드로 복귀.
          const PRO_DONE_ONLY = Boolean(isGemini3Pro) && String(process.env.AI_G3PRO_DONE_ONLY || "0").trim() === "1";

	          const runOneBuffered = async (userPrompt: string, tag: string) => {
	            try {
const doneOnlyOverlapStart = maybeStartDoneOnlyMetaOverlap({
  proDoneOnly: PRO_DONE_ONLY,
  enabled: _metaOverlapEnabled,
  existingPromise: metaOverlapPromise,
  metaFenceTemplateHint: String(metaFenceTemplateHint || ""),
  userText: String(userText || ""),
  opts,
  metaCompletionModel: _metaCompletionModel,
  metaLabelHint: String(metaLabelHint || ""),
  generateText,
  normalizeAnyFenceOpen,
  repairUnclosedAnyFence,
  reEsc: _reEsc,
});
metaOverlapPromise = doneOnlyOverlapStart.metaOverlapPromise;
if (doneOnlyOverlapStart.metaOverlapTriggeredAt > 0) {
  metaOverlapTriggeredAt = doneOnlyOverlapStart.metaOverlapTriggeredAt;
}
	              return await runBufferedOne({
	                streamDebug: STREAM_DEBUG,
	                streamTag,
	                tag,
	                systemMain,
	                userPrompt,
	                opts,
	                maxOutputTokensForCall,
	                metaRequired: String(metaRequired || ""),
	                statusRequired: String(statusRequired || ""),
	                generateText,
	                onEmptyRaw: (t) => {
	                  debugReasons.push(`empty:${t}`);
	                },
	              });
	            } finally {
	              // hb removed (conditional keepalive handled globally)
	            }
	          };

	          const runOneStream = async (userPrompt: string, tag: string) => {
            if (STREAM_DEBUG) console.debug(`${streamTag} gen.start (${tag})`);

	            const gen = await generateTextStream({
	              system: systemMain,
	              user: userPrompt,
			              opts: buildModelCallOpts({
			                baseOpts: opts,
			                maxOutputTokensForCall,
			                metaRequired: String(metaRequired || ""),
			                statusRequired: String(statusRequired || ""),
			                mode: "stream",
			              }),
	            });

	            let raw = "";
	            let hadDelta = false;
	            try {
	              const loop = await consumeMainStreamDeltas({
	                stream: gen.stream,
	                bodyMaxChars,
	                modelName,
	                metaMaxChars,
	                authorWantsMetaPanel,
	                metaRequired: String(metaRequired || ""),
	                metaFenceTemplateHint: String(metaFenceTemplateHint || ""),
	                metaLabelHint: String(metaLabelHint || ""),
	                streamDebug: STREAM_DEBUG,
	                streamTag,
	                tag,
	                safeEnqueue,
	                isMetaFenceClosed,
	                onMaybeStartMetaOverlap: ({ raw, metaStarted, capReached }) => {
	                  const overlapStart = maybeStartStreamMetaOverlap({
	                    enabled: _metaOverlapEnabled,
	                    existingPromise: metaOverlapPromise,
	                    metaStarted,
	                    capReached,
	                    raw,
	                    triggerChars: _metaOverlapTriggerChars,
	                    metaLabelHint: String(metaLabelHint || ""),
	                    metaFenceTemplateHint: String(metaFenceTemplateHint || ""),
	                    opts,
	                    metaCompletionModel: _metaCompletionModel,
	                    generateText,
	                    normalizeAnyFenceOpen,
	                    repairUnclosedAnyFence,
	                    reEsc: _reEsc,
	                  });
	                  metaOverlapPromise = overlapStart.metaOverlapPromise;
	                  if (overlapStart.metaOverlapTriggeredAt > 0) {
	                    metaOverlapTriggeredAt = overlapStart.metaOverlapTriggeredAt;
	                  }
	                },
	              });
	              raw = loop.raw;
	              hadDelta = loop.hadDelta;
	            } finally {
	              // keep hb alive until we emit done (final usage may arrive slightly later)
	            }
            try {
            return await finalizeStreamResult({
              genFinal: gen.final,
              raw,
              hadDelta,
              modelName,
              modelForWait: String((opts as any)?.model || (settings as any)?.model || ""),
              isGemini3,
              streamDebug: STREAM_DEBUG,
              streamTag,
              tag,
              safeEnqueue,
            });
            } finally {
              // hb removed (conditional keepalive handled globally)
            }
          };

          

          // Recovery is decided once, below, by the deterministic completion
          // guard. It covers MAX_TOKENS, short STOP, unbalanced prose markers,
          // and incomplete plural responses without allowing chained calls.
          const MAX_CONTINUES = 0;
          const generation = await runStreamMainGeneration({
            proDoneOnly: PRO_DONE_ONLY,
            runOneBuffered,
            runOneStream,
            mergeUsage,
            makeContinueUser,
            endsWithCompleteFence,
            userPrompt: user,
            maxContinues: MAX_CONTINUES,
          });
          let usedBufferedTransport = generation.usedBufferedTransport;
          let combinedRaw = generation.combinedRaw;
          let combinedUsage: any = generation.combinedUsage;
          let finishReason = generation.finishReason;

          let raw = combinedRaw;

          // If the output is much shorter than the user's target chars, do a single continuation (append-only).
          const shortContinue = await runOptionalShortContinue({
            allowSecondCalls: ALLOW_SECOND_CALLS,
            oneShot: ONE_SHOT,
            disallowG3ProContinue: DISALLOW_G3PRO_CONTINUE,
            promptMinForGuide,
            promptMaxChars,
            maxOutputTokensForCall,
            raw,
            combinedUsage,
            makeContinueUser,
            generateText,
            systemForContinuation,
            opts,
            mergeUsage,
            safeEnqueue,
            stripEndMarker,
            stripStandaloneSeparatorLines,
            stripUrlsAndMediaMarkdown,
            streamDebug: STREAM_DEBUG,
            streamTag,
            currentUserText: userText,
            allowBoundedRecovery: generation.continuationCount === 0,
          });
          raw = shortContinue.raw;
          combinedUsage = shortContinue.combinedUsage;
          if (shortContinue.replaced) {
            debugReasons.push(`continue:COMPLETION_GUARD(${shortContinue.reasons.join("+")})`);
          }

          const recognitionChecked = await enforceRecognitionConsistency({
            text: raw,
            usage: combinedUsage,
          });
          let postGenerationTextChanged = recognitionChecked.text !== raw;
          raw = recognitionChecked.text;
          combinedUsage = recognitionChecked.usage;
          const beforeTemporalCheck = raw;
          const temporalChecked = await enforceTemporalConsistency({
            text: raw,
            usage: combinedUsage,
          });
          postGenerationTextChanged ||= temporalChecked.text !== beforeTemporalCheck;
          raw = temporalChecked.text;
          combinedUsage = temporalChecked.usage;
          const beforeScenePresenceCheck = raw;
          const scenePresenceChecked = await enforceScenePresenceConsistency({
            text: raw,
            usage: combinedUsage,
            // Live deltas cannot be replaced after emission; their deterministic
            // sentence gate below handles the backstop without a wasted LLM call.
            allowRepair: usedBufferedTransport,
          });
          postGenerationTextChanged ||= scenePresenceChecked.text !== beforeScenePresenceCheck;
          raw = scenePresenceChecked.text;
          combinedUsage = scenePresenceChecked.usage;

          combinedRaw = raw;
          const latestUsage: any = combinedUsage;

          tEnd(tGeminiStream);

          // (기존 후처리 핵심만 적용: 이름/지문 오류 정리 + 완결 보정 + 예산 컷)
          // NOTE: Streaming transport에서 delta로 이미 클라이언트에 출력된 텍스트를
          // done 페이즈에서 재가공/재절단(truncate)하면, UI가 '잠깐 보이다가 사라짐' 현상이 발생할 수 있다.
          // 따라서 streaming transport에서는 원문을 최대한 유지하고, done-only(또는 non-stream) 경로에서만
          // 엄격한 포맷 정책/예산 컷을 적용한다.
          const TRANSPORT_STREAMING = !usedBufferedTransport;

          let assistantText = raw;
        // (Streaming) If the model ended with an unclosed fence, close it locally in a strictly append-only way.
        if (TRANSPORT_STREAMING) {
          try {
            const fenceCount = (assistantText.match(/(^|\n)[ \t]*```/g) || []).length;
            if (fenceCount % 2 === 1) {
              const add = (assistantText.endsWith("\n") ? "" : "\n") + "```";
              assistantText += add;
              raw += add;
              combinedRaw = raw;
              safeEnqueue({ type: "delta", text: add });
            }
          } catch {
            // ignore
          }
        }

          // Streaming transport에서 로컬 메타(상태창/INFO fence)를 주입했는지 기록
          // (done/DB와 delta를 일치시키기 위해, 주입은 '저장 전에' 한 번만 수행)
          let metaInjectedLocalInStream = false;

          
// NOTE: For streaming transport we must keep delta and done identical (append-only).
// Therefore we only strip stop markers in non-streaming mode.
if (!TRANSPORT_STREAMING) {
  // strip END marker if present
  assistantText = stripEndMarker(assistantText);

  // Safety: if stopSequences failed and the marker leaked, drop it.
  try {
  } catch {
    // ignore
  }
}

if (!TRANSPORT_STREAMING) {
            assistantText = stripNamePrefixFromNarration(assistantText);
            assistantText = stripDialogueWrappedNarration(assistantText);

            // In novel mode, avoid aggressive trimming that can drop early scene setup.
            // (chat mode only) keep trimToComplete; in novel mode we keep append-only content.
            // Always enforce novel-only output markers (removes accidental markdown markers, keeps *...* / "..." / fenced).
            assistantText = enforceNovelOnlyOutput(assistantText);
            assistantText = normalizeNovelChannelLayout(assistantText);

            // Label-agnostic fence stabilization (opening line split + unclosed fence repair + conservative loose-meta wrapping)
            assistantText = normalizeAnyFenceOpen(assistantText);
            assistantText = repairUnclosedAnyFence(assistantText);
            assistantText = wrapLooseMetaAsFence(assistantText).text;
            // If a STATUS fenced block is closed and then the model keeps writing, trim after STATUS close.
            assistantText = trimAfterClosedStatusFence(assistantText).text;
            // Label-agnostic fallback: treat everything after the final closing fence as garbage.
            assistantText = stripTrailingTextAfterFinalFence(assistantText);
	            // Finalize (one-shot): cap BODY only (targetChars), keep STATUS/INFO meta outside that budget.
	            // - Total output is still capped by promptMaxChars (= targetChars + meta tail budget).
              const doneOnlyTotalBudget = NO_TRUNCATE_OUTPUT ? Math.max(promptMaxChars, strlen(assistantText)) : promptMaxChars;
              const doneOnlyBodyBudget = NO_TRUNCATE_OUTPUT ? Math.max(bodyMaxChars, strlen(assistantText)) : bodyMaxChars;
	            let finStreamDoneOnly = finalizeOneShotOutputWithMeta(assistantText, doneOnlyTotalBudget, {
	              statusRequired: authorWantsStatus,
	              allowedLabels: allowedMetaLabels,
	              preferAppendOnly: false,
	              bodyBudgetChars: doneOnlyBodyBudget,
	              metaHardMaxChars: metaMaxChars,
	              metaSoftMaxChars: metaMaxChars,
	            });

	            // (fix) If the model printed a trailing status/meta fence with a custom label,
	            // but our allowlist didn't include it, finalize may treat it as BODY and truncate it.
	            // Rescue by detecting the actual trailing fence label from the output.
	            if (finStreamDoneOnly.metaChars === 0) {
	              try {
	                const sp = splitTrailingFenceBlockAtEnd(String(assistantText || ""));
	                const tailFence = String((sp as any)?.meta || "").trim();
	                if (tailFence && looksLikeMetaPanelFence(tailFence)) {
	                  const tailLabelRaw = extractFenceLabelFromFenceBlock(tailFence);
	                  const cands = fenceLabelCandidates(tailLabelRaw);
	                  const ups: string[] = [];
	                  for (const c of cands) {
	                    const core = normalizeFenceLabelToken(c);
	                    if (core) ups.push(core.toUpperCase());
	                    if (c) ups.push(String(c).toUpperCase());
	                  }
	                  const extra = ups.filter((x) => x && !allowedMetaLabels.includes(x));
	                  if (extra.length) {
	                    const allowed3 = Array.from(new Set([...allowedMetaLabels, ...extra]));
	                    finStreamDoneOnly = finalizeOneShotOutputWithMeta(assistantText, doneOnlyTotalBudget, {
	                      statusRequired: authorWantsStatus,
	                      allowedLabels: allowed3,
	                      preferAppendOnly: false,
	                      bodyBudgetChars: doneOnlyBodyBudget,
	                      metaHardMaxChars: metaMaxChars,
	                      metaSoftMaxChars: metaMaxChars,
	                    });
	                    allowedMetaLabels.splice(0, allowedMetaLabels.length, ...allowed3);
	                  }
	                }
	              } catch {
	                // ignore
	              }
	            }
            assistantText = finStreamDoneOnly.text;

	          const STATUS_SEPARATE_MODE = false; // forced OFF: always generate STATUS in the main call (single LLM request).
	          if (STATUS_SEPARATE_MODE && authorWantsStatus) {
            try {
              // 본문에 섞인 fenced 블록/미닫힘 잔해를 제거(상태창은 아래에서 새로 생성)
              let bodyOnly = String(assistantText || "");
              bodyOnly = bodyOnly.replace(/```[\s\S]*?```/g, "");
              bodyOnly = bodyOnly.replace(/```[\s\S]*$/g, "");
              assistantText = bodyOnly.trimEnd();

              const sceneTail = String(assistantText || "").slice(-900);
              const statusUser = [
                "너는 방금 답변의 장면을 기반으로, 서사/대사 없이 '상태창'만 출력하라.",
                "- 반드시 fenced 코드블록 1개로만 출력한다: ```STATUS ...```",
                "- 제작자/프리셋이 요구한 상태창 포맷을 최대한 따른다. (가능하면 [시간/장소], [캐릭터 상태] 포함)",
                "- 불필요한 설명/해설/지시문 금지.",
                "",
                "[최근 장면(참고)]",
                sceneTail,
              ].join("\n");

	              const st = await generateText({
	                system: systemStatus,
	                user: statusUser,
	                opts: { ...opts, maxReasoningTokens: 0, maxOutputTokens: 1024 },
	              });

              // 상태창 호출의 usage도 합산(가능한 경우)
              if ((st as any)?.usage && latestUsage) {
                const add = (st as any).usage;
                for (const k of ["promptTokens", "outputTokens", "reasoningTokens", "totalTokens", "latencyMs"]) {
                  (latestUsage as any)[k] = Number((latestUsage as any)[k] || 0) + Number((add as any)[k] || 0);
                }
                if ((add as any).model) (latestUsage as any).model = (add as any).model;
                if ((add as any).finishReason) (latestUsage as any).finishReason = (add as any).finishReason;
              }

                            let metaRaw = String(st?.text || "").trim();
              // Gemini 3 Pro는 MAX_TOKENS로 fenced 블록이 '닫힘 없이' 잘리는 케이스가 많다.
              // 따라서 모델이 fence를 완결하지 못해도 서버에서 안전하게 감싸서 UI 파싱을 지킨다.
              let metaBody = metaRaw;
              if (metaBody.startsWith("```")) {
                const nl = metaBody.indexOf("\n");
                metaBody = nl >= 0 ? metaBody.slice(nl + 1) : "";
              }
              const close = metaBody.lastIndexOf("```");
              if (close >= 0) metaBody = metaBody.slice(0, close);
              metaBody = metaBody.trimEnd();
              if (metaBody) {
                if (metaBody.length > 6000) metaBody = metaBody.slice(0, 6000).trimEnd();
                const meta = "```STATUS\n" + metaBody + "\n```";
                assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(`${String(assistantText || "").trimEnd()}\n\n${meta}`.trim(), maxChars, 2400);
              }

            } catch {
              // ignore (fallback: no status block)
            }
          }

                    // Keep trailing meta/status fenced block intact by trimming the body first.
            assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, maxChars, 2400);

            // NOTE: do not override maxChars here; use the value computed from UI/output settings above.
            } else {
            // Streaming transport: keep what the client already saw (append-only).
            // Do NOT generate or inject any meta/status fence here (no local fallback, no 2nd call).
            // Only close an unclosed fenced block if the model ended inside one.
            try {
              const s = String(assistantText || "");
              const fenceCount = (s.match(/```/g) || []).length;
              if (fenceCount % 2 === 1) {
                const close = s.endsWith("\n") ? "```\n" : "\n```\n";
                safeEnqueue({ type: "delta", text: close });
                assistantText = s + close;
              }
            } catch {
              // ignore
            }
          }

          const factGuardRecoverySource = assistantText;
          const guardedTail = guardedTextStream.finish();
          if (guardedTail) enqueueWire({ type: "delta", text: guardedTail });
          assistantText = guardedTextStream.output();
          const finalRelationshipClaims = sanitizeRelationshipClaims(assistantText);
          if (
            finalRelationshipClaims.removed > 0 ||
            finalRelationshipClaims.rewritten > 0
          ) {
            streamRelationshipClaimRemoved += finalRelationshipClaims.removed;
            streamRelationshipClaimRewritten += finalRelationshipClaims.rewritten;
            assistantText = finalRelationshipClaims.text;
            postGenerationTextChanged = true;
          }
          if (shortContinue.replaced || postGenerationTextChanged) {
            const epistemic = sanitizeGeneratedFacts(factGuardRecoverySource);
            const authorityClaims = sanitizeAuthorityClaims(epistemic.text);
            const legalStatus = removeUnsupportedLegalStatusClaims({
              text: authorityClaims.text,
              trustedUserTexts: trustedLegalStatusUserTexts,
              trustedNarrationTexts: trustedLegalStatusNarrationTexts,
              identities: legalStatusIdentities,
            });
            const vitalStatus = sanitizeVitalStatus(legalStatus.text);
            const relationshipClaims = sanitizeRelationshipClaims(vitalStatus.text);
            const physicalOwnership = sanitizePhysicalOwnership(relationshipClaims.text);
            const scenePresence = removeScenePresenceContradictionPassages({
              text: physicalOwnership.text,
              currentUserText: userText,
              presentCharacters: currentScenePresence,
              excludedCharacters: currentSceneExclusions,
            });
            streamEpistemicRedactions += epistemic.redactedSegments;
            streamAuthorityClaimRedactions += authorityClaims.removed;
            streamLegalStatusRedactions += legalStatus.removed;
            streamVitalStatusRedactions += vitalStatus.removed;
            streamRelationshipClaimRemoved += relationshipClaims.removed;
            streamRelationshipClaimRewritten += relationshipClaims.rewritten;
            streamPhysicalOwnershipQualified += physicalOwnership.qualified;
            streamPhysicalOwnershipRedactions += physicalOwnership.removed;
            streamScenePresenceRedactions += scenePresence.removed;
            assistantText = scenePresence.text;
          }
          if (!assistantText.trim()) {
            const recovered = recoverAfterOverfilter(factGuardRecoverySource).trim();
            if (recovered) {
              // Epistemic/legal guards have passed. Only the transient scene
              // presence guard over-filtered the draft, so preserve the scene
              // instead of replacing it with a repeated canned sentence.
              enqueueWire({ type: "delta", text: recovered });
              assistantText = recovered;
            }
          }
          if (
            streamEpistemicRedactions ||
            streamAuthorityClaimRedactions ||
            streamLegalStatusRedactions ||
            streamVitalStatusRedactions ||
            streamRelationshipClaimRemoved ||
            streamRelationshipClaimRewritten ||
            streamPhysicalOwnershipQualified ||
            streamPhysicalOwnershipRedactions ||
            streamScenePresenceRedactions
          ) {
            dbg({
              tag: "send.stream.output-fact-guard",
              chatId: cid,
              reqId,
              epistemicRedactions: streamEpistemicRedactions,
              authorityClaimRedactions: streamAuthorityClaimRedactions,
              legalStatusRedactions: streamLegalStatusRedactions,
              vitalStatusRedactions: streamVitalStatusRedactions,
              relationshipClaimRemoved: streamRelationshipClaimRemoved,
              relationshipClaimRewritten: streamRelationshipClaimRewritten,
              physicalOwnershipQualified: streamPhysicalOwnershipQualified,
              physicalOwnershipRedactions: streamPhysicalOwnershipRedactions,
              scenePresenceRedactions: streamScenePresenceRedactions,
            });
          }

          // The model can stop at its soft body budget after opening a dialogue
          // quote/narration marker. Repair locally before persistence; this never
          // spends another model call or rewrites completed prose.
          const streamNovelMarkers = normalizeNovelParagraphMarkers(assistantText);
          if (streamNovelMarkers.changed) {
            assistantText = streamNovelMarkers.text;
            debugReasons.push("format:NORMALIZE_NOVEL_PARAGRAPHS");
          }
          const streamStatusContinuity = mergeStatusPanelContinuity({
            currentText: assistantText,
            previousPanel: previousStatusPanelSnapshot,
            maxAffinityEntries: 5,
            appendWhenMissing: statusRequired === "YES",
          });
          if (streamStatusContinuity.changed) {
            assistantText = streamStatusContinuity.text;
            debugReasons.push(
              streamStatusContinuity.appended
                ? "status:APPEND_MISSING_PREVIOUS_PANEL"
                : "status:RESTORE_PREVIOUS_FIELDS"
            );
          }
          const streamMarkerBalance = repairUnbalancedNovelBodyMarkers(assistantText);
          if (streamMarkerBalance.repaired) {
            assistantText = streamMarkerBalance.text;
            debugReasons.push(`format:CLOSE_BODY_MARKERS:${streamMarkerBalance.added}`);
          }
          if (
            shortContinue.replaced ||
            postGenerationTextChanged ||
            streamStatusContinuity.changed ||
            streamMarkerBalance.repaired
          ) {
            enqueueWire({ type: "replace", text: assistantText });
          }

// messages 저장
          const createdAt = Date.now();
          const assistantId = randomUUID();

          db.prepare(`INSERT INTO messages (id, chatId, role, content, createdAt, updatedAt, userEmail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            assistantId,
            String(chatId),
            "assistant",
            encryptIfPossible(assistantText),
            createdAt,
            createdAt,
            u.email
          );
          _assistantPersisted = true;
          persistCharacterEventsForMessage({
            messageId: assistantId,
            assistantContent: assistantText,
            createdAt,
          });
          // (스토리/캐릭터 메모리) 기능 제거: 장기기억 요약만 운용


          // usage 저장(가능하면 실측, 없으면 추정치로라도 저장)
// - 유저가 "토큰 사용량"을 눌렀을 때 항상 값이 보이게 한다.
// - 특히 gemini-3-pro 계열은 usage 메타데이터가 늦거나 누락되는 케이스가 있어 fallback이 필요하다.
          const usageForStore: any = latestUsage && typeof latestUsage === "object" ? { ...latestUsage } : null;

          const promptTokens =
            (usageForStore ? Number(usageForStore.promptTokens || 0) || 0 : 0) || estTokens(`${system}\n\n${user}`);
          const outputTokens =
            (usageForStore ? Number(usageForStore.outputTokens || 0) || 0 : 0) || estTokens(assistantText);
          const reasoningTokens = (usageForStore ? Number(usageForStore.reasoningTokens || 0) || 0 : 0) || 0;

          const totalTokens =
            (usageForStore ? Number(usageForStore.totalTokens || 0) || 0 : 0) || promptTokens + outputTokens + reasoningTokens;

          const latencyMs = (usageForStore ? Number(usageForStore.latencyMs || 0) || 0 : 0) || 0;

          const modelForCost = String((usageForStore && (usageForStore.model || "")) || opts.model || "").trim() || String(opts.model || "");

          const cost = estimateCost(modelForCost, promptTokens, outputTokens);

          const breakdown = await buildPromptBreakdownWeights({
            model: modelForCost,
            promptTokens,
            systemMain,
            presetBlock,
            loreBlock: typeof loreBlock === "string" ? loreBlock : "",
            personaBlock,
            noteBlock,
            historySummary: historySummaryForPrompt,
            context,
            userLine,
          });
          const weights = breakdown.weights;

          const tokenBreakdown = distribute(promptTokens, weights);
          const estPromptTotal = promptTokens;

          const enrichedUsage: any = usageForStore || {};
          enrichedUsage.model = modelForCost;
          enrichedUsage.promptTokens = promptTokens;
          enrichedUsage.outputTokens = outputTokens;
          enrichedUsage.reasoningTokens = reasoningTokens;
          enrichedUsage.totalTokens = totalTokens;
          enrichedUsage.latencyMs = latencyMs;
          // (디버그) 글자수 기반 길이 제어를 쓰므로, 실제 최종 글자수도 함께 실어 UI/로그에서 확인 가능
          enrichedUsage.outputChars = assistantText.length;
          enrichedUsage.targetChars = targetChars;
          enrichedUsage.promptMaxChars = promptMaxChars;


          enrichedUsage.tokenBreakdown = tokenBreakdown;
          enrichedUsage.estPromptTotal = estPromptTotal;
          enrichedUsage.promptBreakdownMethod = breakdown.method;
          enrichedUsage.estimatedCostUsd = cost.costUsd;
          enrichedUsage.estimatedCostKrw = cost.costKrw;
          enrichedUsage.usdToKrw = cost.usdToKrw;
          const usageExtras = usageStoreExtras(enrichedUsage, debugReasons);

          db.prepare(
            `INSERT OR REPLACE INTO message_usage (
               messageId, chatId, model, promptTokens, outputTokens, reasoningTokens, totalTokens, latencyMs,
               estPromptTotal, tokenBreakdown, finishReason, maxOutputTokensRequested, maxOutputTokensForProvider,
               effectiveMaxOutputTokens, reasoningHeadroomTokens, thinkingBudget, thinkingLevel, usageMetaJson,
               costUsd, costKrw, usdToKrw, createdAt
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            assistantId,
            String(chatId),
            String(enrichedUsage.model || opts.model),
            promptTokens,
            outputTokens,
            reasoningTokens,
            totalTokens,
            latencyMs,
            estPromptTotal,
            JSON.stringify(tokenBreakdown),
            usageExtras.finishReason,
            usageExtras.maxOutputTokensRequested,
            usageExtras.maxOutputTokensForProvider,
            usageExtras.effectiveMaxOutputTokens,
            usageExtras.reasoningHeadroomTokens,
            usageExtras.thinkingBudget,
            usageExtras.thinkingLevel,
            usageExtras.usageMetaJson,
            cost.costUsd,
            cost.costKrw,
            cost.usdToKrw,
            createdAt
          );

          


          // (one-shot finalize)
          // - 사용량/진단 목적: body/meta 분리 및 길이 정보 계산
          // - IMPORTANT: Streaming transport에서는 "이미 delta로 내보낸 텍스트"를 절대 덮어쓰지 않는다.
          //             (done/DB와 스트리밍 출력이 달라지는 문제 방지)
          try {
	            const _metricsMaxChars = Math.max(promptMaxChars, strlen(assistantText));
	            const _metricsBodyBudget = TRANSPORT_STREAMING ? Math.max(bodyMaxChars, strlen(assistantText)) : bodyMaxChars;
	            const _metricsMetaBudget = TRANSPORT_STREAMING ? Math.max(metaMaxChars, 2400) : metaMaxChars;
	            let fin = finalizeOneShotOutputWithMeta(assistantText, _metricsMaxChars, {
	              statusRequired: authorWantsStatus,
	              allowedLabels: allowedMetaLabels,
	              preferAppendOnly: true,
	              bodyBudgetChars: _metricsBodyBudget,
	              metaHardMaxChars: _metricsMetaBudget,
	              metaSoftMaxChars: _metricsMetaBudget,
	            });

	            // (fix) Some creators use a custom/non-standard fence label for the status/meta panel.
	            // If our allowedLabels miss that label, finalizeOneShotOutputWithMeta will think "meta is missing"
	            // and later inject a fallback ("미상") fence, producing *two* panels.
	            //
	            // Here we:
	            // 1) Detect whether the output already ends with a fenced block that looks like a meta panel.
	            // 2) If so, add the *actual* output label to allowedMetaLabels and re-finalize.
	            // 3) Even if we can't extract a usable label, we still suppress local fallback injection.
	            let tailFenceLooksLikeMeta = false;
	            if (!TRANSPORT_STREAMING && fin.metaChars === 0) {
	              try {
	                const sp = splitTrailingFenceBlockAtEnd(String(assistantText || ""));
	                const tailFence = String((sp as any)?.meta || "").trim();
	                if (tailFence && looksLikeMetaPanelFence(tailFence)) {
	                  tailFenceLooksLikeMeta = true;
	                  const tailLabelRaw = extractFenceLabelFromFenceBlock(tailFence);
	                  const cands = fenceLabelCandidates(tailLabelRaw);
	                  const ups: string[] = [];
	                  for (const c of cands) {
	                    const core = normalizeFenceLabelToken(c);
	                    if (core) ups.push(core.toUpperCase());
	                    if (c) ups.push(String(c).toUpperCase());
	                  }
	                  const extra = ups.filter((x) => x && !allowedMetaLabels.includes(x));
	                  if (extra.length) {
	                    const allowed3 = Array.from(new Set([...allowedMetaLabels, ...extra]));
	                    fin = finalizeOneShotOutputWithMeta(assistantText, _metricsMaxChars, {
	                      statusRequired: authorWantsStatus,
	                      allowedLabels: allowed3,
	                      preferAppendOnly: true,
	                      bodyBudgetChars: _metricsBodyBudget,
	                      metaHardMaxChars: _metricsMetaBudget,
	                      metaSoftMaxChars: _metricsMetaBudget,
	                    });
	                    // Persist for later steps (fallback/meta-completion/usage diagnostics)
	                    allowedMetaLabels.splice(0, allowedMetaLabels.length, ...allowed3);
	                  }
	                }
	              } catch {
	                // ignore
	              }
	            }

	            // Non-streaming 모드에서는 여기서 최종 텍스트를 적용할 수 있지만,
	            // 메시지는 이미 DB에 저장되었으므로 반영 시에는 반드시 UPDATE로 동기화한다.
	            if (!TRANSPORT_STREAMING) {
	              const _newText = fin.text;
	              if (_newText && _newText !== assistantText) {
	                assistantText = _newText;
	                try {
	                  db.prepare(`UPDATE messages SET content=? WHERE id=?`).run(encryptIfPossible(assistantText), assistantId);
	                } catch {
	                  // ignore
	                }
	              }
	            }

	            // Streaming에서 로컬 메타를 붙였는지(저장 전 append)
	            let metaInjectedLocal = Boolean(metaInjectedLocalInStream);
	            // (옵션) Non-streaming 모드에서만: 프롬프트가 메타를 요구하지만 모델이 누락했을 경우 로컬 fallback.
	            // Streaming에서는 이미 저장 전에 delta와 함께 주입하므로 여기서 절대 재주입/재작성하지 않는다.
	            
// (Local fallback) Non-streaming mode only:
// If meta/status is required but the model omitted or half-emitted the trailing fenced block,
// inject a small, closed fence locally based on the author template (NO extra LLM call).
const _metaLooksIncomplete =
  !TRANSPORT_STREAMING &&
  (metaRequired === "YES" || statusRequired === "YES") &&
  fin.metaChars > 0 &&
  isMetaFenceLikelyIncomplete(String((fin as any)?.meta || ""), {
    minChars: Math.max(160, Math.min(metaMaxChars || 700, 420)),
    minContentLines: metaFenceTemplateHint ? 5 : 4,
  });
const _localMetaFallbackEnabled =
  !TRANSPORT_STREAMING &&
  (metaRequired === "YES" || statusRequired === "YES") &&
  (fin.metaChars === 0 || _metaLooksIncomplete) &&
  // If the model already emitted a trailing fenced block that *looks* like a meta panel,
  // don't inject another fallback fence (prevents duplicate panels).
  !(tailFenceLooksLikeMeta && !_metaLooksIncomplete) &&
  String(process.env.AI_LOCAL_META_FALLBACK || "1").trim() !== "0";

if (_localMetaFallbackEnabled) {
  try {
    const prev = extractLastMetaContextFromMessages(all, allowedMetaLabels);
    const bodyForSum = String((fin as any)?.body || assistantText || "");
    let sum = bodyForSum
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\s+/g, " " )
      .trim();
    if (sum.length > 160) sum = sum.slice(sum.length - 160);

    // Prefer STATUS when the author explicitly wants a status window.
    const labelHint = (authorWantsStatus ? "STATUS" : (metaLabelHint || "INFO")).trim() || "INFO";

    const fallback = buildLocalFallbackMetaFence({
      labelHint,
      templateHint: metaFenceTemplateHint || "",
      context: {
        bracketLine: prev.bracketLine,
        placeLine: prev.placeLine,
        summaryLine: sum,
        charName: npcName,
        userName: personaNameFinal || "",
      },
      // Ensure enough room so we don't end up with an "80 chars" half-meta like ```STATUS\n현재...
      maxChars: Math.max(220, Math.min(metaMaxChars || 700, 1400)),
      maxLines: 24,
    });

    if (fallback && fallback.includes("```")) {
      // Replace a partial meta block instead of appending a second one.
      const baseBody = String((fin as any)?.body || assistantText || "").trimEnd();
      assistantText = `${baseBody}\n\n${fallback}\n`;

      // Ensure the injected label is part of allowedLabels so meta extraction works.
      const allowed2 = Array.from(new Set([...allowedMetaLabels, labelHint.toUpperCase()]));
      const fin2 = finalizeOneShotOutputWithMeta(assistantText, promptMaxChars, {
        statusRequired: (metaRequired === "YES" || statusRequired === "YES" || authorWantsStatus),
        allowedLabels: allowed2,
        preferAppendOnly: true,
        bodyBudgetChars: bodyMaxChars,
        metaHardMaxChars: metaMaxChars,
        metaSoftMaxChars: metaMaxChars,
      });
      assistantText = fin2.text;
      fin = fin2;
      metaInjectedLocal = true;

      try {
        db.prepare("UPDATE messages SET content=? WHERE id=?").run(encryptIfPossible(assistantText), assistantId);
      } catch {
        // ignore
      }

      if (enrichedUsage && typeof enrichedUsage === "object") {
        (enrichedUsage as any).metaFallbackInjected = true;
        (enrichedUsage as any).metaFallbackLabel = labelHint;
        (enrichedUsage as any).metaFallbackReason = _metaLooksIncomplete ? "incomplete" : "missing";
      }
    }
  } catch (e) {
    if (isChatDebug()) console.warn("[send.metaFallback] failed", e);
  }
}


            // (Gemini 3 Pro) Meta fence completion:
            // If the creator provided a meta fence template (e.g. ```INFO ... ```) but the model omitted it,
            // run a *small* second call that generates ONLY that trailing meta fence. (Body remains untouched.)
	            const _metaCompletionEnabled =
	              !TRANSPORT_STREAMING &&
	              ALLOW_SECOND_CALLS &&
	              String(process.env.AI_META_COMPLETION || "").trim() === "1" &&
	              isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")) &&
	              !DISALLOW_G3PRO_CONTINUE &&
	              !metaInjectedLocal;
            const _needMetaCompletion =
              _metaCompletionEnabled &&
              authorWantsMetaPanel &&
              fin.metaChars === 0 &&
              Boolean(metaFenceTemplateHint) &&
              // If a meta-like fence already exists (custom label/unrecognized), don't add another.
              !tailFenceLooksLikeMeta;
	            if (_needMetaCompletion) {
	              try {
	                const metaCompletion = await resolveMetaCompletionFence({
	                  metaOverlapPromise,
	                  metaOverlapTimeoutMs: _metaOverlapTimeoutMs,
	                  metaLabelHint: String(metaLabelHint || ""),
	                  metaFenceTemplateHint: String(metaFenceTemplateHint || ""),
	                  assistantText,
	                  opts,
	                  metaCompletionModel: _metaCompletionModel,
	                  generateText,
	                  normalizeAnyFenceOpen,
	                  repairUnclosedAnyFence,
	                  reEsc: _reEsc,
	                });
	                const _picked = metaCompletion.picked;
	                
	                if (enrichedUsage && typeof enrichedUsage === "object") {
	                  (enrichedUsage as any).metaOverlapped = metaCompletion.pickedFromOverlap;
	                  (enrichedUsage as any).metaOverlapWaitMs = metaCompletion.metaOverlapWaitMs;
	                  (enrichedUsage as any).metaOverlapTriggeredAt = metaOverlapTriggeredAt || 0;
	                }
if (_picked) {
	                  const appliedMeta = applyMetaCompletionFence({
	                    picked: _picked,
	                    assistantText,
	                    promptMaxChars,
	                    authorWantsStatus,
	                    allowedMetaLabels,
	                    bodyMaxChars,
	                    metaMaxChars,
	                    finalizeOneShotOutputWithMeta,
	                    persistAssistantContent: (content) => {
	                      db.prepare("UPDATE messages SET content=? WHERE id=?").run(encryptIfPossible(content), assistantId);
	                    },
	                  });
	                  if (appliedMeta.applied) {
	                    assistantText = appliedMeta.assistantText;
	                    fin = appliedMeta.fin;
	                    if (enrichedUsage && typeof enrichedUsage === "object") {
	                      (enrichedUsage as any).metaCompleted = true;
	                      (enrichedUsage as any).metaCompletedLabel = metaLabelHint || null;
	                    }
	                  }
	                }
              } catch (e) {
                if (isChatDebug()) console.warn("[send.metaCompletion] failed", e);
              }
            }


            const _streamDebug = process.env.STREAM_DEBUG === "1";
            if (_streamDebug) {
              console.debug(
                `[send.stream.finalize] bodyChars=${fin.bodyChars} metaChars=${fin.metaChars} totalChars=${fin.totalChars} injectedStatus=${fin.injectedStatus}`
              );
            }

	            applyStreamFinalizeUsageStats({
	              enrichedUsage,
	              assistantText,
	              targetChars,
	              allowedMetaLabels,
	              metaLabelHint: String(metaLabelHint || ""),
	              fin: {
	                bodyChars: fin.bodyChars,
	                metaChars: fin.metaChars,
	                totalChars: fin.totalChars,
	                injectedStatus: fin.injectedStatus,
	              },
	              metaInjectedLocal,
	            });
          } catch (e) {
            // 최종 정규화 실패 시에도 응답은 계속 진행한다.
            console.warn("[send.stream.finalize] finalizeOneShotOutputWithMeta failed:", e);
          }
// (자동 fallback 1) MAX_TOKENS로 본문이 비어버린 경우 — output 한도 2배 + thinking 한 단계 ↓로 1회 재호출.
// stream 응답에서 reasoning이 너무 많이 쓰여 본문이 잘리는 케이스 (예: gemini-3.x flash high 단계).
try {
  const _finishStr = String(
    (enrichedUsage as any)?.finishReason ||
      (latestUsage as any)?.finishReason ||
      ""
  ).toUpperCase();
  const _bodyShort = String(assistantText || "").trim().length < 100;
  if (!ONE_SHOT && _finishStr === "MAX_TOKENS" && _bodyShort) {
    const _origOut = Number((opts as any)?.maxOutputTokens || 1200);
    const _origReason = Number((opts as any)?.maxReasoningTokens || 768);
    const _expandedOut = Math.min(5000, Math.max(2000, Math.floor(_origOut * 2)));
    const _reducedReason = Math.max(384, Math.floor(_origReason / 2));
    const _fbStarted = Date.now();
    const fb = await generateText({
      system: systemMain,
      user,
      opts: {
        ...opts,
        maxOutputTokens: _expandedOut,
        maxReasoningTokens: _reducedReason,
        disableMaxTokensFallback: true,
        disableRefusalFallback: true,
      },
    });
    const newText = String((fb as any)?.text || "").trim();
    if (newText && newText.length >= 100) {
      const originalText = assistantText;
      assistantText = newText;
      try {
        db.prepare("UPDATE messages SET content=? WHERE id=?").run(
          encryptIfPossible(assistantText),
          assistantId
        );
      } catch {}
      if (enrichedUsage && typeof enrichedUsage === "object") {
        (enrichedUsage as any).maxTokensFallback = {
          from: { maxOutputTokens: _origOut, maxReasoningTokens: _origReason },
          to: { maxOutputTokens: _expandedOut, maxReasoningTokens: _reducedReason },
          reason: "max_tokens_truncation",
          fallbackLatencyMs: Date.now() - _fbStarted,
          originalTextPreview: originalText.slice(0, 200),
        };
      }
      dbg({
        tag: "send.stream.max_tokens_fallback",
        chatId: String(chatId),
        reqId: String(reqId),
        outputChars: assistantText.length,
      });
    }
  }
} catch (e) {
  if (isChatDebug()) console.warn("[send.stream.max_tokens_fallback] failed", e);
}

// (자동 fallback 2) 거부 응답("죄송합니다. 해당 요청은 수행할 수 없습니다." 등)이면
// gemini-2.5-pro로 1회 재호출 후 결과로 교체한다.
// - stream 모드에선 클라이언트가 거부 텍스트를 delta로 잠깐 봤을 수 있지만,
//   done event의 assistant.content가 새 텍스트로 가면 클라이언트가 final로 덮어쓰기 한다.
// - 이미 fallback 모델이거나 짧지 않은 정상 응답이면 isRefusalText가 false이므로 건너뛴다.
try {
  const refusalFallbackEnabled = String(process.env.AI_REFUSAL_FALLBACK || "0").trim() === "1";
  if (
    !ONE_SHOT &&
    refusalFallbackEnabled &&
    String(opts.model || "").trim() !== REFUSAL_FALLBACK_MODEL &&
    isRefusalText(assistantText)
  ) {
    const fbStartedAt = Date.now();
    const fb = await generateText({
      system: systemMain,
      user,
      opts: {
        ...opts,
        model: REFUSAL_FALLBACK_MODEL,
        // 사용자 요청: 2.5 pro fallback 시 추론을 "최대한 dynamic(auto)"으로 쓰도록.
        // -1 → buildThinkingConfig가 thinkingBudget=-1 로 보내고, 모델이 자율적으로 thoughts 사용.
        // (사용자가 설정한 HIGH 한계도 초과 가능)
        maxReasoningTokens: -1,
        disableRefusalFallback: true,
      },
    });
    const newText = String((fb as any)?.text || "").trim();
    if (newText && !isRefusalText(newText)) {
      const originalText = assistantText;
      assistantText = newText;
      try {
        db.prepare("UPDATE messages SET content=? WHERE id=?").run(
          encryptIfPossible(assistantText),
          assistantId
        );
      } catch {
        // ignore DB update failure
      }
      if (enrichedUsage && typeof enrichedUsage === "object") {
        (enrichedUsage as any).modelFallback = {
          from: String(opts.model || ""),
          to: REFUSAL_FALLBACK_MODEL,
          reason: "refusal_detected",
          originalTextPreview: originalText.slice(0, 200),
          fallbackLatencyMs: Date.now() - fbStartedAt,
        };
      }
      dbg({
        tag: "send.stream.refusal_fallback",
        chatId: String(chatId),
        reqId: String(reqId),
        from: String(opts.model || ""),
        to: REFUSAL_FALLBACK_MODEL,
        outputChars: assistantText.length,
      });
    }
  }
} catch (e) {
  if (isChatDebug()) console.warn("[send.stream.refusal_fallback] failed", e);
}

// (디버그) 최종 출력 글자수/목표치를 서버 로그에도 남긴다.
dbg({
  tag: "send.done.stats",
  chatId: String(chatId),
  reqId: String(reqId),
  targetChars,
  promptMinChars,
  promptMaxChars,
  outputChars: assistantText.length
});
tEnd(tSendTotal);
attachServerTimings(enrichedUsage);
safeEnqueue({
                type: "done",
                user: userMsg,
                assistant: {
                  id: assistantId,
                  chatId: String(chatId),
                  role: "assistant",
                  content: assistantText,
                  createdAt,
                },
                usage: sanitizeUsageForViewer(enrichedUsage || null, canViewDeveloper),
                memoryRefresh,
              });
          if (STREAM_DEBUG) console.debug(`${streamTag} done sent (len=${assistantText.length})`, { usage: sanitizeUsageForViewer(enrichedUsage || null, canViewDeveloper) });
          safeClose();
          // Long-memory refresh is handled out-of-band.
          // We do NOT run any LLM-based refresh work from /api/chat/send (even deferred).
          // The client may trigger /api/chat/memory/refresh after send/stream using memoryRefresh.
        } catch (e: any) {
          if (STREAM_DEBUG) console.error(`${streamTag} stream error`, e);
          cleanupPendingUserOnFailure(cid);
          safeEnqueue({ type: "error", error: String(e?.message || e || "error") });
          safeClose();
        }
      })();
    },
    cancel() {
      cancelStreamWork?.();
      abortGeneration();
      cleanupPendingUserOnFailure(cid);
    },
  });

  return new Response(rs, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

let latestUsage: any = null;
const TRANSPORT_STREAMING = false;

    tStart(tGemini);
	    const first = await generateText({
      system: systemMain,
      user,
	      opts: { ...opts, maxOutputTokens: maxOutputTokensForCall, maxOutputTokensRequested: opts.maxOutputTokens },
    });
    let assistantText = first.text;
    latestUsage = first.usage;
    {
      const fr = String(first?.usage?.finishReason || "").toUpperCase();
      if (fr && fr !== "STOP" && fr !== "FINISH_REASON_UNSPECIFIED") {
        debugReasons.push(`finishReason:${fr}`);
      }
    }


    // 1) 토큰 상한으로 끊긴 경우: 같은 시스템/컨텍스트를 유지한 채 이어쓰기 요청을 몇 번 자동 수행
//    (재작성보다 이어쓰기가 자연스럽고, 사용자가 겪는 "중간 끊김"을 직접 해결)
//
//    ⚠️ 중요한 안정화:
//    - 상태/INFO/STATUS 같은 fenced 메타 블록이 중간에 나오면, 이어쓰기에서 그 뒤에 본문이 붙어 "상태창 뒤에 또 본문"이 생긴다.
//    - 그래서 이어쓰기 전에 마지막 fenced 블록(있다면)을 떼어두고(메타), 본문만 이어쓴 뒤 마지막에 메타를 1회만 붙인다.
const splitTrailingFenceBlock = (text: string) => {
  const t = String(text || "").trim();
  // 마지막 ```...``` 블록을 잡되, 끝에 있어야만 "메타"로 취급한다.
  const re = /```[^\n]*\n[\s\S]*?\n```\s*$/;
  const m = t.match(re);
  if (!m) return { body: t, meta: "" };
  const meta = m[0].trim();
  const body = t.slice(0, t.length - m[0].length).trim();
  return { body, meta };
};
const stripAllFenceBlocks = (text: string) => {
  const t = String(text || "");
  // 모든 fenced 블록을 제거(이어쓰기에서는 절대 메타/코드블록을 만들지 않도록)
  return t.replace(/```[^\n]*\n[\s\S]*?\n```/g, "").trim();
};

let finish = String((first as any)?.usage?.finishReason || "");

// meta를 분리한 본문 기준으로 이어쓰기를 수행한다.
const _split0 = splitTrailingFenceBlock(assistantText);
let metaTail = _split0.meta;
assistantText = _split0.body;

// Gemini 3 Pro can be very slow per call (40~60s). Avoid long chained auto-continues.
const maxAutoContinue = ONE_SHOT || DISALLOW_G3PRO_CONTINUE ? 0 : 2;
for (let i = 0; i < maxAutoContinue; i++) {
  const cutByMax = /MAX/i.test(finish);
  if (cutByMax) debugReasons.push("continue:MAX_TOKENS");
  if (!cutByMax) break;

  const tail = assistantText.slice(-600);
  const contUser = [
    "너는 방금 출력한 답변의 '서사 본문'을 이어서 계속 써야 한다.",
    "- 절대 앞부분을 반복하지 말고, 바로 이어서 계속한다.",
    "- 형식은 유지한다: 지문은 *...*, 상대(NPC) 대사는 큰따옴표 \"...\".",
    "- (중요) fenced 코드블록(```...```)은 절대 출력하지 마라. 상태/INFO/STATUS 같은 메타 블록 출력 금지.",
    "- (중요) 서사 본문은 따옴표 대사로 끝내지 말고, 반드시 *...* 지문 한 줄로 장면을 닫아라.",
    "",
    "[이전 출력의 끝부분]",
    tail,
    "",
    "이어서 출력하라."
  ].join("\n");

  // 남은 분량만큼만 이어쓰기 예산을 준다(폭주 방지)
  const curLen = Array.from(String((assistantText || "").trim())).length;
  const room = Math.max(0, maxChars - curLen);
  if (room <= 80) {
    debugReasons.push(`continue:MAX_TOKENS_SKIP(room=${room})`);
    break;
  }
  const extendTokens = Math.max(384, Math.min(2048, Math.floor(room * 2.0)));

  const cont = await generateText({
	    system: systemForContinuation,
    user: contUser,
    opts: { ...opts, maxOutputTokens: extendTokens },
  });

  const moreRaw = stripEndMarker(cont.text);
  const more = stripAllFenceBlocks(moreRaw);

  // 일부 모델은 MAX_TOKENS인데도 빈 문자열을 내는 경우가 있어(특히 3-pro),
  // 이때는 무한 이어쓰기를 피하기 위해 즉시 중단한다.
  if (!more) {
    debugReasons.push("continue:EMPTY_DELTA");
    latestUsage = mergeStreamUsage(latestUsage, cont.usage);
    finish = String(cont?.usage?.finishReason || "");
    break;
  }

  assistantText = `${stripEndMarker(assistantText)}\n${more}`.trim();
  latestUsage = mergeStreamUsage(latestUsage, cont.usage);
  finish = String(cont?.usage?.finishReason || "");
}

const strlenLocal = (s: string) => Array.from(String(s || "")).length;

// 길이 측정 시에는 "서사 본문"만 본다.
// - STATUS/INFO 같은 fenced 블록(메타)은 길이에서 제외
// - URL/이미지 마크다운(![](), !!https://...)도 제외
const narrativeForLen = (text: string) => {
  let t0 = stripEndMarker(String(text || ""));
  // 완결된 fenced 블록 제거
  t0 = stripAllFenceBlocks(t0);
  // 비완결 fenced(열렸는데 안 닫힌) 블록 제거: ``` 이후 끝까지 제거
  t0 = t0.replace(/```[^\n]*\n[\s\S]*$/g, "");
  // 남은 ``` 잔해 제거
  t0 = t0.replace(/```/g, "");
  return stripUrlsAndMediaMarkdown(t0);
};

// 1-b) 절단 금지 모드에서도 답변이 지나치게 짧게 끝나면(특히 gemini-3-pro* 조기 STOP),
//      재작성 없이 '이어쓰기'를 1회만 수행해 분량을 보강한다.
//      (프롬프트에서 이미 분량을 강하게 요구하지만, 안전망으로 둔다.)
if (NO_TRUNCATE_OUTPUT && !ONE_SHOT && !DISALLOW_G3PRO_CONTINUE) {
  const curLenTotal = strlenLocal((assistantText || "").trim());
  const fullForLen = metaTail ? `${assistantText}\n\n${metaTail}` : assistantText;
  const curLenNarr = strlenLocal(narrativeForLen((fullForLen || "").trim()));
  // When we reserve a meta tail budget, the narrative minimum should not exceed the narrative budget.
  const gap = promptMinForGuide - curLenNarr;

  // - 목표(90%)보다 부족할 때만 보강
  // - 너무 조금(50자 이하) 부족한 건 그냥 넘어감(과잉 생성 방지)
  // - 이미 폭주 상한(runawayMaxChars)에 근접하면 보강하지 않음
  const room = maxChars - curLenTotal;

  if (curLenNarr > 0 && gap > 50 && room > 80) {
    debugReasons.push(`continue:SHORT(narr=${curLenNarr}<${promptMinForGuide}, gap=${gap})`);
    const tail = assistantText.slice(-700);

    // 이어쓰기 예산을 "필요한 만큼만" 부여해 폭주를 막는다.
    // (한글 1자 ≈ 0.6~1 토큰 가정, 넉넉히 3배)
    const extendTokens = Math.max(384, Math.min(2048, gap * 3));

    const contUser = [
      "너는 방금 출력한 서사 본문을 **바로 이어서** 조금만 더 보강해야 한다.",
      "- 절대 앞부분을 반복하지 말고, 직전 문장 다음부터 자연스럽게 이어간다.",
      "- 형식 유지: 지문 *...*, 상대 대사 \"...\"",
      "- 메타/상태창/코드블록 절대 금지.",
      "- 이미지/링크/URL/마크다운(![](), []()) 절대 금지.",
      `- (중요) 약 ${Math.min(gap, 900)}자 정도만 묘사를 더 추가해서 자연스럽게 마무리하라.`,
      "- 마지막은 반드시 *...* 지문 한 줄로 장면을 닫아라.",
      "",
      "[이전 출력의 끝부분]",
      tail,
      "",
      "이어서 출력하라.",
    ].join("\n");

    const cont = await generateText({
	      system: systemForContinuation,
      user: contUser,
      opts: { ...opts, maxOutputTokens: extendTokens },
    });

    const moreRaw = stripEndMarker(cont.text);
    const more = stripAllFenceBlocks(moreRaw);

    if (more) {
      assistantText = `${stripEndMarker(assistantText)}\n${more}`.trim();
      latestUsage = mergeStreamUsage(latestUsage, cont.usage);
      finish = String(cont?.usage?.finishReason || finish || "");
    } else {
      debugReasons.push("continue:SHORT_EMPTY");
      latestUsage = mergeStreamUsage(latestUsage, cont.usage);
    }
  }
}

// (안전장치) 절단 금지 모드에서도, DB/메모리 폭주만 막기 위한 절대 상한만 둔다.
// NOTE: runawayMaxChars로 자르는 것은 '이미 생성된(과금된) 출력'을 버리게 되므로 비활성화한다.
if (NO_TRUNCATE_OUTPUT) {
  const curLen = strlenLocal((assistantText || "").trim());
  if (curLen > HARD_CAP_CHARS) {
    debugReasons.push(`cap:HARD(${curLen}>${HARD_CAP_CHARS})`);
    assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, HARD_CAP_CHARS, 2400);
  }
}

// 이어쓰기 후에는 (있다면) 메타 블록을 1회만 맨 끝에 붙인다.
if (metaTail) {
  assistantText = `${assistantText}\n\n${metaTail}`.trim();
}
// (요구사항) 초반 몇 번 답변이 너무 짧거나 중간에서 끊기는 케이스 보정
    // - "중간 끊김"이면: 같은 내용을 "완결" 형태로 재작성(짧아도 됨)
    // - "너무 짧음"이면: 형식 유지 + 조금 더 길게(하지만 끊기지 않게)
    const trimmed = (assistantText || "").trim();

    // 너무 긴 규칙을 주면 모델이 오히려 '*' 같은 잔해만 내보내는 케이스가 있어,
    // 최소 구조(지문 + NPC 대사)를 만족하고 주인공 대사를 재출력하지 않았는지 검증한다.
    // 추가로 '길이'를 슬라이더 값(=targetChars)에 최대한 맞추기 위해
    // 너무 짧거나/너무 길면 1~2회 재작성하며 max_output_tokens를 동적으로 보정한다.
    const isTooShort = trimmed.length < minChars;
    const isTooLong = trimmed.length > maxChars + 80;
    const looksCut = trimmed.length > 0 && !/[\.!\?"\'\)\]\*]$/.test(trimmed);

    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasNpcLine = new RegExp(`(^|\\n)${esc(npcName)}\\s*\\|\\s*.+`, "m").test(trimmed);
    const hasNarration = /(^|\n)\*[^\n]*\*/m.test(trimmed) || /(^|\n)\*[^\n]+/m.test(trimmed);
    const hasPersonaLine = new RegExp(`(^|\\n)${esc(personaName)}\\s*\\|\\s*.+`, "m").test(trimmed);

    const badShape = trimmed === "*" || trimmed === "" || !hasNpcLine || hasPersonaLine || !hasNarration;

    // 길이 보정에 사용할 토큰 상한 계산(출력 길이와 사용 토큰/문자 비율 기반)
    const adjustMaxOutputTokens = (desiredChars: number) => {
      // 목표는 "최종 결과를 desiredChars 근처로" 맞추는 것이고, 실제 길이는 아래에서 문자수로 잘라 고정한다.
      // 문제는 max_output_tokens가 너무 낮으면(특히 1000 이하) 모델이 조기 종료/끊김/형식 누락을 내기 쉽다는 점.
      // 그래서 생성 단계에서는 **충분히 크게** 주고, 최종은 문자수로 잘라낸다.
      // 경험적으로(한글 기준) 1토큰당 1~4자까지 흔들릴 수 있으므로 여유를 두어 2.2배를 기본으로 둔다.
      const boosted = Math.floor(desiredChars * 2.2);
      return Math.max(512, Math.min(5000, boosted));
    };
    // NOTE: strlen/sliceChars/truncateToCharBudget are imported from ./_server/charBudget

    if (!ONE_SHOT && !NO_TRUNCATE_OUTPUT && (badShape || looksCut || isTooShort || isTooLong)) {
      try {
        const retryUser = [
          user,
          "[추가 지시]",
          badShape
            ? "방금 답변이 형식을 만족하지 못했습니다(대사/지문 누락 또는 '*'만 출력). 아래 규칙대로 전체를 다시 작성하세요."
            : looksCut
              ? "방금 답변이 문장 중간에서 끊겼습니다. 같은 장면을 **짧아도 좋으니 완결**되게 다시 작성하세요."
              : isTooLong
                ? `방금 답변이 너무 깁니다. 같은 장면을 유지하되 군더더기를 줄여 약 ${targetChars}자(±10%) 안으로 더 짧고 밀도 있게 다시 작성하세요.`
                : `방금 답변이 너무 짧습니다. 같은 장면을 유지하되 묘사/상황/심리를 더 추가하여 최소 ${minChars}자 이상으로 충분히 길게 쓰고, 끝까지 완결되게 다시 작성하세요.`,
          "- 반드시 한국어",
          `- 글자수 목표: 약 ${targetChars}자(±10%), 가능하면 ${maxChars}자 이내`,
          `  1) 지문 1~3문장: *...* (NPC 행동/표정/상황)`,
          `  2) 상대 대사 1~3줄: ${preset.characterName || "상대"} | "..." (반드시 큰따옴표로 감싼다)`,
          "- 주인공 대사는 출력하지 말 것",
          "- 지문 줄에는 이름 접두를 붙이지 말 것",
          "- 마지막은 마침표/물음표/느낌표/따옴표 중 하나로 문장을 완결하고 종료한다. ([END] 금지)",
          "[사용자 최신 입력(의미 참고용, 재출력 금지)]",
          userLine,
          latestInputNoEchoRule,
          "[이전 답변(참고용, 그대로 복붙 금지)]",
          assistantText,
        ].join("\n");

        // 길이/형식 보정 시에는 max_output_tokens를 동적으로 조절한다.
        // - 너무 짧으면 더 쓸 수 있게 상향
        // - 너무 길면 짧게 쓰도록 하향
        const nextMaxOut = adjustMaxOutputTokens(targetChars);
        const rewritten = await generateText({
          system: systemMain,
          user: retryUser,
          opts: { ...opts, maxOutputTokens: nextMaxOut },
        });
        if (rewritten?.text) {
          assistantText = rewritten.text;
          latestUsage = mergeStreamUsage(latestUsage, rewritten.usage);
        }
      } catch {
        // ignore
      }
    }

    // (요구사항 #2)
    // "이어쓰기"는 모델이 그대로 지시문을 섞어 출력하거나(예: '이어지는...') 빈 문자열이 나오는 경우가 있어,
    // 2차 재작성 + 최종 문장 단위 절단으로 안정적으로 '완결'을 보장한다.
	    assistantText = stripEndMarker(assistantText || "");

	    // gemini-3-pro는 길이 지시를 무시하고 과하게 출력하는 경우가 있어
	    // (특히 LOW/MID) promptMaxChars를 크게 초과하면 안전하게 잘라준다.
	    if (isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")) && assistantText.length > promptMaxChars) {
        // (문장 완결) 글자수 상한 절단 시, 문장/따옴표가 중간에서 끊기지 않도록
        // "완결 지점"(마침표/따옴표/닫힘)으로 되감아 안전하게 잘라낸다.
        assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, promptMaxChars, 2400);
	        const fin = finalizeOneShotOutputWithMeta(assistantText, promptMaxChars, {
	          statusRequired: authorWantsStatus,
		          allowedLabels: allowedMetaLabels,
	          preferAppendOnly: false,
	          bodyBudgetChars: bodyMaxChars,
	          metaHardMaxChars: metaMaxChars,
	          metaSoftMaxChars: metaMaxChars,
	        });
        assistantText = fin.text;
        if (STREAM_DEBUG) console.debug(`[send.stream.finalize] bodyChars=${fin.bodyChars} metaChars=${fin.metaChars} totalChars=${fin.totalChars} injectedStatus=${fin.injectedStatus}`);

        // Do NOT trim meta blocks with withinBudget slicing.
	        assistantText = finalizeOneShotOutputWithMeta(assistantText, promptMaxChars, {
	          statusRequired: authorWantsStatus,
		          allowedLabels: allowedMetaLabels,
	          preferAppendOnly: TRANSPORT_STREAMING,
	          bodyBudgetChars: bodyMaxChars,
	          metaHardMaxChars: metaMaxChars,
	          metaSoftMaxChars: metaMaxChars,
	        }).text;
	    }

	    // (안정성) 상한 절단 이후에는 메타 펜스/코드블록이 중간에서 끊길 수 있으므로,
	    // 다시 한 번 펜스 정규화/복구를 적용한다.
	    assistantText = normalizeAnyFenceOpen(assistantText);
	    assistantText = repairUnclosedAnyFence(assistantText);
	    assistantText = stripTrailingTextAfterFinalFence(assistantText);

    // Finalize (one-shot): allow TOTAL up to promptMaxChars, but cap BODY to bodyMaxChars.
    const finFinal = finalizeOneShotOutputWithMeta(assistantText, promptMaxChars, {
      statusRequired: authorWantsStatus,
	      allowedLabels: allowedMetaLabels,
      preferAppendOnly: false,
      bodyBudgetChars: bodyMaxChars,
      metaHardMaxChars: metaMaxChars,
      metaSoftMaxChars: metaMaxChars,
    });
    assistantText = finFinal.text;
    if (STREAM_DEBUG) console.debug(`[send.finalize] bodyChars=${finFinal.bodyChars} metaChars=${finFinal.metaChars} totalChars=${finFinal.totalChars} injectedStatus=${finFinal.injectedStatus}`);



    const t1 = (assistantText || "").trim();
    const stillCut = t1.length > 0 && !/[\.\!\?\"\'\)\]\*]$/.test(t1);
    if (!ONE_SHOT && !NO_TRUNCATE_OUTPUT && stillCut) {
      try {
        const retryUser2 = [
          user,
          "[추가 지시]",
          "아래 텍스트는 마지막 문장이 미완성입니다. 같은 내용을 **완결된 형태로 전체를 다시 작성**하세요.",
          "- 출력 형식(대사: 이름 | 내용 / 지문: *...*)은 반드시 유지",
          "- 마지막은 완결된 문장/문단으로 끝내기. ([END] 금지)",
          `- 글자수 목표: 약 ${targetChars}자(±10%), 가능하면 ${maxChars}자 이내`,
          "[미완성 텍스트]",
          assistantText,
        ].join("\n");

        const rewritten2 = await generateText({
          system: systemMain,
          user: retryUser2,
          opts: { ...opts, maxOutputTokens: adjustMaxOutputTokens(targetChars) },
        });

        if (rewritten2?.text) {
          assistantText = stripEndMarker(rewritten2.text);
          latestUsage = mergeStreamUsage(latestUsage, rewritten2.usage);
        }
      } catch {
        // ignore
      }
    }

    if (!NO_TRUNCATE_OUTPUT) {
      assistantText = trimToComplete(stripEndMarker(assistantText || ""));
    }

    // 마크다운(STATUS 코드펜스) 누락 복구
    {
      const n = normalizeStatusFenceOpen(assistantText);
      if (n.normalized) {
        assistantText = n.text;
        console.warn(`[chat/send] normalized STATUS opening fence (non-stream)`, {
          chatId: String(chatId),
        });
      }
      const r = repairUnclosedStatusFence(assistantText);
      assistantText = r.text;
      if (r.repaired) {
        console.warn(`[chat/send] repaired unclosed STATUS fence (non-stream)`, {
          chatId: String(chatId),
          model: String(opts.model || ""),
        });
      }
    }
    // UI/형식 안정화: 지문 접두/주인공 대사 주체 오류를 최소한으로 교정
    // (핵심) 슬라이더 값(예: 800/1600)에 맞춰 **문자수 기준**으로 최종 길이를 고정한다.
    // - 내부적으로는 max_output_tokens를 넉넉히 줄 수 있지만,
    // - 사용자에게 노출되는 결과는 목표 문자수 범위(±) 안으로 맞춘다.
	    if (!NO_TRUNCATE_OUTPUT) {
	      const _beforeCharBudget = assistantText;
	      const bodyBudgetForFinalize = authorWantsMetaPanel ? bodyMaxChars : maxChars;
	      const totalBudgetForFinalize = authorWantsMetaPanel ? promptMaxChars : maxChars;
	      assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, bodyBudgetForFinalize, 2400);
      if (strlen(_beforeCharBudget) > maxChars) debugReasons.push("trim:CHAR_BUDGET");
      // Hard truncation can leave a dangling fragment; cut earlier to a natural boundary.
      const _beforeComplete = assistantText;
	      assistantText = finalizeOneShotOutputWithMeta(assistantText, totalBudgetForFinalize, {
	        statusRequired: authorWantsStatus,
	        allowedLabels: allowedMetaLabels,
	        preferAppendOnly: TRANSPORT_STREAMING,
	        bodyBudgetChars: authorWantsMetaPanel ? bodyMaxChars : undefined,
	        metaHardMaxChars: authorWantsMetaPanel ? metaMaxChars : 900,
	        metaSoftMaxChars: authorWantsMetaPanel ? metaMaxChars : undefined,
	      }).text;
if (_beforeComplete !== assistantText) debugReasons.push("trim:COMPLETE_AFTER_BUDGET");
    }

    // 여전히 너무 짧으면(특히 1,000 이하 구간) 1회 더 재작성한다.
    if (!ONE_SHOT && !NO_TRUNCATE_OUTPUT && (strlen(assistantText) < Math.min(minChars, Math.floor(targetChars * 0.35)) || strlen(assistantText) < 180)) {
      try {
        const retryUser3 = [
          user,
          "[추가 지시]",
          `지금 답변이 너무 짧습니다. 같은 장면을 유지하되 최소 ${minChars}자 이상으로 충분히 서술하고, 끝까지 완결되게 다시 작성하세요.`,
          `- 글자수 목표: 약 ${targetChars}자(±10%), 가능하면 ${maxChars}자 이내`,
          "- 첫 줄은 지문으로 시작(대사로 시작 금지)",
          "- 지문(*...*)에는 이름 접두를 붙이지 말 것",
          "- 마지막은 완결된 문장/문단으로 종료. ([END] 금지)",
          "[사용자 최신 입력(의미 참고용, 재출력 금지)]",
          userLine,
          latestInputNoEchoRule,
        ].join("\n");
        const rewritten3 = await generateText({
          system: systemMain,
          user: retryUser3,
          opts: { ...opts, maxOutputTokens: adjustMaxOutputTokens(targetChars) },
        });
        if (rewritten3?.text) {
          assistantText = normalizeNovelPlain(rewritten3.text);
	          if (!NO_TRUNCATE_OUTPUT) {
	            const _beforeCharBudget2 = assistantText;
	            const bodyBudgetForFinalize2 = authorWantsMetaPanel ? bodyMaxChars : maxChars;
	            const totalBudgetForFinalize2 = authorWantsMetaPanel ? promptMaxChars : maxChars;
	            assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, bodyBudgetForFinalize2, 2400);
	            if (strlen(_beforeCharBudget2) > maxChars) debugReasons.push("trim:CHAR_BUDGET");
	            const _beforeComplete2 = assistantText;
	            assistantText = finalizeOneShotOutputWithMeta(assistantText, totalBudgetForFinalize2, {
	              statusRequired: authorWantsStatus,
	              allowedLabels: allowedMetaLabels,
	              preferAppendOnly: TRANSPORT_STREAMING,
	              bodyBudgetChars: bodyBudgetForFinalize2,
	              metaHardMaxChars: authorWantsMetaPanel ? metaMaxChars : 900,
	              metaSoftMaxChars: authorWantsMetaPanel ? metaMaxChars : undefined,
	            }).text;
	            if (_beforeComplete2 !== assistantText) debugReasons.push("trim:COMPLETE_AFTER_BUDGET");
	          }
          latestUsage = mergeStreamUsage(latestUsage, rewritten3.usage);
        }
      } catch {
        // ignore
      }
    }

    // Gemini 3 Pro 계열에서 fenced STATUS/INFO가 본문 생성에 섞이면 MAX_TOKENS 때 쉽게 반쪽으로 잘려 UI가 깨진다.
    // 따라서 non-stream에서도 본문은 fenced 메타를 포함하지 않도록 정리하고,
    // 상태창은 항상 별도 짧은 호출로 생성해 맨 끝에 1회만 붙인다.
    const STATUS_SEPARATE_MODE = false;

    // (Fallback) 별도 모드가 OFF여도, "상태창이 반드시 필요한데 누락"되는 케이스는 보강한다.
    // - Gemini 3 Pro는 STOP/MAX_TOKENS/EMPTY_DELTA 혼재로 STATUS 블록이 빠지거나, 본문만 출력되고 끝나는 경우가 있다.
    // - 이 경우는 짧은 2차 호출(가능하면 flash)로 STATUS 블록만 생성해 맨 끝에 붙인다.
    // - STATUS가 이미 존재하면(본문에 포함되어 있거나) 아무 것도 하지 않는다.
    const hasStatusFence = /(^|\n)\s*```\s*STATUS\b/i.test(String(assistantText || ""));
    const shouldStatusFallback = Boolean(authorWantsStatus && isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")) && !hasStatusFence);
    if (!ONE_SHOT && !STATUS_SEPARATE_MODE && shouldStatusFallback) {
      try {
        debugReasons.push("statusFallback:BEGIN");

        const sceneTail = String(assistantText || "").slice(-900);
        const contextTail = String(context || "").slice(-1400);
        const statusUser = [
          "너는 방금 답변의 장면을 기반으로, 서사/대사 없이 '상태창'만 출력하라.",
          "- 출력은 반드시 하나의 fenced 코드블록으로만 구성한다.",
          "- 첫 줄은 정확히 ```STATUS 이고, 마지막 줄은 ``` 이다.",
          "- 코드블록 밖 텍스트 금지.",
          "",
          "[최근 대화(참고)]",
          contextTail,
          "",
          "[최근 장면(참고)]",
          sceneTail,
        ].join("\n");

        const st = await generateText({
          system: systemForStatus,
          user: statusUser,
          opts: {
            ...opts,
            model: "gemini-3.7-flash",
            // Gemini 3.6 Flash의 공식 최저 단계인 medium을 사용한다.
            maxReasoningTokens: 640,
            maxOutputTokens: 640,
          },
        });

        let metaRaw = String(st?.text || "").trim();
        // "TITLE | ```STATUS" 같은 prefix가 섞여 오면 fence 시작점부터 잘라낸다.
        const firstFenceIdx = metaRaw.indexOf("```");
        if (firstFenceIdx > 0) metaRaw = metaRaw.slice(firstFenceIdx).trimStart();
        // Gemini 3 Pro/Flash는 MAX_TOKENS/STOP 경계에서 fence가 미닫힘으로 끝나는 케이스가 많다.
        // 서버에서 안전하게 STATUS fence를 완결한다.
        metaRaw = normalizeStatusFenceOpen(metaRaw).text;
        metaRaw = repairUnclosedStatusFence(metaRaw).text;
        if (!/^```/m.test(metaRaw)) {
          metaRaw = "```STATUS\n" + metaRaw + "\n```";
        } else {
          // 시작 fence가 INFO 등으로 와도 STATUS로 통일
          metaRaw = metaRaw.replace(/^```[^\n]*/m, "```STATUS");
          if (!metaRaw.trimEnd().endsWith("```")) metaRaw = metaRaw.trimEnd() + "\n```";
        }

        // 닫힘 fence 이후의 잔여 텍스트는 잘라낸다(파서 안전).
        const closeEnd = findLastStatusFenceCloseEnd(metaRaw);
        if (closeEnd > 0) metaRaw = metaRaw.slice(0, closeEnd).trimEnd();

        assistantText = `${String(assistantText || "").trimEnd()}\n\n${metaRaw}`.trim();
        assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, maxChars, 2400);
        assistantText = stripEndMarker(assistantText || "");

        // 상태창 fallback 호출의 usage도 합산(가능한 경우)
        if ((st as any)?.usage) {
          const add = (st as any).usage;
          if (!latestUsage) latestUsage = {};
          for (const k of ["promptTokens", "outputTokens", "reasoningTokens", "totalTokens", "latencyMs"]) {
            (latestUsage as any)[k] = Number((latestUsage as any)[k] || 0) + Number((add as any)[k] || 0);
          }
          if ((add as any).model) (latestUsage as any).model = (add as any).model;
          if ((add as any).finishReason) (latestUsage as any).finishReason = (add as any).finishReason;
        }

        debugReasons.push("statusFallback:OK");
      } catch {
        debugReasons.push("statusFallback:ERR");
      }
    }
    if (STATUS_SEPARATE_MODE && authorWantsStatus) {
      try {
        // 본문에 섞인 fenced 블록/미닫힘 잔해 제거
        let bodyOnly = String(assistantText || "");
        bodyOnly = bodyOnly.replace(/```[\s\S]*?```/g, "");
        bodyOnly = bodyOnly.replace(/```[\s\S]*$/g, "");
        assistantText = bodyOnly.trimEnd();

        const sceneTail = String(assistantText || "").slice(-900);
        const statusUser = [
          "너는 방금 답변의 장면을 기반으로, 서사/대사 없이 '상태창'만 출력하라.",
          "- 반드시 fenced 코드블록 1개로만 출력한다: ```STATUS ...```",
          "- 제작자/프리셋이 요구한 상태창 포맷을 최대한 따른다. (가능하면 [시간/장소], [캐릭터 상태] 포함)",
          "- 불필요한 설명/해설/지시문 금지.",
          "",
          "[최근 장면(참고)]",
          sceneTail,
        ].join("\n");

        const st = await generateText({
          system: systemStatus,
          user: statusUser,
	          opts: (isGemini3ProFamilyModel(String((opts as any)?.model || (settings as any)?.model || "")))
	            ? { ...opts, model: "gemini-3.7-flash", maxReasoningTokens: 640, maxOutputTokens: 640 }
	            : { ...opts, maxOutputTokens: Math.min(1024, maxOutputTokensForCall) },
        });

                                let metaRaw = String(st?.text || "").trim();
                // Gemini 3 Pro는 MAX_TOKENS로 fenced 블록이 '닫힘 없이' 잘리는 케이스가 많다.
                // 따라서 모델이 fence를 완결하지 못해도 서버에서 안전하게 감싸서 UI 파싱을 지킨다.
                let metaBody = metaRaw;
                if (metaBody.startsWith("```")) {
                  const nl = metaBody.indexOf("\n");
                  metaBody = nl >= 0 ? metaBody.slice(nl + 1) : "";
                }
                const close = metaBody.lastIndexOf("```");
                if (close >= 0) metaBody = metaBody.slice(0, close);
                metaBody = metaBody.trimEnd();
                if (metaBody) {
                  if (metaBody.length > 6000) metaBody = metaBody.slice(0, 6000).trimEnd();
                  const meta = "```STATUS\n" + metaBody + "\n```";
                  assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(
                    `${String(assistantText || "").trimEnd()}\n\n${meta}`.trim(), maxChars, 2400);
                }


        // 상태창 호출의 usage도 합산(가능한 경우)
        if ((st as any)?.usage && latestUsage) {
          const add = (st as any).usage;
          for (const k of ["promptTokens", "outputTokens", "reasoningTokens", "totalTokens", "latencyMs"]) {
            (latestUsage as any)[k] = Number((latestUsage as any)[k] || 0) + Number((add as any)[k] || 0);
          }
          if ((add as any).model) (latestUsage as any).model = (add as any).model;
          if ((add as any).finishReason) (latestUsage as any).finishReason = (add as any).finishReason;
        }

        // 예산 재적용(메타 보존)
        assistantText = preserveTrailingMetaFenceBlocksOutsideBudget(assistantText, maxChars, 2400);
        } catch {
        // ignore
      }
    }

    const recognitionChecked = await enforceRecognitionConsistency({
      text: assistantText,
      usage: latestUsage,
    });
    assistantText = recognitionChecked.text;
    latestUsage = recognitionChecked.usage;
    const temporalChecked = await enforceTemporalConsistency({
      text: assistantText,
      usage: latestUsage,
    });
    assistantText = temporalChecked.text;
    latestUsage = temporalChecked.usage;
    const scenePresenceChecked = await enforceScenePresenceConsistency({
      text: assistantText,
      usage: latestUsage,
    });
    assistantText = scenePresenceChecked.text;
    latestUsage = scenePresenceChecked.usage;

    tEnd(tGemini);
    tStart(tPost);

    assistantText = normalizeNovelChannelLayout(assistantText);

    // ---- Token breakdown (prompt input composition) ----
    // promptTokens(실측)을 각 구성요소에 배분한다.
    // 가능하면 countTokens(실측 tokenizer) 기반 가중치를 사용하고, 실패 시 추정치로 fallback한다.

	    // 비용 추정
	    // - 기본: Gemini usageMetadata 기반(실측 input/output)
	    // - UI에 표시하는 "예상 비용(추정)"은 "실측 토큰 + 입력 구성(추정)"을 합산한 값으로 계산(사용자 요청)
	    // usage가 비어도 0으로 저장되지 않도록(누락 방지) send/stream 경로와 동일한 fallback을 사용한다.
	    const usageForStore: any = latestUsage && typeof latestUsage === "object" ? { ...latestUsage } : {};
	    const promptT = Number(usageForStore.promptTokens || 0) || estTokens(`${systemMain}\n\n${user}`);
	    const outT = Number(usageForStore.outputTokens || 0) || estTokens(assistantText);
	    const reasoningT = Number(usageForStore.reasoningTokens || 0) || 0;
	    const totalT = Number(usageForStore.totalTokens || 0) || promptT + outT + reasoningT;
	    const latencyT = Number(usageForStore.latencyMs || 0) || 0;
	    const modelForCost = String((usageForStore && (usageForStore.model || "")) || opts.model || "").trim() || String(opts.model || "");
	    usageForStore.model = modelForCost;
	    usageForStore.promptTokens = promptT;
	    usageForStore.outputTokens = outT;
	    usageForStore.reasoningTokens = reasoningT;
	    usageForStore.totalTokens = totalT;
	    usageForStore.latencyMs = latencyT;
	    latestUsage = { ...usageForStore };
	    const cost = estimateCost(modelForCost, promptT, outT);

    const breakdown = await buildPromptBreakdownWeights({
      model: modelForCost,
      promptTokens: promptT,
      systemMain,
      presetBlock,
      loreBlock: typeof loreBlock === "string" ? loreBlock : "",
      personaBlock,
      noteBlock,
      historySummary: historySummaryForPrompt,
      context,
      userLine,
    });
    const weights = breakdown.weights;
    const tokenBreakdown = distribute(promptT, weights);
    const estPromptTotal = Object.values(tokenBreakdown).reduce((a, b) => a + (Number(b) || 0), 0);

    // (debug) 실제 배분 결과/길이 확인용 로그
    dbg({
      tag: "send.token.breakdown",
      chatId: cid,
      reqId,
      promptTokens: promptT,
      weights,
      tokenBreakdown,
      lens: {
        systemChars: strlen(systemMain),
        presetChars: strlen(presetBlock),
        loreChars: strlen(typeof loreBlock === "string" ? loreBlock : ""),
        personaChars: strlen(personaBlock),
        noteChars: strlen(noteBlock),
        longMemoryChars: strlen(historySummaryForPrompt),
        recentTurnsChars: strlen(context),
        userInputChars: strlen(userLine),
      },
    });

    if (continueMode && continueBaseText) {
      assistantText = mergeContinuationBase(continueBaseText, assistantText);
    }

    const factGuardRecoverySource = assistantText;
    const epistemicOutputChecked = sanitizeGeneratedFacts(assistantText);
    const authorityClaimOutputChecked = sanitizeAuthorityClaims(
      epistemicOutputChecked.text
    );
    assistantText = authorityClaimOutputChecked.text;
    const legalStatusOutputChecked = removeUnsupportedLegalStatusClaims({
      text: assistantText,
      trustedUserTexts: trustedLegalStatusUserTexts,
      trustedNarrationTexts: trustedLegalStatusNarrationTexts,
      identities: legalStatusIdentities,
    });
    const vitalStatusOutputChecked = sanitizeVitalStatus(legalStatusOutputChecked.text);
    const relationshipClaimOutputChecked = sanitizeRelationshipClaims(
      vitalStatusOutputChecked.text
    );
    const physicalOwnershipOutputChecked = sanitizePhysicalOwnership(
      relationshipClaimOutputChecked.text
    );
    const scenePresenceOutputChecked = removeScenePresenceContradictionPassages({
      text: physicalOwnershipOutputChecked.text,
      currentUserText: userText,
      presentCharacters: currentScenePresence,
      excludedCharacters: currentSceneExclusions,
    });
    assistantText = scenePresenceOutputChecked.text;
    if (
      epistemicOutputChecked.redactedSegments ||
      authorityClaimOutputChecked.removed ||
      legalStatusOutputChecked.removed ||
      vitalStatusOutputChecked.removed ||
      relationshipClaimOutputChecked.removed ||
      relationshipClaimOutputChecked.rewritten ||
      physicalOwnershipOutputChecked.qualified ||
      physicalOwnershipOutputChecked.removed ||
      scenePresenceOutputChecked.removed
    ) {
      if (epistemicOutputChecked.redactedSegments) {
        debugReasons.push(`guard:EPISTEMIC(${epistemicOutputChecked.redactedSegments})`);
      }
      if (authorityClaimOutputChecked.removed) {
        debugReasons.push(
          `guard:AUTHORITY_CLAIM(${authorityClaimOutputChecked.removed})`
        );
      }
      if (legalStatusOutputChecked.removed) {
        debugReasons.push(`guard:LEGAL_STATUS(${legalStatusOutputChecked.removed})`);
      }
      if (vitalStatusOutputChecked.removed) {
        debugReasons.push(`guard:VITAL_STATUS(${vitalStatusOutputChecked.removed})`);
      }
      if (relationshipClaimOutputChecked.removed) {
        debugReasons.push(
          `guard:RELATIONSHIP_CLAIM_REMOVE(${relationshipClaimOutputChecked.removed})`
        );
      }
      if (relationshipClaimOutputChecked.rewritten) {
        debugReasons.push(
          `guard:RELATIONSHIP_CLAIM_REWRITE(${relationshipClaimOutputChecked.rewritten})`
        );
      }
      if (physicalOwnershipOutputChecked.qualified) {
        debugReasons.push(
          `guard:PHYSICAL_OWNER_QUALIFY(${physicalOwnershipOutputChecked.qualified})`
        );
      }
      if (physicalOwnershipOutputChecked.removed) {
        debugReasons.push(
          `guard:PHYSICAL_OWNER_REMOVE(${physicalOwnershipOutputChecked.removed})`
        );
      }
      if (scenePresenceOutputChecked.removed) {
        debugReasons.push(
          `guard:SCENE_PRESENCE(${scenePresenceOutputChecked.kinds.join("+") || "unknown"}:${scenePresenceOutputChecked.removed})`
        );
      }
      dbg({
        tag: "send.output-fact-guard",
        chatId: cid,
        reqId,
        epistemicRedactions: epistemicOutputChecked.redactedSegments,
        authorityClaimRedactions: authorityClaimOutputChecked.removed,
        authorityClaimTypes: authorityClaimOutputChecked.claimTypes,
        legalStatusRedactions: legalStatusOutputChecked.removed,
        legalStatuses: legalStatusOutputChecked.statuses,
        legalCharacters: legalStatusOutputChecked.characterNames,
        vitalStatusRedactions: vitalStatusOutputChecked.removed,
        vitalStatusSubjects: vitalStatusOutputChecked.subjects,
        relationshipClaimRemoved: relationshipClaimOutputChecked.removed,
        relationshipClaimRewritten: relationshipClaimOutputChecked.rewritten,
        relationshipClaims: relationshipClaimOutputChecked.claims,
        physicalOwnershipQualified: physicalOwnershipOutputChecked.qualified,
        physicalOwnershipRedactions: physicalOwnershipOutputChecked.removed,
        physicalOwnershipSubjects: physicalOwnershipOutputChecked.owners,
        scenePresenceRedactions: scenePresenceOutputChecked.removed,
        scenePresenceCharacters: scenePresenceOutputChecked.characterNames,
      });
    }
    if (!assistantText.trim()) {
      assistantText = scenePresenceOutputChecked.removed
        ? "*현재 장면에 남아 있던 인물들은 자리를 떠나지 않은 채, 서로를 바라보며 반응을 이어갔다.*"
        : recoverAfterOverfilter(factGuardRecoverySource).trim();
    }
    const novelMarkers = normalizeNovelParagraphMarkers(assistantText);
    if (novelMarkers.changed) {
      assistantText = novelMarkers.text;
      debugReasons.push("format:NORMALIZE_NOVEL_PARAGRAPHS");
    }
    const statusContinuity = mergeStatusPanelContinuity({
      currentText: assistantText,
      previousPanel: previousStatusPanelSnapshot,
      maxAffinityEntries: 5,
      appendWhenMissing: statusRequired === "YES",
    });
    if (statusContinuity.changed) {
      assistantText = statusContinuity.text;
      debugReasons.push(
        statusContinuity.appended
          ? "status:APPEND_MISSING_PREVIOUS_PANEL"
          : "status:RESTORE_PREVIOUS_FIELDS"
      );
    }
    const markerBalance = repairUnbalancedNovelBodyMarkers(assistantText);
    if (markerBalance.repaired) {
      assistantText = markerBalance.text;
      debugReasons.push(`format:CLOSE_BODY_MARKERS:${markerBalance.added}`);
    }
    usageForStore.outputChars = strlen(assistantText);
    usageForStore.targetChars = targetChars;
    usageForStore.promptMaxChars = promptMaxChars;
    usageForStore.promptBreakdownMethod = breakdown.method;
    latestUsage = { ...(latestUsage || {}), ...usageForStore };

	    let assistantMsg: any = {
      id: randomUUID(),
      chatId: cid,
      role: "assistant" as const,
      // (요구사항)
      // 응답 첫 줄이 인물 이름으로 시작하는 서술(예: "서윤아는...")이면
      // 억지로 "상대 |" 접두를 붙이지 않는다.
      content: ensurePrefix(assistantText || "(응답이 비었습니다.)", npcName, [personaName, npcName]),
      createdAt: Date.now(),
	      usage: usageForStore
	        ? sanitizeUsageForViewer({
	            ...usageForStore,
	            tokenBreakdown,
	            estPromptTotal,
              promptBreakdownMethod: breakdown.method,
	            estimatedCostUsd: cost.costUsd,
            estimatedCostKrw: cost.costKrw,
            usdToKrw: cost.usdToKrw,
            debugReasons,
          }, canViewDeveloper)
        : null,
    };

    if (replaceAid) {
      // 기존 assistant 메시지를 교체
      db.prepare(`UPDATE messages SET content=?, createdAt=?, updatedAt=? WHERE id=?`).run(
        encryptIfPossible(assistantMsg.content),
        assistantMsg.createdAt,
        assistantMsg.createdAt,
        replaceAid
      );
      assistantMsg.id = replaceAid;
    } else {
      db.prepare(`INSERT INTO messages (id, chatId, role, content, createdAt, updatedAt, userEmail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        assistantMsg.id,
        assistantMsg.chatId,
        assistantMsg.role,
        encryptIfPossible(assistantMsg.content),
        assistantMsg.createdAt,
        assistantMsg.createdAt,
        u.email
      );
    }
    _assistantPersisted = true;
    persistCharacterEventsForMessage({
      messageId: assistantMsg.id,
      assistantContent: String(assistantMsg.content || ""),
      createdAt: Number(assistantMsg.createdAt || Date.now()),
    });
    // (B 모드) 캐릭터/씬 등 구조화 메모리는 사용하지 않는다.


	    // 메시지별 토큰/지연 정보 저장(선택 기능)
	    try {
	      const u = usageForStore || {};
	      const modelName2 = String(u.model || opts.model || "");
	      const promptT2 = Number(u.promptTokens || 0);
	      const outT2 = Number(u.outputTokens || 0);
		      const reasoningT2 = Number((u as any).reasoningTokens || 0);
		      const c = estimateCost(modelName2, promptT2, outT2);
          const usageExtras2 = usageStoreExtras(u, debugReasons);
	      db.prepare(
		        `INSERT OR REPLACE INTO message_usage (
             messageId, chatId, model, promptTokens, outputTokens, reasoningTokens, totalTokens, latencyMs,
             estPromptTotal, tokenBreakdown, finishReason, maxOutputTokensRequested, maxOutputTokensForProvider,
             effectiveMaxOutputTokens, reasoningHeadroomTokens, thinkingBudget, thinkingLevel, usageMetaJson,
             costUsd, costKrw, usdToKrw, createdAt
           )
	         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(messageId) DO UPDATE SET
           model=excluded.model,
           promptTokens=excluded.promptTokens,
           outputTokens=excluded.outputTokens,
	           reasoningTokens=excluded.reasoningTokens,
           totalTokens=excluded.totalTokens,
           latencyMs=excluded.latencyMs,
           estPromptTotal=excluded.estPromptTotal,
           tokenBreakdown=excluded.tokenBreakdown,
           finishReason=excluded.finishReason,
           maxOutputTokensRequested=excluded.maxOutputTokensRequested,
           maxOutputTokensForProvider=excluded.maxOutputTokensForProvider,
           effectiveMaxOutputTokens=excluded.effectiveMaxOutputTokens,
           reasoningHeadroomTokens=excluded.reasoningHeadroomTokens,
           thinkingBudget=excluded.thinkingBudget,
           thinkingLevel=excluded.thinkingLevel,
           usageMetaJson=excluded.usageMetaJson,
           costUsd=excluded.costUsd,
           costKrw=excluded.costKrw,
           usdToKrw=excluded.usdToKrw,
           createdAt=excluded.createdAt`
      ).run(
        assistantMsg.id,
        cid,
	        String(u.model || opts.model || ''),
	        Number(u.promptTokens || 0),
		        Number(u.outputTokens || 0),
		        reasoningT2,
	        Number(u.totalTokens || 0),
	        Number(u.latencyMs || 0),
	        Number(estPromptTotal || 0),
	        JSON.stringify(tokenBreakdown || {}),
          usageExtras2.finishReason,
          usageExtras2.maxOutputTokensRequested,
          usageExtras2.maxOutputTokensForProvider,
          usageExtras2.effectiveMaxOutputTokens,
          usageExtras2.reasoningHeadroomTokens,
          usageExtras2.thinkingBudget,
          usageExtras2.thinkingLevel,
          usageExtras2.usageMetaJson,
	        Number(c.costUsd || 0),
	        Number(c.costKrw || 0),
        Number(c.usdToKrw || DEFAULT_USD_TO_KRW),
        assistantMsg.createdAt
      );
    } catch {
      // ignore
    }

    // (선택지) 사용자가 다음에 말할만한 답변 3개를 제안
    let suggestions: string[] = [];
    if (body?.includeSuggestions === true) {
      try {
      const suggestSystem = [
        "너는 한국어 대화 보조자다.",
        "사용자가 다음에 보낼만한 짧은 답변 후보 3개를 제안한다.",
        "반드시 **주인공(사용자) 시점**의 답변으로만 구성한다.",
        "- 즉, '내/나/저/제가' 등 1인칭을 사용하거나, 주인공이 직접 말하는 문장이어야 한다.",
        "- 상대 캐릭터의 시점/독백/지문을 쓰지 않는다.",
        "- 상대 캐릭터의 이름 접두나 지문(*...*)를 포함하지 않는다.",
        "각 항목은 1줄, 4~40자, 존댓말/반말은 현재 톤을 유지한다.",
        "출력은 JSON 한 줄로만: {\"suggestions\":[\"...\",\"...\",\"...\"]}",
      ].join("\n");
      const suggestUser = [
        "[최근 대화]",
        context || "",
        "[사용자 방금 입력]",
        userText,
        "[상대 방금 응답]",
        assistantMsg.content,
      ].join("\n");

      const raw = await generateText({
        system: suggestSystem,
        user: suggestUser,
        opts: { ...opts, maxOutputTokens: Math.min(256, Number(settings.maxOutputTokens ?? 1024)) },
      });
      const rawStr = String(raw?.text || "{}").trim();
      // 모델이 코드펜스/설명을 섞어도 JSON만 최대한 추출
      const a = rawStr.indexOf("{");
      const b = rawStr.lastIndexOf("}");
      const jsonStr = a !== -1 && b !== -1 && b > a ? rawStr.slice(a, b + 1) : rawStr;
      const parsed = JSON.parse(jsonStr || "{}");
      if (Array.isArray(parsed.suggestions)) {
        suggestions = parsed.suggestions.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 3);
      }
    } catch {
      // ignore
    }

    
    }
// usage는 즉시 렌더링을 위해 함께 내려준다.
    try {
      if (debugReasons.length) {
        console.warn(`[send][${cid}][${reqId}] debug`, debugReasons);
      }
    } catch {
      // ignore
    }
    tEnd(tPost);
    tEnd(tSendTotal);
    attachServerTimings(latestUsage);
    const usageForClient = sanitizeUsageForViewer(latestUsage || null, canViewDeveloper);
    return NextResponse.json({
      chatId: cid,
      user: userMsg,
      assistant: assistantMsg,
      suggestions,
      usage: usageForClient,
      memoryRefresh,
      ...(canViewDeveloper ? { debugReasons } : {}),
    });
  } catch (e: any) {
    // 서버 로그에 남겨서 EC2 콘솔에서 바로 원인 확인 가능
    try {
      console.error("/api/chat/send error:", e?.message || e, e?.stack);
    } catch {
      // ignore
    }
    cleanupPendingUserOnFailure(_cidForLog);

    // 클라이언트에서는 원인 파악이 필요하므로 message를 함께 내려준다(민감정보는 포함하지 않음)
    const msg = String(e?.message || "요청 처리 중 오류가 발생했습니다.");
	    // (주의) 이 함수는 try 블록 내부에서만 타이머 헬퍼가 생성된다.
	    // 에러 상황에서는 타이머 종료를 강제하지 않고 서버 로그를 우선한다.
    // (안전) 가능한 경우 타이머 종료
    try {
      _tEnd(_tPost);
      _tEnd(_tSendTotal);
    } catch {
      // ignore
    }
    if (debugReasons.length) {
      console.warn(`[send][${_cidForLog}][${_reqIdForLog}] debug`, debugReasons);
    }
    return NextResponse.json(
      {
        error: "요청 처리 중 오류가 발생했습니다. 입력값/서버 로그를 확인해 주세요.",
        detail: msg,
      },
      { status: 500 }
    );
  }
}
