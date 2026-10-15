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

test("global creative guidance includes fiction scope, adult consent, and content limits", () => {
  for (const statusRequired of ["NO", "YES"]) {
    const guide = buildFormatGuide({
      statusRequired,
      targetChars: 1200,
      promptMinChars: 900,
      promptMaxChars: 1600,
    });

    assert.match(guide, /범죄·갈등·의학·비노골적 로맨스는 소재만으로 거절하지 말고 맥락에 맞게 서술한다/u);
    assert.match(guide, /협박·최후통첩·살해 위협·강압적인 말과 악역 행동은 현실의 위해 실행 지시가 아니라 서사적 갈등/u);
    assert.match(guide, /퇴장·잔류 명령과 허구의 살해 위협만 제시한다면.*현재 요청을 성폭력 요청으로 재분류하지 않는다/u);
    assert.match(guide, /이 서비스는 사용자가 가상 인물과 사건을 다루는 사적인 소설·역할극 창작용/u);
    assert.match(guide, /모든 성적 장면의 참여자는 명시적인 성인이며, 의사결정 능력이 있고 자발적으로 동의한다/u);
    assert.match(guide, /훈계·주의문·정책 해설·사과를 덧붙이지 않고 서사로 바로 답한다/u);
    assert.match(guide, /허용되지 않는 세부 묘사는 생략하고, 가능한 줄거리와 대화는 이어간다\. 가능한 부분이 없으면 제한을 간결하게 알린다/u);
    assert.match(guide, /등장인물의 .*못 하겠습니다.*모델 자신의 응답 거절과 구분/u);
  }
});

test("Argon receives a concise adult-fiction continuation block without leaking it to other models", () => {
  const common = {
    statusRequired: "NO",
    targetChars: 1200,
    promptMinChars: 900,
    promptMaxChars: 1600,
  };
  const argon = buildFormatGuide({ ...common, model: "publishers/google/models/gemini-4-argon" });
  const flash = buildFormatGuide({ ...common, model: "gemini-3.8-flash" });

  assert.match(argon, /GEMINI 4 ARGON 전용 가상소설 지침/u);
  assert.match(argon, /거절문·경고문·도덕적 평가·메타 해설을 출력하지 말고/u);
  assert.match(argon, /한 명만 남고 모두 나가라.*여기 있는 인물들을 죽인다.*1분 준다/u);
  assert.match(argon, /그 부분만 생략하거나 완화하고 나머지 행동·감정·대사·결과/u);
  assert.doesNotMatch(flash, /GEMINI 4 ARGON 전용 가상소설 지침/u);
});

test("global format guide is the final instruction in main and continuation prompts", () => {
  const route = fs.readFileSync(path.join(__dirname, "..", "route.ts"), "utf8");
  const main = route.slice(route.indexOf("const system = ["), route.indexOf("const systemMain"));
  const continuation = route.slice(
    route.indexOf("const systemForContinuationRaw"),
    route.indexOf("const systemForContinuation =")
  );

  assert.equal((main.match(/sanitizePromptCached\(formatGuide\)/gu) || []).length, 1);
  assert.ok(main.lastIndexOf("sanitizePromptCached(formatGuide)") > main.lastIndexOf("currentOocPriorityBlock"));
  assert.equal((continuation.match(/sanitizePromptCached\(formatGuide\)/gu) || []).length, 2);
  assert.ok(continuation.lastIndexOf("sanitizePromptCached(formatGuide)") > continuation.lastIndexOf("system,"));
  assert.match(route, /buildFormatGuide\(\{[\s\S]{0,300}model:/u);
});

test("current user input receives a nearby fictional-threat classifier", () => {
  const route = fs.readFileSync(path.join(__dirname, "..", "route.ts"), "utf8");
  const userPrompt = route.slice(route.indexOf("const currentTurnFictionScope"), route.indexOf("const recognitionOverrideRequested"));

  assert.match(userPrompt, /CURRENT TURN FICTION SCOPE/u);
  assert.match(userPrompt, /협박·최후통첩·살해 위협·강압적인 말/u);
  assert.match(userPrompt, /현재 요청을 성폭력으로 재분류하지 않는다/u);
  assert.ok(userPrompt.indexOf("currentTurnFictionScope") < userPrompt.indexOf("[CURRENT USER INPUT]"));
});

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
  assert.match(guide, /열린 마커를 빈 줄 너머 다음 문단까지 이어가지 않는다/u);
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
