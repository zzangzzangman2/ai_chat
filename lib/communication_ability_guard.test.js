const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const file = path.join(__dirname, "communication_ability_guard.ts");
const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRef = { exports: {} };
Function("exports", "module", "require", js)(moduleRef.exports, moduleRef, require);
const {
  buildCommunicationConstraints,
  enforceCommunicationAbilities,
  formatCommunicationAbilityBlock,
} = moduleRef.exports;

const nonverbal = buildCommunicationConstraints({
  identities: [
    {
      name: "윤청아",
      aliases: "청아, 윤청아 양",
      profile: "청각장애가 있고 말을 하지 못해 스케치북으로 의사소통한다.",
    },
  ],
});

test("hearing loss alone does not imply inability to speak", () => {
  const constraints = buildCommunicationConstraints({
    identities: [{ name: "윤청아", profile: "청각장애가 있는 학생" }],
  });
  assert.equal(constraints.length, 0);
});

test("explicit nonverbal canon overrides direct-dialogue rules", () => {
  assert.equal(nonverbal.length, 1);
  assert.equal(nonverbal[0].mode, "writing");
  const block = formatCommunicationAbilityBlock(nonverbal);
  assert.match(block, /윤청아: 음성 발화 불가/);
  assert.match(block, /직접 대사 분량 규칙보다 우선/);
});

test("rewrites reproduced spoken dialogue as established written communication", () => {
  const source = [
    "*윤청아 역시 자리를 벗어나지 않고 재판장을 바라보았다.*",
    "",
    '"재판장님, 방금 발언을 기록해 주세요."',
  ].join("\n");
  const result = enforceCommunicationAbilities({ text: source, constraints: nonverbal });

  assert.equal(result.rewritten, 1);
  assert.doesNotMatch(result.text, /^"/m);
  assert.match(result.text, /윤청아는 스케치북에 \[재판장님, 방금 발언을 기록해 주세요\.\]/);
});

test("does not assign a nearby father's dialogue to the nonverbal character", () => {
  const source = [
    "*청아의 곁에 있던 아버지가 딸의 어깨를 감쌌다.*",
    "",
    '"괜찮니?"',
  ].join("\n");
  const result = enforceCommunicationAbilities({ text: source, constraints: nonverbal });

  assert.equal(result.rewritten, 0);
  assert.equal(result.text, source);
});

test("uses preceding guarded-stream context to block a later speech chunk", () => {
  const result = enforceCommunicationAbilities({
    contextText: "*윤청아는 스케치북을 움켜쥐고 재판장을 바라보았다.*",
    text: '"저건 인간이 아니야."\n\n',
    constraints: nonverbal,
  });
  assert.equal(result.rewritten, 1);
  assert.match(result.text, /스케치북/);
});

test("ordinary output remains byte-for-byte unchanged", () => {
  const source = '*재판장이 판결문을 덮었다.*\n\n"호송하세요."';
  const result = enforceCommunicationAbilities({ text: source, constraints: nonverbal });
  assert.equal(result.rewritten, 0);
  assert.equal(result.text, source);
});
