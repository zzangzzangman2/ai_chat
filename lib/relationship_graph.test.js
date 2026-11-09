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
const {narrativeRelationshipLabel,selectCurrentStoredRelationships,applyDurableRelationshipCanon} = load(path.join(__dirname,"relationship_graph.ts"));

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

const edge = (relation, extra={}) => ({id:relation,subjectKey:"persona",subjectName:"이춘복",objectKey:"name:박도훈",objectName:"박도훈",relation,source:"structured",sourceRole:"assistant",evidence:"",firstSeenTurn:3,lastSeenTurn:500,updatedAt:1,...extra});
test("repeated coerced errands and honorifics cannot become employee relations", () => {
  for (const extra of [{}, {addressTerm:"주인님"}]) {
    assert.deepEqual(selectCurrentStoredRelationships([edge("부하 직원",{evidence:"박도훈은 이춘복에게 고개를 숙이고 지시를 따랐다.",...extra})]), []);
  }
});
test("hostility and a prior employment role coexist while model friendship cannot erase hostility", () => {
  const rows=[edge("원수"),edge("친구",{lastSeenTurn:900}),edge("부하 직원",{evidence:"박도훈은 이춘복의 직원으로 채용되었다."})];
  assert.deepEqual(new Set(selectCurrentStoredRelationships(rows).map(r=>r.relation)),new Set(["원수","부하 직원"]));
  assert.deepEqual(new Set(selectCurrentStoredRelationships(rows.reverse()).map(r=>r.relation)),new Set(["원수","부하 직원"]));
});
test("source hostility repairs existing derived rows without persisting a character-specific patch", () => {
  const state={subjectName:"이춘복",objectName:"박도훈",kind:"hostile",sourceRole:"assistant",turnNo:3,sourceMessageId:"attack",evidence:"박도훈은 이춘복을 공격했다."};
  const rows=[edge("부하 직원",{firstSeenTurn:500}),edge("친구")];
  const repaired=applyDurableRelationshipCanon(rows,{lifeStates:[],relationships:[state]},"이춘복");
  assert.deepEqual(repaired.map(r=>r.relation),["원수"]);
  assert.equal(repaired[0].evidence,state.evidence);
  const hired=applyDurableRelationshipCanon(rows,{lifeStates:[],relationships:[state],hierarchies:[state]},"이춘복");
  assert.deepEqual(new Set(hired.map(r=>r.relation)),new Set(["원수","부하 직원"]));
  assert.deepEqual(applyDurableRelationshipCanon(repaired,{lifeStates:[],relationships:[{...state,kind:"reconciled"}]},"이춘복"),[]);
});
