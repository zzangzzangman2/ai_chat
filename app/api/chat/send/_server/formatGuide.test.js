/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadFormatGuideModule() {
  const sourcePath = path.join(__dirname, "formatGuide.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(loaded.exports, loaded, require);
  return loaded.exports;
}

const { buildFormatGuide } = loadFormatGuideModule();

test("global prompt preserves scene membership and closes incapacity loopholes", () => {
  const guide = buildFormatGuide({
    statusRequired: "NO",
    targetChars: 1200,
    promptMinChars: 900,
    promptMaxChars: 1600,
  });

  assert.doesNotMatch(guide, /역할.*없으면.*장면에서\s*뺀다/u);
  assert.doesNotMatch(guide, /나머지\s*인물은\s*물러난\s*상태/u);
  assert.match(guide, /기절·혼절·의식 상실.*새로 만들지 않는다/u);
  assert.match(guide, /현재 장면의 인물 구성은 정리 대상이 아니라 지속되는 상태/u);
});

test("route no longer injects automatic character-retirement instructions", () => {
  const routePath = path.join(__dirname, "..", "route.ts");
  const route = fs.readFileSync(routePath, "utf8");

  assert.doesNotMatch(route, /고착 인물 퇴장/u);
  assert.doesNotMatch(route, /stickyOverusedNames|overusedCharacterBlock/u);
});

test("global route prompt forbids official characters from inventing history", () => {
  const routePath = path.join(__dirname, "..", "route.ts");
  const route = fs.readFileSync(routePath, "utf8");

  assert.match(route, /OFFICIAL CLAIM GROUNDING HARD GUARD/u);
  assert.match(route, /설명 범위 지시일 뿐/u);
  assert.match(route, /서로 다른 피해자·사건의 기억을 한 사람의 반복 범행 이력으로 합치지 않는다/u);
  assert.match(route, /authorityClaimPriorityBlock/u);
});

test("global prompt starts with stable instructions instead of dynamic memory", () => {
  const routePath = path.join(__dirname, "..", "route.ts");
  const route = fs.readFileSync(routePath, "utf8");
  const assembly = route.slice(
    route.indexOf("const systemRaw"),
    route.indexOf("const npcName")
  );

  assert.ok(assembly.indexOf("너는 아래 설정을 따르며") >= 0);
  assert.ok(
    assembly.indexOf("너는 아래 설정을 따르며") <
      assembly.indexOf("dynamicCharacterContext.block")
  );
});

test("dynamic context does not guess focus from latest database memory", () => {
  const sourcePath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "lib",
    "dynamic_character_context.ts"
  );
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(source, /MAX\(turnNo\) AS latestTurn/u);
  assert.match(source, /scene-membership ledger remains the authority/u);
});
