/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuard() {
  const source = fs.readFileSync(
    path.join(__dirname, "physical_fact_consistency_guard.ts"),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(loaded.exports, loaded, require);
  return loaded.exports;
}

const {
  buildPhysicalFactIdentities,
  enforcePhysicalFactOwnership,
  formatPhysicalFactOwnershipBlock,
} = loadGuard();

const identities = [
  {
    name: "이춘복",
    aliases: ["춘복"],
    isPersona: true,
    gender: "남자",
    heightCm: 150,
    weightKg: 150,
    buildClass: "large",
  },
  { name: "윤청아", aliases: ["청아"], gender: "여자", weightKg: 46 },
];

test("qualifies an unnamed canonical measurement with its unique owner", () => {
  const result = enforcePhysicalFactOwnership({
    text: "육중한 150킬로그램의 체구가 소파를 눌렀다.",
    identities,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.qualified, 1);
  assert.match(result.text, /이춘복의 150킬로그램/u);
});

test("qualifies an unnamed large-build descriptor with its unique owner", () => {
  const result = enforcePhysicalFactOwnership({
    text: "육중한 체구가 소파 깊숙이 가라앉았다. 거구의 남자가 몸을 돌렸다.",
    identities,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.qualified, 2);
  assert.match(result.text, /이춘복의 육중한 체구/u);
  assert.match(result.text, /거구인 이춘복/u);
});

test("qualifies coordinated and adverbial large-build wording", () => {
  const result = enforcePhysicalFactOwnership({
    text: "육중하고 둔중한 움직임이 이어졌다. 육중하게 몸을 돌렸다.",
    identities,
  });

  assert.equal(result.qualified, 2);
  assert.match(result.text, /이춘복은 육중하고/u);
  assert.match(result.text, /이춘복이 육중하게/u);
});

test("does not alter a measurement already bound to its owner", () => {
  const source = "이춘복의 150kg 체구가 문 앞을 막았다.";
  const result = enforcePhysicalFactOwnership({ text: source, identities });

  assert.equal(result.qualified, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("removes a direct transfer of a unique measurement to another character", () => {
  const result = enforcePhysicalFactOwnership({
    text: "윤청아의 체중은 150kg에 달했다. 그녀는 창가를 보았다.",
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /150kg/u);
  assert.match(result.text, /창가/u);
});

test("removes a gendered pronoun transfer but preserves a denial", () => {
  const bad = enforcePhysicalFactOwnership({
    text: "그녀의 150kg 몸이 의자를 눌렀다.",
    identities,
  });
  assert.equal(bad.removed, 1);

  const denial = "윤청아는 150kg이 아니다.";
  const safe = enforcePhysicalFactOwnership({ text: denial, identities });
  assert.equal(safe.text, denial);
  assert.equal(safe.removed, 0);
});

test("removes a large-build descriptor directly assigned to another character", () => {
  const result = enforcePhysicalFactOwnership({
    text: "윤청아는 육중한 체구로 문을 막았다. 다음 순간 창문이 열렸다.",
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /육중/u);
  assert.match(result.text, /창문/u);
});

test("does not mistake a nearby observer for the physical owner", () => {
  const source = "윤청아는 노인의 150kg 체구를 올려다보았다.";
  const result = enforcePhysicalFactOwnership({ text: source, identities });

  assert.equal(result.removed, 0);
  assert.match(result.text, /이춘복의 150kg/u);
});

test("assistant-only NPC measurements cannot become deterministic canon", () => {
  const built = buildPhysicalFactIdentities({
    persona: { name: "이춘복", gender: "남자", heightCm: 150, weightKg: 150 },
    characters: [{ name: "윤청아", aliases: "청아" }],
    facts: [
      {
        subjectKey: "npc:cheonga",
        subjectName: "윤청아",
        factKey: "weight",
        value: "150kg",
        sourceRole: "assistant",
      },
      {
        subjectKey: "npc:cheonga",
        subjectName: "윤청아",
        factKey: "weight",
        value: "46kg",
        sourceRole: "user",
      },
      {
        subjectKey: "persona",
        subjectName: "이춘복",
        factKey: "weight",
        value: "90kg",
        sourceRole: "assistant",
      },
    ],
  });

  assert.equal(built.find((item) => item.name === "윤청아").weightKg, 46);
  assert.equal(built.find((item) => item.name === "이춘복").weightKg, 150);
});

test("ownership prompt distinguishes memory owner from attribute owner", () => {
  const block = formatPhysicalFactOwnershipBlock(identities);
  assert.match(block, /memory_owner\/character_id/u);
  assert.match(block, /이춘복: 키 150cm, 체중 150kg, 체형 대형/u);
  assert.match(block, /미정/u);
});
