const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const Database = require("better-sqlite3");

function transpile(relativePath, customRequire) {
  const source = fs.readFileSync(relativePath, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const moduleObj = { exports: {} };
  new Function("require", "module", "exports", js)(customRequire, moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

const realRequire = require;
const direction = transpile("lib/relationship_direction.ts", realRequire);
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE chat_character_roster (
    id TEXT PRIMARY KEY, chatId TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT '', relationshipNote TEXT NOT NULL DEFAULT '',
    emotionNote TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(chatId, name)
  );
  CREATE TABLE chat_character_relations (
    id TEXT PRIMARY KEY, chatId TEXT NOT NULL, subjectKey TEXT NOT NULL, subjectName TEXT NOT NULL DEFAULT '',
    relation TEXT NOT NULL, slotKey TEXT NOT NULL DEFAULT 'default', objectKey TEXT NOT NULL,
    objectName TEXT NOT NULL DEFAULT '', objectRole TEXT NOT NULL DEFAULT '', knownBy TEXT NOT NULL DEFAULT '[]',
    knowledgeEvidence TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', sourceRole TEXT NOT NULL DEFAULT '',
    addressSpeakerKey TEXT NOT NULL DEFAULT '', addressSpeakerName TEXT NOT NULL DEFAULT '',
    addressTargetKey TEXT NOT NULL DEFAULT '', addressTargetName TEXT NOT NULL DEFAULT '', addressTerm TEXT NOT NULL DEFAULT '',
    sourceOrder INTEGER NOT NULL DEFAULT 0, firstSeenTurn INTEGER NOT NULL DEFAULT 0,
    lastSeenTurn INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    UNIQUE(chatId, subjectKey, relation, slotKey)
  );
`);

const customRequire = (id) => {
  if (id === "@/lib/ai") return { generateText: async () => ({ text: "{}" }) };
  if (id === "@/lib/crypto") return { decryptIfPossible: String, encryptIfPossible: String };
  if (id === "@/lib/db") return { db };
  if (id === "@/lib/relationship_context") {
    return { inferCharacterOccupation: () => "", isValidDescriptiveRelationship: () => true };
  }
  if (id === "@/lib/character_knowledge") {
    return { parseRelationshipKnownBy: (value) => { try { return JSON.parse(String(value || "[]")); } catch { return []; } } };
  }
  if (id === "@/lib/canonical_character_facts") {
    return {
      CANONICAL_FACT_KEYS: [],
      canonicalFactConflictsWithPersona: () => false,
      storeCanonicalFactObservations: () => 0,
    };
  }
  if (id === "@/lib/relationship_memory") return { stripFencedBlocks: String };
  if (id === "@/lib/relationship_direction") return direction;
  if (id === "@/lib/durable_character_state") return transpile("lib/durable_character_state.ts", realRequire);
  return realRequire(id);
};

const structured = transpile("lib/structured_relationship_memory.ts", customRequire);
const baseGraph = { ok: true, characters: [], facts: [] };
const userDirection = {
  sourceId: "persona", targetId: "target", sourceName: "주인공", targetName: "상대",
  // Use a supported structural relation so the test reaches the direction guard.
  relation: "선배", details: "주인공이 상대를 선배님이라고 부른다", evidence: "선배님, 말씀하세요",
  sourceRole: "user", addressSpeakerId: "persona", addressSpeakerName: "주인공",
  addressTargetId: "target", addressTargetName: "상대", addressTerm: "선배님",
  knownByNames: ["주인공", "상대"], knowledgeEvidence: "선배님, 말씀하세요",
};

assert.equal(structured.applyStructuredCharacterGraph({
  chatId: "chat", personaName: "주인공", graph: { ...baseGraph, relationships: [userDirection] }, turnNo: 10,
}).relationshipsUpserted, 1);
let rows = db.prepare("SELECT * FROM chat_character_relations").all();
assert.equal(rows.length, 1);
assert.equal(rows[0].addressSpeakerKey, "persona");
assert.equal(rows[0].addressTargetKey, "name:상대");
assert.equal(rows[0].sourceRole, "user");

const reversedAssistant = {
  ...userDirection,
  sourceName: "상대", targetName: "주인공", relation: "선배",
  details: "상대가 주인공을 선배님이라고 부른다", evidence: "잘못된 AI 문장", sourceRole: "assistant",
  addressSpeakerName: "상대", addressTargetName: "주인공",
};
assert.equal(structured.applyStructuredCharacterGraph({
  chatId: "chat", personaName: "주인공", graph: { ...baseGraph, relationships: [reversedAssistant] }, turnNo: 20,
}).relationshipsUpserted, 0);
rows = db.prepare("SELECT * FROM chat_character_relations").all();
assert.equal(rows.length, 1);
assert.equal(rows[0].addressSpeakerName, "주인공");
assert.equal(rows[0].addressTargetName, "상대");

for (const turnNo of [3, 500]) {
  assert.equal(structured.applyStructuredCharacterGraph({
    chatId:"coerced",personaName:"주인공",turnNo,
    graph:{...baseGraph,relationships:[{...userDirection,sourceRole:"assistant",relation:"부하 직원",
      evidence:"상대는 주인공을 두려워해 고개를 숙이고 짐을 옮겼다.",
      addressTerm:"",addressSpeakerName:"",addressTargetName:""}]},
  }).relationshipsUpserted,0);
}
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chat_character_relations WHERE chatId='coerced'").get().count,0);
assert.equal(structured.applyStructuredCharacterGraph({
  chatId:"hired",personaName:"주인공",turnNo:501,
  graph:{...baseGraph,relationships:[{...userDirection,relation:"부하 직원",
    evidence:"상대는 주인공의 부하가 되었다.",addressTerm:"",addressSpeakerName:"",addressTargetName:""}]},
}).relationshipsUpserted,1);
db.close();
console.log("structured relationship direction apply tests passed");
