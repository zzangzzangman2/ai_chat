/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadKnowledgeModule() {
  const sourcePath = path.join(__dirname, "character_knowledge.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    require
  );
  return loaded.exports;
}

const {
  inferRelationshipKnownByNames,
  parseRelationshipKnownBy,
  relationshipKnowledgeScope,
} = loadKnowledgeModule();

test("legacy crime relations remain world-only without knowledge evidence", () => {
  const knownBy = inferRelationshipKnownByNames({
    subjectName: "정진우",
    objectName: "이춘복",
    relation: "직장 동료 및 현재 사건으로 얽힌 당사자",
    details: "정진우가 잠든 사이 이춘복이 침입했다.",
    storedKnownByNames: [],
  });
  assert.deepEqual(knownBy, []);
  assert.equal(relationshipKnowledgeScope(knownBy), "world_only");
});

test("ordinary mutual relationships remain known to both endpoints", () => {
  const knownBy = inferRelationshipKnownByNames({
    subjectName: "정아린",
    objectName: "정진우",
    relation: "오빠와 여동생",
    storedKnownByNames: [],
  });
  assert.deepEqual(knownBy, ["정아린", "정진우"]);
  assert.equal(relationshipKnowledgeScope(knownBy), "limited");
});

test("sensitive details prevent a safe-looking label from leaking hidden facts", () => {
  const knownBy = inferRelationshipKnownByNames({
    subjectName: "정진우",
    objectName: "이춘복",
    relation: "직장 동료",
    details: "정진우가 잠든 사이 이춘복이 비밀리에 침입한 범인이다.",
    storedKnownByNames: [],
  });
  assert.deepEqual(knownBy, []);
});

test("explicit knowledge evidence overrides sensitive relationship defaults", () => {
  const knownBy = inferRelationshipKnownByNames({
    subjectName: "이춘복",
    objectName: "정아린",
    relation: "범죄 가해자와 피해자",
    storedKnownByNames: ["구교민"],
  });
  assert.deepEqual(knownBy, ["구교민"]);
});

test("stored knowledge lists parse JSON and legacy separators conservatively", () => {
  assert.deepEqual(parseRelationshipKnownBy('["정진우","정진우","정아린"]'), [
    "정진우",
    "정아린",
  ]);
  assert.deepEqual(parseRelationshipKnownBy("정진우, 정아린"), ["정진우", "정아린"]);
});
