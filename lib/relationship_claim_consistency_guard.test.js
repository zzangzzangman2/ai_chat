/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuard() {
  const source = fs.readFileSync(
    path.join(__dirname, "relationship_claim_consistency_guard.ts"),
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
  formatRelationshipCanonGuardBlock,
  removeUnsupportedRelationshipClaims,
} = loadGuard();

const identities = [
  { name: "이수진", aliases: ["수진"] },
  { name: "박지아", aliases: ["지아"] },
  { name: "박지훈", aliases: ["지훈"] },
  { name: "윤청아", aliases: ["청아"] },
];

const relations = [
  {
    subjectName: "이수진",
    objectName: "박지아",
    relation: "딸",
    source: "identity",
  },
  {
    subjectName: "이수진",
    objectName: "박지훈",
    relation: "아들",
    source: "identity",
  },
];

test("rewrites an unsupported possessive child claim to the referenced character", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: '*이수진은 윤청아를 끌어안았다.* "우리 애는 건드리지 마."',
    identities,
    relations,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.rewritten, 1);
  assert.doesNotMatch(result.text, /우리\s*애/u);
  assert.match(result.text, /윤청아는 건드리지 마/u);
});

test("keeps the same phrase when the target is the speaker's canonical child", () => {
  const source = '*이수진은 박지아를 끌어안았다.* "우리 애는 괜찮아."';
  const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations });

  assert.equal(result.removed, 0);
  assert.equal(result.rewritten, 0);
  assert.equal(result.text, source);
});

test("uses the preceding streamed paragraph to resolve speaker and target", () => {
  const result = removeUnsupportedRelationshipClaims({
    contextText: "*이수진은 윤청아를 뒤로 감싸며 형사를 노려보았다.*",
    text: '"우리 애한테 손대지 마."',
    identities,
    relations,
  });

  assert.equal(result.rewritten, 1);
  assert.match(result.text, /윤청아한테 손대지 마/u);
});

test("removes an invented explicit daughter relationship between known characters", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: "이수진은 윤청아를 자신의 딸로 인식했다. 박지아는 곁에서 지켜봤다.",
    identities,
    relations,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /딸로\s*인식/u);
  assert.match(result.text, /박지아는 곁에서/u);
});

test("removes an inverse copular family assertion that is absent from canon", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: "윤청아는 이수진의 딸이었다. 문밖에서 발소리가 들렸다.",
    identities,
    relations,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /이수진의 딸/u);
  assert.match(result.text, /발소리/u);
});

test("assistant-only structured family edges cannot authenticate themselves", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: '*이수진은 윤청아의 어깨를 감쌌다.* "우리 딸은 내가 지켜."',
    identities,
    relations: [
      ...relations,
      {
        subjectName: "이수진",
        objectName: "윤청아",
        relation: "딸",
        source: "structured",
        sourceRole: "assistant",
      },
    ],
  });

  assert.equal(result.rewritten, 1);
  assert.doesNotMatch(result.text, /우리\s*딸/u);
});

test("mere user-text co-occurrence cannot ground the wrong family pair", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: "윤청아는 이수진의 딸이었다.",
    trustedUserTexts: ["이수진은 박지아의 엄마고, 윤청아도 같은 거실에 있다."],
    identities,
    relations,
  });

  assert.equal(result.removed, 1);
  assert.equal(result.text, "");
});

test("the prompt block makes family canon closed-world for existing characters", () => {
  const block = formatRelationshipCanonGuardBlock({ relations });

  assert.match(block, /우리 애\/우리 아이/u);
  assert.match(block, /이수진 → 딸 → 박지아/u);
  assert.match(block, /이수진 → 아들 → 박지훈/u);
  assert.match(block, /이전 AI 대사·지문·요약만으로/u);
});
