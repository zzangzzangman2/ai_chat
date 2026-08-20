/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "spatial_canon.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const loaded = { exports: {} };
Function("exports", "module", "require", output)(loaded.exports, loaded, require);
const { buildSpatialCanon } = loaded.exports;

const identities = [
  { canonicalName: "유지은", aliases: ["지은"] },
  { canonicalName: "박지훈", aliases: ["지훈"] },
  { canonicalName: "이수진", aliases: ["수진"] },
  { canonicalName: "박도훈", aliases: ["도훈"] },
  { canonicalName: "박지아", aliases: ["지아"] },
];

test("temporary room assignments and the latest scene room are preserved", () => {
  const result = buildSpatialCanon({
    messages: [
      {
        role: "user",
        content: "수진이와 도훈이는 안방 쓰고 지은이는 지훈이랑 같이 자. 나는 지아랑 같이 잘게.",
      },
      { role: "assistant", content: "각자 방으로 이동했다." },
      { role: "user", content: "*지훈방 상황*" },
    ],
    identities,
    personaName: "이춘복",
  });

  const byName = new Map(result.temporaryPlacements.map((item) => [item.subjectName, item]));
  assert.equal(byName.get("유지은").location, "박지훈의 방");
  assert.deepEqual(byName.get("유지은").companionNames, ["박지훈"]);
  assert.equal(byName.get("박지훈").location, "박지훈의 방");
  assert.equal(byName.get("이수진").location, "안방");
  assert.equal(byName.get("박도훈").location, "안방");
  assert.equal(byName.get("이춘복").location, "박지아의 방");
  assert.equal(result.currentScene.location, "박지훈의 방");
  assert.match(result.block, /현재 장면 위치: 박지훈의 방/u);
  assert.match(result.block, /유지은의 임시 위치: 박지훈의 방; 함께 있는 인물: 박지훈/u);
});

test("a later temporary assignment replaces an older one", () => {
  const result = buildSpatialCanon({
    messages: [
      { role: "user", content: "지은이는 지훈이랑 같이 자." },
      { role: "user", content: "지은이는 수진이랑 같이 자." },
    ],
    identities,
    personaName: "이춘복",
  });

  const jieun = result.temporaryPlacements.find((item) => item.subjectName === "유지은");
  assert.equal(jieun.location, "이수진의 방");
  assert.deepEqual(jieun.companionNames, ["이수진"]);
});
