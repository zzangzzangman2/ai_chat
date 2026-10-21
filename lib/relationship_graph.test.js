/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = {exports:{}};
  cache.set(file, mod);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const localRequire = (id) => {
    if (id === "crypto") return require("node:crypto");
    if (id === "@/lib/db") return {db:{prepare(){throw new Error("No database access in this test");}}};
    if (id === "@/lib/crypto") return {decryptIfPossible:String,encryptIfPossible:String};
    if (id === "@/lib/character_vitals") return {loadCharacterGraphNodes(){throw new Error("No roster access in this test");}};
    if (id.startsWith("@/lib/")) return load(path.join(__dirname, `${id.slice(6)}.ts`));
    throw new Error(`Unexpected import: ${id}`);
  };
  Function("exports","module","require",output)(mod.exports,mod,localRequire);
  return mod.exports;
}
const {narrativeRelationshipLabel} = load(path.join(__dirname,"relationship_graph.ts"));

test("a recent unverified friendship cannot replace a stored enemy relationship", () => {
  const label = narrativeRelationshipLabel({score:3, relationshipNote:"박도훈과 이춘복은 돌이킬 수 없는 원수다.", recentMemory:"박도훈과 이춘복은 친구가 되었다.", lastTurnNo:500, memoryCount:500});
  assert.equal(label,"원수");
});
test("an explicit verified user transition may change the structural relationship", () => {
  assert.equal(narrativeRelationshipLabel({score:3, relationshipNote:"두 사람은 원수다.", recentMemory:"두 사람은 친구가 되었다.", latestSourceRole:"user"}),"친구");
});
test("hostility in a profile also survives a model friendship summary", () => {
  assert.equal(narrativeRelationshipLabel({score:80, profile:"주인공과 적대 관계다.", recentMemory:"친구가 되었다.", latestSourceRole:"assistant"}),"원수");
});
test("existing unrelated relationship transitions keep their prior behavior", () => {
  assert.equal(narrativeRelationshipLabel({score:20,relationshipNote:"배우자",recentMemory:"두 사람은 이혼했다."}),"이혼한 전 배우자");
});
