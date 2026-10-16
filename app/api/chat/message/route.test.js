/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const Database = require("better-sqlite3");
const root = path.resolve(__dirname, "../../../..");

function fixture(t, turns = 8) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY, userEmail TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chatId TEXT, role TEXT, content TEXT,
      imagesJson TEXT DEFAULT '', createdAt INTEGER, updatedAt INTEGER DEFAULT 0, userEmail TEXT);
    CREATE TABLE message_usage (messageId TEXT);
    CREATE TABLE chat_memory_cache (chatId TEXT PRIMARY KEY, recentSummary TEXT, summarizedEndTurn INTEGER,
      rolledUpCount INTEGER DEFAULT 0, lastSummarizedAt INTEGER DEFAULT 0, updatedAt INTEGER DEFAULT 0, recentSummaryChars INTEGER DEFAULT 0);
    CREATE TABLE chat_memory_blocks (chatId TEXT, startTurn INTEGER, endTurn INTEGER, summary TEXT);
    CREATE TABLE chat_character_turn_memories (chatId TEXT, turnNo INTEGER, summary TEXT);
    CREATE TABLE chat_character_facts (chatId TEXT, turnNo INTEGER, factValue TEXT);
    CREATE TABLE chat_character_events (chatId TEXT, messageId TEXT, turnNo INTEGER);
    CREATE TABLE chat_character_relations (chatId TEXT, lastSeenTurn INTEGER, slotKey TEXT);
    CREATE TABLE chat_character_affinity (chatId TEXT, lastTurnNo INTEGER, score INTEGER);
    CREATE TABLE chat_character_vitals (chatId TEXT, sourceOrder INTEGER);
    CREATE TABLE chat_spatial_states (chatId TEXT, sourceOrder INTEGER);
    CREATE TABLE chat_character_roster (chatId TEXT, enabled INTEGER);
    CREATE TABLE chat_settings (chatId TEXT, personaAge INTEGER, personaGender TEXT, personaInfo TEXT);
    INSERT INTO chats VALUES ('chat', 'owner'), ('other', 'other-owner');
  `);
  const insert = db.prepare("INSERT INTO messages (id, chatId, role, content, createdAt) VALUES (?, 'chat', ?, ?, ?)");
  for (let turn = 1; turn <= turns; turn++) {
    insert.run(`u${turn}`, "user", `질문 ${turn}`, turn * 2);
    insert.run(`a${turn}`, "assistant", `답변 ${turn}`, turn * 2 + 1);
    db.prepare("INSERT INTO chat_character_turn_memories VALUES ('chat', ?, ?)").run(turn, `기억 ${turn}`);
    db.prepare("INSERT INTO chat_character_facts VALUES ('chat', ?, ?)").run(turn, `사실 ${turn}`);
    db.prepare("INSERT INTO chat_character_events VALUES ('chat', ?, ?)").run(`a${turn}`, turn);
  }
  const summary = "## 장기 기억 (1-9턴)\n\n### 안전한 앞부분 (1-3턴)\n오래된 사건에서 인물들이 처음 만났다.\n\n### 유지할 기억 (4-6턴)\n안전한 사건에서 서로의 이름을 알게 되었다.\n\n### 삭제 영향 구간 (7-9턴)\n삭제한 이야기에서 새로운 장소로 이동했다.";
  db.prepare("INSERT INTO chat_memory_cache (chatId, recentSummary, summarizedEndTurn) VALUES ('chat', ?, 9)").run(summary);
  db.exec(`
    INSERT INTO chat_memory_blocks VALUES ('chat', 1, 3, 'safe'), ('chat', 4, 6, 'safe'), ('chat', 7, 9, 'deleted');
    INSERT INTO chat_character_relations VALUES ('chat', 7, 'structured:safe'), ('chat', 8, 'structured:deleted'), ('chat', 8, 'manual:keep');
    INSERT INTO chat_character_affinity VALUES ('chat', 7, 52), ('chat', 8, 53);
    INSERT INTO chat_character_vitals VALUES ('chat', 12), ('chat', 14);
    INSERT INTO chat_spatial_states VALUES ('chat', 12), ('chat', 14);
    INSERT INTO chat_character_facts VALUES ('other', 8, 'unrelated');
  `);
  const modules = new Map();
  const overrides = new Map([
    ["@/lib/db", { db }],
    ["@/lib/auth", { getSessionUser: async () => ({ email: "owner" }) }],
    ["@/lib/crypto", { decryptIfPossible: String, encryptIfPossible: String }],
    ["next/server", { NextResponse: { json: (body, options = {}) => ({ status: options.status || 200, body }) } }],
  ]);
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative);
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const loaded = { exports: {} };
    Function("require", "module", "exports", output)((id) => {
      if (overrides.has(id)) return overrides.get(id);
      if (id.startsWith("@/")) return load(`${id.slice(2)}.ts`);
      return require(id);
    }, loaded, loaded.exports);
    modules.set(relative, loaded.exports);
    return loaded.exports;
  }
  const route = load("app/api/chat/message/route.ts");
  const guard = load("lib/chat_history_guard.ts");
  const remove = (id) => route.DELETE(new Request(`http://localhost/api/chat/message?messageId=${id}`, { method: "DELETE" }));
  return { db, route, guard, remove, load, overrides };
}

test("undo removes the turn and its derived memory, preserving safe history and manual relations", async (t) => {
  const { db, remove } = fixture(t);
  const response = await remove("a8");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.deleted.sort(), ["a8", "u8"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 14);
  const cache = db.prepare("SELECT * FROM chat_memory_cache").get();
  assert.equal(cache.summarizedEndTurn, 6);
  assert.match(cache.recentSummary, /안전한 사건/);
  assert.doesNotMatch(cache.recentSummary, /삭제한 이야기/);
  assert.deepEqual(db.prepare("SELECT endTurn FROM chat_memory_blocks").all().map(r => r.endTurn), [3, 6]);
  for (const table of ["chat_character_turn_memories", "chat_character_facts", "chat_character_events"]) {
    assert.equal(db.prepare(`SELECT MAX(turnNo) AS n FROM ${table} WHERE chatId='chat'`).get().n, 7);
  }
  assert.deepEqual(db.prepare("SELECT slotKey FROM chat_character_relations").all().map(r => r.slotKey), ["structured:safe", "manual:keep"]);
  assert.deepEqual(db.prepare("SELECT lastTurnNo FROM chat_character_affinity").all(), [{ lastTurnNo: 7 }]);
  for (const table of ["chat_character_vitals", "chat_spatial_states"]) {
    assert.deepEqual(db.prepare(`SELECT sourceOrder FROM ${table}`).all(), [{ sourceOrder: 12 }]);
  }
  assert.equal(db.prepare("SELECT factValue FROM chat_character_facts WHERE chatId='other'").get().factValue, "unrelated");
  assert.equal((await remove("a8")).body.alreadyDeleted, true);
});

test("deleting a middle pair clears shifted later memory and supports legacy model replies", async (t) => {
  const { db, remove } = fixture(t);
  db.exec("UPDATE messages SET role='model' WHERE id='a4'");
  const response = await remove("u4");
  assert.deepEqual(response.body.deleted.sort(), ["a4", "u4"]);
  assert.equal(db.prepare("SELECT summarizedEndTurn FROM chat_memory_cache").get().summarizedEndTurn, 3);
  assert.equal(db.prepare("SELECT MAX(turnNo) AS n FROM chat_character_turn_memories").get().n, 3);
  assert.ok(db.prepare("SELECT id FROM messages WHERE id='a8'").get());
});

test("memory cleanup failure rolls back message deletion instead of reporting false success", async (t) => {
  const { db, remove } = fixture(t);
  db.exec("CREATE TRIGGER fail_memory BEFORE DELETE ON chat_character_facts BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END");
  const response = await remove("a8");
  assert.equal(response.status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 16);
  assert.equal(db.prepare("SELECT summarizedEndTurn FROM chat_memory_cache").get().summarizedEndTurn, 9);
  assert.equal(db.prepare("SELECT MAX(turnNo) AS n FROM chat_character_turn_memories").get().n, 8);
});

test("deleting an unanswered user turn preserves completed memory but clears its scene state", async (t) => {
  const { db, remove } = fixture(t);
  db.exec("INSERT INTO messages (id, chatId, role, content, createdAt) VALUES ('pending', 'chat', 'user', 'new scene', 20)");
  db.exec("INSERT INTO chat_spatial_states VALUES ('chat', 16)");
  const before = db.prepare("SELECT recentSummary FROM chat_memory_cache").get().recentSummary;
  await remove("pending");
  assert.equal(db.prepare("SELECT recentSummary FROM chat_memory_cache").get().recentSummary, before);
  assert.equal(db.prepare("SELECT MAX(turnNo) AS n FROM chat_character_turn_memories").get().n, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_spatial_states WHERE sourceOrder=16").get().n, 0);
});

test("late background results cannot resurrect deleted history, even when turn count is restored", async (t) => {
  const { db, guard, remove } = fixture(t);
  const snapshot = guard.captureChatHistory("chat");
  await remove("a8");
  db.exec("INSERT INTO messages (id, chatId, role, content, createdAt) VALUES ('replacement-u', 'chat', 'user', 'different', 18), ('replacement-a', 'chat', 'assistant', 'different', 19)");
  let wrote = false;
  assert.throws(() => guard.withCurrentChatHistory(snapshot, () => { wrote = true; }), guard.StaleChatHistoryError);
  assert.equal(wrote, false);
});

test("history guard allows appended turns but detects edits even with unchanged timestamps", (t) => {
  const { db, guard } = fixture(t);
  const snapshot = guard.captureChatHistory("chat");
  db.exec("INSERT INTO messages (id, chatId, role, content, createdAt) VALUES ('u9', 'chat', 'user', 'appended', 20)");
  assert.equal(guard.withCurrentChatHistory(snapshot, () => 42), 42);
  db.exec("UPDATE messages SET content='edited' WHERE id='u1'");
  assert.throws(() => guard.withCurrentChatHistory(snapshot, () => 42), guard.StaleChatHistoryError);
});

test("editing a past turn also invalidates dependent memory atomically", async (t) => {
  const { db, route } = fixture(t);
  const response = await route.PATCH(new Request("http://localhost/api/chat/message", {
    method: "PATCH", body: JSON.stringify({ messageId: "u8", content: "수정한 내용" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='u8'").get().content, "수정한 내용");
  assert.equal(db.prepare("SELECT MAX(turnNo) AS n FROM chat_character_turn_memories").get().n, 7);
});

test("relationship extraction finishing after undo is rejected before applying graph facts", async (t) => {
  const f = fixture(t, 5);
  let finish;
  let applied = false;
  f.overrides.set("@/lib/structured_relationship_memory", {
    extractStructuredCharacterGraph: () => new Promise(resolve => { finish = resolve; }),
    loadStructuredCharacterIdentities: () => [],
    applyStructuredCharacterGraph: () => { applied = true; return {}; },
  });
  f.overrides.set("@/lib/canonical_character_facts", {
    buildAuthoritativePersonaFacts: () => ({}), loadCanonicalCharacterFacts: () => [],
  });
  const refresh = f.load("lib/relationship_graph_refresh.ts");
  const pending = refresh.refreshRelationshipGraphIfDue({
    chatId: "chat", personaName: "주인공",
    messages: f.db.prepare("SELECT role, content FROM messages ORDER BY createdAt").all(),
    historySnapshot: f.guard.captureChatHistory("chat"),
  });
  assert.equal(typeof finish, "function");
  await f.remove("a5");
  finish({ ok: true, characters: [], relationships: [], facts: [] });
  await assert.rejects(pending, f.guard.StaleChatHistoryError);
  assert.equal(applied, false);
});
