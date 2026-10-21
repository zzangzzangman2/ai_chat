const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const test = require("node:test");
const ts = require("typescript");

function load(name) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, name), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function("module", "exports", js)(mod, mod.exports);
  return mod.exports;
}
const { deriveIdentityCanon } = load("identity_memory.ts");
const { buildSpatialCanon } = load("spatial_canon.ts");
const user = (content) => ({ role: "user", content });

test("relationship lookup preserves assignment, inverse, persona and late corrections", () => {
  const result = deriveIdentityCanon({
    personaName: "지민",
    knownNames: ["민수", "지수", "수연", "태호", "서진", "Alex", "Chris"],
    messages: [
      user("내 동생 수연."),
      user("민수의 아버지 이름은 태호이다."),
      user("서진은 지수의 스승이다."),
      user("Alex의 친구는 Chris."),
      { role: "assistant", content: "지수의 스승은 민수." },
      user('"지수의 스승은 태호."'),
      user("민수의 아버지 이름은 서진이다."),
    ],
  });
  const find = (subject, relation) => result.roleAnchors.find((x) => x.subjectName === subject && x.relation === relation);
  assert.equal(find("지민", "동생").relatedName, "수연");
  assert.equal(find("지수", "스승").relatedName, "서진");
  assert.equal(find("Alex", "친구").relatedName, "Chris");
  assert.equal(find("민수", "아버지").relatedName, "서진");
  assert.equal(find("민수", "아버지").sourceOrder, 6);
});

test("500-turn preparation retains early/middle facts without a roster-squared delay", () => {
  const names = Array.from({ length: 40 }, (_, i) => `Person_${i}`);
  const messages = Array.from({ length: 500 }, (_, i) => user(`${names[i % 40]} 오늘도 마을의 길을 걸었다.`));
  messages[2] = user("Person_0의 친구는 Person_1.");
  messages[199] = user("Person_2의 스승은 Person_3.");
  messages[245] = user("Person_4는 Person_5랑 같이 자.");
  messages[499] = user("Person_5방 상황");
  const started = performance.now();
  const identity = deriveIdentityCanon({ messages, knownNames: names });
  const spatial = buildSpatialCanon({ messages, knownNames: names });
  const elapsed = performance.now() - started;
  assert.equal(identity.roleAnchors.find((x) => x.subjectName === "Person_0").relatedName, "Person_1");
  assert.equal(identity.roleAnchors.find((x) => x.subjectName === "Person_2").relatedName, "Person_3");
  assert.equal(spatial.temporaryPlacements.find((x) => x.subjectName === "Person_4").location, "Person_5의 방");
  assert.equal(spatial.currentScene.location, "Person_5의 방");
  assert.ok(elapsed < 2500, `preparation took ${Math.round(elapsed)}ms`);
});

test("spatial candidate filtering keeps case-insensitive aliases and same-name exclusions", () => {
  const result = buildSpatialCanon({
    identities: [
      { canonicalName: "Alex", aliases: ["Al"] },
      { canonicalName: "Chris", aliases: ["Christopher"] },
    ],
    messages: [user("AL은 CHRISTOPHER랑 같이 자."), user("al방 상황")],
  });
  assert.deepEqual(result.temporaryPlacements.map((x) => x.subjectName).sort(), ["Alex", "Chris"]);
  assert.equal(result.currentScene.location, "Alex의 방");
});
