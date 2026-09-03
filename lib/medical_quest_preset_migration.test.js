const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function transpileModule(relativeFile) {
  const source = fs.readFileSync(path.join(__dirname, relativeFile), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", js)(loaded.exports, loaded, require);
  return loaded.exports;
}

const metaPolicy = transpileModule("meta_panel_policy.ts");
const file = path.join(__dirname, "medical_quest_preset_migration.ts");
const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRef = { exports: {} };
const localRequire = (request) =>
  request === "./meta_panel_policy" ? metaPolicy : require(request);
Function("exports", "module", "require", js)(moduleRef.exports, moduleRef, localRequire);
const {
  rewriteMedicalQuestFirstMessages,
  rewriteMedicalQuestLorebooks,
  rewriteMedicalQuestOpening,
  rewriteMedicalQuestSystemPrompt,
  stripLegacyInfoPanels,
} = moduleRef.exports;

test("medical quest prompt makes panels event-only and exposes ability command", () => {
  const source = [
    "[퀘스트 구성]",
    "퀘스트 창에는 종류와 난도, 제목, 발동 계기, 대상 코드, 핵심 목표, 선택 목표, 현재 단계, 남은 시간, 확보한 근거, 미확인 가설, 예상 보상을 간결하게 표시한다.",
    "[출력 형식]",
    "- 시스템 창과 상태 정보는 하나의 ```INFO 코드블록으로 정리한다.",
    "[상태 정보]",
    "답변 끝에는 현재 장면에 필요한 항목만 짧게 표시한다.",
  ].join("\n");
  const out = rewriteMedicalQuestSystemPrompt(source);
  assert.match(out, /제작자 메타 패널 정책: EVENT_ONLY/u);
  assert.match(out, /빠른 명령: 능력치 보기/u);
  assert.match(out, /변화 없는 일반 대화[\s\S]*서사 본문만 출력/u);
  assert.doesNotMatch(out, /답변 끝에는 현재 장면에 필요한 항목/u);
  assert.doesNotMatch(out, /```INFO/u);
});

test("legacy INFO tails are removed while the opening keeps one compact QUEST card", () => {
  const legacy = [
    "*장면.*",
    "```INFO",
    "[의학적 오류 수정 시스템 최초 연결]",
    "너무 많은 정보",
    "```",
    "*창은 사라지지 않았다.*",
    "```INFO",
    "[현재 인물] 모두 나열",
    "```",
  ].join("\n\n");
  const out = rewriteMedicalQuestOpening(legacy);
  assert.equal((out.match(/```QUEST/gu) || []).length, 1);
  assert.doesNotMatch(out, /```INFO/u);
  assert.match(out, /"widget": "quest"/u);
  assert.match(out, /시야 한구석으로 접혔다/u);
  assert.doesNotMatch(stripLegacyInfoPanels(legacy), /현재 인물/u);
});

test("preset JSON fields are migrated without breaking their array topology", () => {
  const first = rewriteMedicalQuestFirstMessages(JSON.stringify([{ text: "*시작*\n```INFO\n[연결]\n```" }]));
  const firstRows = JSON.parse(first);
  assert.equal(firstRows.length, 1);
  assert.match(firstRows[0].text, /```QUEST/u);

  const lore = rewriteMedicalQuestLorebooks(
    JSON.stringify([
      {
        name: "게임 시스템―스킬·업적·전직",
        content: "초기 상태",
        activationKeys: ["레벨", "상태창"],
      },
    ])
  );
  const loreRows = JSON.parse(lore);
  assert.ok(loreRows[0].activationKeys.includes("능력치 보기"));
  assert.ok(!loreRows[0].activationKeys.includes("상태창"));
});
