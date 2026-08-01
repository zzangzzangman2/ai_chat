import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { generateText } from "@/lib/ai";
import {
  analyzeRelationshipCorrectionDrift,
  buildRelationshipCorrectionGuidance,
} from "@/lib/relationship_memory";
import {
  analyzeIdentityCanonDrift,
  buildIdentityCanonBlock,
  inferPersonaNameFromMessages,
} from "@/lib/identity_memory";
import {
  formatRelationshipGraphBlock,
  loadRelationshipGraph,
  resetCharacterAffinitiesForTurn,
  updateCharacterAffinity,
} from "@/lib/relationship_graph";
import { refreshRelationshipGraphIfDue } from "@/lib/relationship_graph_refresh";
import {
  inferCriticalCoreMemoryType,
  isCoreMemoryCandidate,
  isNearDuplicateMemory,
  isSaturatedMemoryTheme,
  clampMemoryImportance,
  normalizeCoreMemoryType,
  selectConservativeMemoryRows,
} from "@/lib/character_memory_quality";
import { bad, requireChatAccess } from "@/app/api/memory/_util";

type MsgRow = {
  id: string;
  role: string;
  content: string;
  createdAt: number;
};

function cleanText(v: unknown, max = 4000) {
  return String(v ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u001f]/g, (ch) => (ch === "\n" || ch === "\t" ? ch : ""))
    .trim()
    .slice(0, max);
}

function isAssistantRole(role: unknown) {
  const r = String(role || "").toLowerCase();
  return r === "assistant" || r === "model";
}

function assistantTurnNo(rows: MsgRow[], assistantId: string) {
  const firstUserPos = rows.findIndex((m) => String(m.role || "").toLowerCase() === "user");
  if (firstUserPos < 0) return 0;
  let turn = 0;
  for (let i = firstUserPos; i < rows.length; i++) {
    const row = rows[i];
    if (isAssistantRole(row.role)) turn += 1;
    if (String(row.id) === assistantId) return turn;
  }
  return 0;
}

function latestAssistantId(rows: MsgRow[]) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isAssistantRole(rows[i].role)) return String(rows[i].id || "");
  }
  return "";
}

function userBeforeAssistant(rows: MsgRow[], assistantId: string) {
  const idx = rows.findIndex((m) => String(m.id) === assistantId);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (String(rows[i].role || "").toLowerCase() === "user") return rows[i];
  }
  return null;
}

function extractJson(raw: string) {
  const src = String(raw || "").trim();
  if (!src) return null;
  try {
    return JSON.parse(src);
  } catch {}

  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const a = src.indexOf("[");
  const b = src.lastIndexOf("]");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(src.slice(a, b + 1));
    } catch {}
  }

  const oa = src.indexOf("{");
  const ob = src.lastIndexOf("}");
  if (oa >= 0 && ob > oa) {
    try {
      return JSON.parse(src.slice(oa, ob + 1));
    } catch {}
  }
  return null;
}

function asArray(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.characters)) return parsed.characters;
  if (Array.isArray(parsed?.items)) return parsed.items;
  return [];
}

function hasBatchim(s: string) {
  const ch = String(s || "").trim().slice(-1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function withParticle(name: string, pair: "은는" | "이가" | "을를" | "과와") {
  const n = String(name || "").trim();
  if (!n) return "";
  const batchim = hasBatchim(n);
  if (pair === "은는") return n + (batchim ? "은" : "는");
  if (pair === "이가") return n + (batchim ? "이" : "가");
  if (pair === "을를") return n + (batchim ? "을" : "를");
  return n + (batchim ? "과" : "와");
}

// (최적화) Persona-ref replacer를 personaName별로 캐싱. 39 regex/호출 → 39 regex/persona (1회).
const personaRefReplacerCache = new Map<string, (t: string) => string>();
function getPersonaRefReplacer(personaName: string): (t: string) => string {
  const name = String(personaName || "").trim();
  if (!name) return (s) => String(s || "");
  const cached = personaRefReplacerCache.get(name);
  if (cached) return cached;
  const replacements: Array<[RegExp, string]> = [];
  for (const ref of ["사용자", "주인공", "플레이어"]) {
    replacements.push([new RegExp(`${ref}와`, "g"), withParticle(name, "과와")]);
    replacements.push([new RegExp(`${ref}과`, "g"), withParticle(name, "과와")]);
    replacements.push([new RegExp(`${ref}는`, "g"), withParticle(name, "은는")]);
    replacements.push([new RegExp(`${ref}은`, "g"), withParticle(name, "은는")]);
    replacements.push([new RegExp(`${ref}가`, "g"), withParticle(name, "이가")]);
    replacements.push([new RegExp(`${ref}이`, "g"), withParticle(name, "이가")]);
    replacements.push([new RegExp(`${ref}를`, "g"), withParticle(name, "을를")]);
    replacements.push([new RegExp(`${ref}을`, "g"), withParticle(name, "을를")]);
    replacements.push([new RegExp(`${ref}에게`, "g"), `${name}에게`]);
    replacements.push([new RegExp(`${ref}한테`, "g"), `${name}한테`]);
    replacements.push([new RegExp(`${ref}로부터`, "g"), `${name}로부터`]);
    replacements.push([new RegExp(`${ref}의`, "g"), `${name}의`]);
    replacements.push([new RegExp(ref, "g"), name]);
  }
  const replacer = (text: string) => {
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

function replaceGenericPersonaRefs(text: string, personaName: string) {
  return getPersonaRefReplacer(personaName)(text);
}

function escapeRegExp(s: string) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAliases(raw: unknown) {
  const text = decryptIfPossible(String(raw || "")).trim();
  if (!text) return [] as string[];

  const values: string[] = [];
  const add = (value: unknown) => {
    const name = cleanText(value, 80);
    if (name) values.push(name);
  };

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) parsed.forEach(add);
    else if (Array.isArray(parsed?.aliases)) parsed.aliases.forEach(add);
  } catch {}

  text.split(/[\n,;\/|]+/g).forEach(add);
  return Array.from(new Set(values));
}

function characterNames(row: any) {
  return Array.from(new Set([cleanText(row?.name, 80), ...parseAliases(row?.aliases)].filter(Boolean))).sort(
    (a, b) => b.length - a.length
  );
}

function textHasCharacterName(text: unknown, names: string[]) {
  const src = String(text || "");
  if (!src.trim()) return false;

  return names.some((name) => {
    if (!name) return false;
    if (/^[A-Za-z0-9_ .'-]+$/.test(name)) {
      return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}($|[^A-Za-z0-9_])`, "i").test(src);
    }
    return src.includes(name);
  });
}

function hasSpeakerLine(text: unknown, names: string[]) {
  const lines = String(text || "").split(/\n+/g);
  return lines.some((line) =>
    names.some((name) =>
      new RegExp(`^\\s*[\\[【(（]?\\s*${escapeRegExp(name)}\\s*[\\]】)）]?\\s*(?:[:：|]|[-=]+>|→)`, "i").test(
        line
      )
    )
  );
}

function hasQuotedSpeechNearName(text: unknown, names: string[]) {
  const quoteRe = /["“”「」『』]/;
  const speechVerbRe = /(말해|말했|말하|물어|물었|묻|대답|답했|질문|속삭|외치|소리쳤|중얼|인사|대꾸|불러|불렀|부르)/;
  const hasSpeech = (value: string) => quoteRe.test(value) || speechVerbRe.test(value);
  const blocks = String(text || "")
    .split(/\n\s*\n+/g)
    .map((block) => block.trim())
    .filter(Boolean);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!textHasCharacterName(block, names)) continue;
    if (hasSpeech(block) || hasSpeech(blocks[i - 1] || "") || hasSpeech(blocks[i + 1] || "")) return true;
  }

  return String(text || "")
    .split(/\n+/g)
    .some((line) => textHasCharacterName(line, names) && (quoteRe.test(line) || speechVerbRe.test(line)));
}

function isDirectPersonaCharacterConversation(row: any, userText: unknown, assistantText: unknown) {
  if (!cleanText(userText, 3000)) return false;
  const names = characterNames(row);
  if (!names.length) return false;
  return hasSpeakerLine(assistantText, names) || hasQuotedSpeechNearName(assistantText, names);
}

function deterministicConversationItem(
  row: any,
  userText: unknown,
  assistantText: unknown,
  personaName: string
) {
  const id = String(row?.id || "").trim();
  const name = cleanText(row?.name, 80);
  if (!id || !name || !isDirectPersonaCharacterConversation(row, userText, assistantText)) return null;

  const userSnippet = oneSentenceSummary(userText, personaName) || "대화를 건 일";
  const evidenceBlock = String(assistantText || "")
    .split(/\n\s*\n+/g)
    .map((block) => block.trim())
    .find((block) => textHasCharacterName(block, characterNames(row)));
  const evidence = cleanText(
    (evidenceBlock || String(assistantText || ""))
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/[*_`#>]/g, " ")
      .replace(/\s+/g, " "),
    300
  );

  return {
    id,
    present: true,
    shouldRemember: false,
    memoryType: "unresolved",
    importance: 1,
    summary: `${name}은 ${personaName}의 ${userSnippet}에 직접 반응하며 대화를 이어갔어.`,
    evidence,
    affinityDelta: 0,
    affinityReason: "자동 복구된 직접 대화라 호감도 변화는 보류",
    deterministicFallback: true,
  };
}

function oneSentenceSummary(text: unknown, personaName: string) {
  let out = cleanText(replaceGenericPersonaRefs(String(text || ""), personaName), 500)
    .replace(/\s+/g, " ")
    .replace(/^[\s\-*•\d.)]+/, "")
    .trim();
  const first = out.match(/^(.+?[.!?。！？…]+)(?:\s+|$)/);
  if (first?.[1]) out = first[1].trim();
  if (out.length > 220) out = out.slice(0, 220).trim();
  return out;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = String(body?.chatId || "").trim();
    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const all = db
      .prepare(`SELECT id, role, content, createdAt FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC`)
      .all(chatId)
      .map((row: any) => ({
        id: String(row?.id || ""),
        role: String(row?.role || ""),
        content: decryptIfPossible(String(row?.content || "")),
        createdAt: Number(row?.createdAt || 0),
      })) as MsgRow[];

    const requestedAssistantId = String(body?.assistantMessageId || "").trim();
    const assistantId = requestedAssistantId || latestAssistantId(all);
    if (!assistantId) return NextResponse.json({ ok: true, skipped: true, reason: "no_assistant" });

    const assistant = all.find((m) => String(m.id) === assistantId && isAssistantRole(m.role));
    if (!assistant) return NextResponse.json({ ok: true, skipped: true, reason: "assistant_not_found" });

    const turnNo = assistantTurnNo(all, assistantId);
    if (turnNo <= 0) return NextResponse.json({ ok: true, skipped: true, reason: "no_turn_no" });

    const settings = db.prepare(`SELECT personaName FROM chat_settings WHERE chatId=?`).get(chatId) as any;
    const configuredPersonaName = cleanText(settings?.personaName, 80);
    const inferredPersonaName = configuredPersonaName
      ? ""
      : inferPersonaNameFromMessages(all);
    const personaName = configuredPersonaName || inferredPersonaName || "나";

    const relationshipGraphRefresh = await refreshRelationshipGraphIfDue({
      chatId,
      personaName,
      messages: all,
    });

    const rosterAll = db
      .prepare(
        `SELECT id, name, aliases, role, profile, relationshipNote, emotionNote, status
         FROM chat_character_roster
         WHERE chatId=? AND enabled != 0
         ORDER BY updatedAt DESC, name ASC
         LIMIT 40`
      )
      .all(chatId) as any[];
    const identityCharacterSources = rosterAll.map((row) => ({
      name: String(row?.name || ""),
      role: decryptIfPossible(String(row?.role || "")),
      profile: decryptIfPossible(String(row?.profile || "")),
      relationshipNote: decryptIfPossible(String(row?.relationshipNote || "")),
      emotionNote: decryptIfPossible(String(row?.emotionNote || "")),
      status: decryptIfPossible(String(row?.status || "")),
    }));
    const identityCanon = buildIdentityCanonBlock({
      messages: all,
      knownNames: rosterAll.flatMap((row) => characterNames(row)),
      personaName,
      characterSources: identityCharacterSources,
    });
    const personaKey = personaName.toLowerCase();
    const roster = rosterAll.filter(
      (row) => !characterNames(row).some((name) => name.toLowerCase() === personaKey)
    );

    if (!roster.length) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "no_registered_characters",
        turnNo,
        relationshipGraphRefresh,
      });
    }

    const prevUser = userBeforeAssistant(all, assistantId);
    const sceneText = [
      prevUser ? `[${personaName} 입력]\n${cleanText(prevUser.content, 3000)}` : "",
      `[어시스턴트 응답]\n${cleanText(assistant.content, 7000)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const priorMemoryRows = (
      db
        .prepare(
          `SELECT rosterId, turnNo, summary, evidence
           FROM chat_character_turn_memories
           WHERE chatId=? AND turnNo<?
           ORDER BY rosterId ASC, turnNo ASC`
        )
        .all(chatId, turnNo) as Array<{
          rosterId?: unknown;
          turnNo?: unknown;
          summary?: unknown;
          evidence?: unknown;
        }>
    ).map((memory) => ({
      rosterId: String(memory?.rosterId || ""),
      turnNo: Number(memory?.turnNo || 0),
      summary: decryptIfPossible(String(memory?.summary || "")),
      evidence: decryptIfPossible(String(memory?.evidence || "")),
    }));
    const recentMemoriesByRoster = new Map<string, typeof priorMemoryRows>();
    for (const memory of priorMemoryRows) {
      const rows = recentMemoriesByRoster.get(memory.rosterId) || [];
      rows.push(memory);
      recentMemoriesByRoster.set(memory.rosterId, rows);
    }
    const coreContextByRoster = new Map<string, typeof priorMemoryRows>();
    for (const memory of selectConservativeMemoryRows(priorMemoryRows)) {
      const rows = coreContextByRoster.get(memory.rosterId) || [];
      rows.push(memory);
      coreContextByRoster.set(memory.rosterId, rows);
    }

    const characterList = roster
      .map((r: any, i: number) => {
        const existingCoreMemories = (coreContextByRoster.get(String(r.id || "")) || [])
          .map((memory) => ({
            turn: memory.turnNo,
            summary: cleanText(memory.summary, 240),
          }));
        const fields = [
          `id: ${String(r.id)}`,
          `name: ${String(r.name || "")}`,
          `aliases: ${decryptIfPossible(String(r.aliases || ""))}`,
          `role: ${decryptIfPossible(String(r.role || ""))}`,
          `profile: ${decryptIfPossible(String(r.profile || "")).slice(0, 400)}`,
          `existing_core_memories: ${JSON.stringify(existingCoreMemories)}`,
        ];
        return `${i + 1}. ${fields.join(" | ")}`;
      })
      .join("\n");

    const system = [
      "You update a Korean novel-chat character encounter ledger.",
      "Registered characters are memory targets, but a name mention, presence, action, or reaction alone is not a saved encounter.",
      "This ledger keeps both durable long-term memory and a compact episodic history of direct conversations.",
      "A direct conversation can have present=true while shouldRemember=false; still provide an accurate one-sentence candidate summary so the server can keep it as recent episodic history.",
      "Set shouldRemember=true only for a new durable identity fact, relationship/title change, promise/secret/debt, major event with lasting consequence, persistent status change, or important unresolved issue.",
      "Routine questions, greetings, compliments, jokes, ordinary actions, and repeated anger/fear/insults/pleas/refusals must have shouldRemember=false.",
      "Compare with existing_core_memories. If the new turn merely repeats an already stored fact, event, emotional stance, threat, or conflict, set shouldRemember=false.",
      "For a continuing major incident, save the first meaningful onset and a later material outcome only, not every intermediate reaction.",
      "Save a character only when the persona and that character directly exchange dialogue in this exact turn.",
      "The ledger is chronological. Each saved item describes only the current turn and must not mix events from other turns.",
      "Every registered character is an isolated memory owner. Never copy a relationship, title, promise, emotion, or dialogue style from another character.",
      "A title used by one character never becomes a title that another character may use.",
      "If the persona corrects or denies a relationship/title, that correction overrides the assistant response and must remain negated.",
      identityCanon.block,
      formatRelationshipGraphBlock(loadRelationshipGraph(chatId)),
      "The saved relationship graph is a continuity constraint. Use it to keep family roles, narrative relationship type, age, and affinity attached to the correct character.",
      "Do not claim an older graph fact happened in this exact turn unless the exact-turn scene text supports it.",
      "For each saved direct conversation, estimate only THIS TURN's change in the character's affinity toward the persona.",
      "affinityDelta must be an integer from -3 to 3. Use 0 when the exchange does not clearly change affinity.",
      "Do not infer affinity change from mere presence, narration, coercion, or dialogue with somebody else.",
      "Write summaries in Korean casual banmal ending with forms like ~했어, ~하고 있어, ~보였어. Do not use formal endings like ~합니다, ~했습니다, ~습니다.",
      `The persona/user/player name is "${personaName}". Always refer to the persona as "${personaName}", never as 사용자, 주인공, or 플레이어.`,
      `Focus only on direct conversation between ${personaName} and the character, because this memory will be used later to remember their shared history.`,
      "Return JSON only.",
    ].join("\n");

    const user = [
      "[Registered Characters]",
      characterList,
      "",
      `[Turn ${turnNo}]`,
      `[Persona Name]\n${personaName}`,
      "",
      sceneText,
      "",
      "Task:",
      `- Decide which registered characters directly conversed with ${personaName} in this turn.`,
      `- Save ONLY characters who exchanged dialogue with ${personaName}: ${personaName} addressed them and/or they replied to ${personaName}.`,
      "- For every directly conversing character, set present=true and independently decide shouldRemember.",
      "- DO NOT save a character if they are only mentioned, remembered, compared, planned to meet, referred to in rumor/history, named while absent, merely present, acting, reacting, or described without direct dialogue.",
      "- If ambiguous, omit the character.",
      "- shouldRemember=true only when this turn adds information that must still matter tens or hundreds of turns later.",
      "- Valid memoryType values: identity, relationship, commitment, major_event, status_change, unresolved, none.",
      "- importance: 0=no memory, 1=minor/temporary, 2=durable and useful, 3=critical continuity fact.",
      "- Only importance 2 or 3 may have shouldRemember=true. Use memoryType=none and importance 0 for ordinary or repeated exchanges.",
      "- A new name/age/family/job, marriage/breakup/friendship/enmity change, explicit promise/secret, arrest/injury/move, or an unresolved consequential decision can be remembered.",
      "- Repeated insults, fear, anger, pleas, rejection, questioning, staring, crying, or the next step of the same ongoing confrontation are not new long-term memories.",
      "- If shouldRemember=true, summarize THIS TURN ONLY and state the new durable fact or consequence rather than decorative actions.",
      "- Always provide a one-sentence candidate summary even when shouldRemember=false; the server independently checks critical facts so important continuity is not lost.",
      `- In summary/evidence, write the persona as "${personaName}". Do not write 사용자, 주인공, or 플레이어.`,
      `- Prioritize durable relationship change, newly revealed identity, commitment, consequence, current status, or unresolved tension involving ${personaName}.`,
      "- Keep each character's relationship and titles local to that character's JSON item; never borrow them from another registered character.",
      "- A latest persona correction outranks contradictory wording in the assistant response.",
      buildRelationshipCorrectionGuidance(sceneText),
      "- affinityDelta means the saved character's feeling toward the persona after this exact exchange: -3 major decrease, -2 decrease, -1 slight decrease, 0 unchanged, +1 slight increase, +2 increase, +3 major increase.",
      "- affinityReason must be a short Korean phrase grounded only in this turn's direct exchange.",
      "- Include the turn's order implicitly by writing it as a result of this exact turn; do not imply a later turn happened before an earlier turn.",
      "- When shouldRemember=true, summary must be exactly ONE Korean casual banmal sentence, no second sentence, and should naturally end in banmal such as ~했어/~있어/~보였어.",
      "- Avoid formal endings like 합니다/했습니다/습니다 and avoid detached report endings like 함/했다 when possible.",
      "",
      "Return JSON array:",
      `[{"id":"registered id","present":true,"shouldRemember":true,"memoryType":"relationship","importance":2,"summary":"새로 생긴 핵심 관계 변화나 지속 사실을 담은 한국어 반말 한 문장","evidence":"short Korean evidence from this turn","affinityDelta":0,"affinityReason":"이 턴에서 호감도가 변한 직접 근거"}]`,
      "No markdown. No extra text.",
    ].join("\n");

    const model = String(process.env.CHARACTER_TURN_MEMORY_MODEL || "gemini-3.6-flash").trim();
    let parsed: any = null;
    let generationError = "";
    try {
      const r = await generateText({
        system,
        user,
        opts: {
          model,
          maxOutputTokens: 2048,
          maxReasoningTokens: 0,
          thinkingBudget: 0,
          temperature: 0.1,
          topP: 0.8,
        },
      });
      parsed = extractJson(String(r?.text || ""));
      if (!parsed) generationError = "no_memory_json";
    } catch (error: any) {
      generationError = cleanText(error?.message || "character_memory_generation_failed", 300);
    }

    const items = asArray(parsed);
    let deterministicFallbackCount = 0;
    if (prevUser) {
      for (const row of roster) {
        const fallback = deterministicConversationItem(
          row,
          prevUser.content,
          assistant.content,
          personaName
        );
        if (!fallback) continue;
        const existingIndex = items.findIndex(
          (item) => String(item?.id || "").trim() === fallback.id
        );
        if (existingIndex >= 0 && items[existingIndex]?.present === true) continue;
        if (existingIndex >= 0) items.splice(existingIndex, 1, fallback);
        else items.push(fallback);
        deterministicFallbackCount += 1;
      }
    }

    if (!items.length) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: generationError || "no_direct_character_conversation",
        turnNo,
        evaluated: 0,
        saved: 0,
        items: [],
        deterministicFallbackCount,
      });
    }
    const rosterById = new Map(roster.map((row: any) => [String(row.id || ""), row]));
    const now = Date.now();
    let saved = 0;
    let evaluated = 0;
    const savedItems: any[] = [];

    // (최적화) DELETE + INSERT 루프를 단일 트랜잭션으로 묶어 fsync per row 회피.
    const insertStmt = db.prepare(
      `INSERT INTO chat_character_turn_memories
         (chatId, rosterId, characterName, turnNo, summary, evidence, memoryType, importance, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chatId, rosterId, turnNo) DO UPDATE SET
         characterName=excluded.characterName,
         summary=excluded.summary,
         evidence=excluded.evidence,
         memoryType=excluded.memoryType,
         importance=excluded.importance,
         updatedAt=excluded.updatedAt`
    );
    const deleteStmt = db.prepare(`DELETE FROM chat_character_turn_memories WHERE chatId=? AND turnNo=?`);
    resetCharacterAffinitiesForTurn(chatId, turnNo);
    const writeAll = db.transaction((entries: any[]) => {
      deleteStmt.run(chatId, turnNo);
      for (const item of entries) {
        const id = String(item?.id || "").trim();
        const row = rosterById.get(id);
        if (!row) continue;
        if (item?.present !== true) continue;
        if (!prevUser || !isDirectPersonaCharacterConversation(row, prevUser.content, assistant.content)) continue;

        const evidence = cleanText(replaceGenericPersonaRefs(item?.evidence, personaName), 500);
        const name = String(row?.name || "").trim();
        const affinity = updateCharacterAffinity({
          chatId,
          rosterId: id,
          personaName,
          characterName: name,
          turnNo,
          delta: Number(item?.affinityDelta || 0),
          reason: cleanText(item?.affinityReason, 500),
          evidence,
        });
        evaluated += 1;

        const summary = oneSentenceSummary(item?.summary, personaName);
        if (!summary) continue;
        const modelMemoryType = normalizeCoreMemoryType(item?.memoryType);
        const fallbackMemoryType = inferCriticalCoreMemoryType(
          `${summary} ${evidence}`
        );
        let memoryType =
          fallbackMemoryType !== "none" ? fallbackMemoryType : modelMemoryType;
        const serverRecovered = fallbackMemoryType !== "none";
        const modelImportance = clampMemoryImportance(item?.importance);
        const durableRequested = item?.shouldRemember === true || serverRecovered;
        let importance = Math.max(
          modelImportance,
          serverRecovered ? 3 : 0
        );
        const durable =
          durableRequested &&
          isCoreMemoryCandidate({
            memoryType,
            importance,
            summary,
            evidence,
          });

        // 직접 대화가 실제로 있었지만 영구 정사 기준에는 못 미친 턴도
        // 최근 에피소드 기억으로 보존한다. 중요도 1은 UI와 최근 연속성에만
        // 사용하고, 오래 유지할 핵심 정사(2~3)와 구분한다.
        if (!durable) {
          importance = 1;
          if (memoryType === "none") memoryType = "unresolved";
        }
        const recentRows = recentMemoriesByRoster.get(id) || [];
        const recentMemoryTexts = recentRows.map(
          (memory) => `${memory.summary} ${memory.evidence}`
        );
        if (
          durable &&
          memoryType === "major_event" &&
          isSaturatedMemoryTheme(
            `${summary} ${evidence}`,
            recentMemoryTexts,
            2
          )
        ) {
          continue;
        }
        if (
          isNearDuplicateMemory(
            summary,
            recentRows.map((memory) => memory.summary)
          )
        ) {
          continue;
        }
        const relationshipDrift = analyzeRelationshipCorrectionDrift(sceneText, summary);
        if (!relationshipDrift.ok) continue;
        const identityDrift = analyzeIdentityCanonDrift({
          sourceText: sceneText,
          summary,
          canon: identityCanon.canon,
        });
        if (!identityDrift.ok) continue;

        insertStmt.run(
          chatId,
          id,
          name,
          turnNo,
          encryptIfPossible(summary),
          encryptIfPossible(evidence),
          memoryType,
          importance,
          now,
          now
        );
        recentRows.push({ rosterId: id, turnNo, summary, evidence });
        recentMemoriesByRoster.set(id, recentRows);
        saved += 1;
        savedItems.push({
          id,
          name,
          turnNo,
          summary,
          evidence,
          memoryType,
          importance,
          affinity,
        });
      }
    });
    writeAll(items);

    return NextResponse.json({
      ok: true,
      turnNo,
      evaluated,
      saved,
      items: savedItems,
      deterministicFallbackCount,
      generationError: generationError || undefined,
    });
  } catch (e: any) {
    console.error("/api/chat/characters/refresh error", e);
    return bad(e?.message || "character_refresh_failed", 500);
  }
}
