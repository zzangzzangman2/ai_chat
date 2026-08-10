import { stripUrlsAndMediaMarkdown } from "@/lib/memory_sanitize";
import { GEMINI_3_FLASH_MODEL } from "@/lib/models";
import {
  applyStructuredCharacterGraph,
  extractStructuredCharacterGraph,
  loadStructuredCharacterIdentities,
} from "@/lib/structured_relationship_memory";
import { db } from "@/lib/db";
import { selectMessagesForAssistantTurnRange } from "@/app/api/chat/send/_server/turnRange";
import {
  buildAuthoritativePersonaFacts,
  loadCanonicalCharacterFacts,
} from "@/lib/canonical_character_facts";

const RELATIONSHIP_REFRESH_EVERY_TURNS = 5;
const RELATIONSHIP_BOOTSTRAP_WINDOW_TURNS = 12;

type RelationshipRefreshMessage = {
  role: string;
  content: string;
};

export type RelationshipGraphRefreshResult = {
  attempted: boolean;
  reason:
    | "refreshed"
    | "not_due"
    | "not_enough_turns"
    | "already_attempted"
    | "empty_window"
    | "extract_failed";
  turnNo: number;
  windowStartTurn: number;
  windowEndTurn: number;
  charactersAdded: string[];
  aliasesUpdated: string[];
  relationshipsUpserted: number;
  factsUpserted: number;
};

const lastAttemptedTurnByChat = new Map<string, number>();

function completedAssistantTurnCount(messages: RelationshipRefreshMessage[]) {
  const firstUserPos = messages.findIndex(
    (message) => String(message?.role || "").toLowerCase() === "user"
  );
  if (firstUserPos < 0) return 0;

  let count = 0;
  for (let index = firstUserPos; index < messages.length; index += 1) {
    const role = String(messages[index]?.role || "").toLowerCase();
    if (role === "assistant" || role === "model") count += 1;
  }
  return count;
}

function enabledRosterCount(chatId: string) {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM chat_character_roster
           WHERE chatId=? AND enabled != 0`
        )
        .get(chatId) as { count?: unknown } | undefined
    )?.count || 0
  );
}

export function shouldRefreshRelationshipGraph(params: {
  turnNo: number;
  rosterCount: number;
}) {
  const turnNo = Math.max(0, Math.trunc(Number(params.turnNo || 0)));
  if (turnNo < RELATIONSHIP_REFRESH_EVERY_TURNS) return false;
  return (
    Number(params.rosterCount || 0) === 0 ||
    turnNo % RELATIONSHIP_REFRESH_EVERY_TURNS === 0
  );
}

function formatGraphWindow(messages: RelationshipRefreshMessage[]) {
  return messages
    .map((message) => {
      const role = String(message?.role || "").toLowerCase();
      const tag = role === "user" ? "[사용자]" : "[어시스턴트]";
      return `${tag} ${String(message?.content || "")}`;
    })
    .join("\n\n");
}

function result(
  reason: RelationshipGraphRefreshResult["reason"],
  turnNo: number,
  windowStartTurn = 0,
  windowEndTurn = turnNo
): RelationshipGraphRefreshResult {
  return {
    attempted: reason === "refreshed" || reason === "extract_failed",
    reason,
    turnNo,
    windowStartTurn,
    windowEndTurn,
    charactersAdded: [],
    aliasesUpdated: [],
    relationshipsUpserted: 0,
    factsUpserted: 0,
  };
}

export async function refreshRelationshipGraphIfDue(params: {
  chatId: string;
  personaName: string;
  messages: RelationshipRefreshMessage[];
  signal?: AbortSignal;
}): Promise<RelationshipGraphRefreshResult> {
  const chatId = String(params.chatId || "").trim();
  const personaName = String(params.personaName || "").trim() || "나";
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const turnNo = completedAssistantTurnCount(messages);
  if (turnNo < RELATIONSHIP_REFRESH_EVERY_TURNS) {
    return result("not_enough_turns", turnNo);
  }

  const rosterCount = enabledRosterCount(chatId);
  if (!shouldRefreshRelationshipGraph({ turnNo, rosterCount })) {
    return result("not_due", turnNo);
  }

  // The character-refresh endpoint and relationship panel can run together.
  // Avoid charging for the same graph extraction twice in one completed turn.
  if (lastAttemptedTurnByChat.get(chatId) === turnNo) {
    return result("already_attempted", turnNo);
  }
  lastAttemptedTurnByChat.set(chatId, turnNo);
  if (lastAttemptedTurnByChat.size > 200) {
    const oldestChatId = lastAttemptedTurnByChat.keys().next().value;
    if (oldestChatId) lastAttemptedTurnByChat.delete(oldestChatId);
  }

  const windowTurnCount =
    rosterCount === 0
      ? Math.min(RELATIONSHIP_BOOTSTRAP_WINDOW_TURNS, turnNo)
      : RELATIONSHIP_REFRESH_EVERY_TURNS;
  const windowStartTurn = Math.max(1, turnNo - windowTurnCount + 1);
  const range = selectMessagesForAssistantTurnRange(
    messages,
    windowStartTurn,
    turnNo
  ) as RelationshipRefreshMessage[];
  const rawWindowText = stripUrlsAndMediaMarkdown(formatGraphWindow(range));
  if (!rawWindowText.trim()) {
    return result("empty_window", turnNo, windowStartTurn);
  }

  const graph = await extractStructuredCharacterGraph({
    rawWindowText,
    personaName,
    existingCharacters: loadStructuredCharacterIdentities(chatId),
    existingFacts: loadCanonicalCharacterFacts(chatId),
    authoritativePersona: (() => {
      const settings = db
        .prepare(
          `SELECT personaAge, personaGender, personaInfo FROM chat_settings WHERE chatId=?`
        )
        .get(chatId) as Record<string, unknown> | undefined;
      return buildAuthoritativePersonaFacts({
        name: personaName,
        age: settings?.personaAge,
        gender: settings?.personaGender,
        info: settings?.personaInfo,
      });
    })(),
    llmOpts: {
      model:
        String(process.env.LONG_MEMORY_SUMMARY_MODEL || "").trim() ||
        GEMINI_3_FLASH_MODEL,
      maxOutputTokens: 4096,
      maxReasoningTokens: 128,
      thinkingBudget: 128,
      signal: params.signal,
    },
    windowStartTurn,
    windowEndTurn: turnNo,
  });
  if (!graph.ok) {
    return result("extract_failed", turnNo, windowStartTurn);
  }

  const applied = applyStructuredCharacterGraph({
    chatId,
    personaName,
    graph,
    turnNo,
  });
  return {
    attempted: true,
    reason: "refreshed",
    turnNo,
    windowStartTurn,
    windowEndTurn: turnNo,
    charactersAdded: applied.charactersAdded,
    aliasesUpdated: applied.aliasesUpdated,
    relationshipsUpserted: applied.relationshipsUpserted,
    factsUpserted: applied.factsUpserted,
  };
}
