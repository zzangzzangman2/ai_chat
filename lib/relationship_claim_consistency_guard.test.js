/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuard(file = "relationship_claim_consistency_guard.ts") {
  const source = fs.readFileSync(
    path.join(__dirname, file),
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

test("neutralizes an unsupported possessive child claim without guessing a name", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: '*이수진은 윤청아를 끌어안았다.* "우리 애는 건드리지 마."',
    identities,
    relations,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.rewritten, 1);
  assert.doesNotMatch(result.text, /우리\s*애/u);
  assert.match(result.text, /그 아이는 건드리지 마/u);
  assert.doesNotMatch(result.text, /윤청아는 건드리지 마/u);
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
  assert.match(result.text, /그 아이한테 손대지 마/u);
  assert.doesNotMatch(result.text, /윤청아한테 손대지 마/u);
});

test("keeps a repeated structured family edge after its one-turn quarantine", () => {
  const source = '*박도훈은 이를 악물었다.* "내 아내와 내 딸한테 무슨 짓을 한 거냐!"';
  const result = removeUnsupportedRelationshipClaims({
    text: source,
    identities: [...identities, { name: "박도훈", aliases: ["도훈"] }],
    relations: [
      {
        subjectName: "박도훈",
        objectName: "이수진",
        relation: "배우자",
        source: "identity",
      },
      {
        subjectName: "박도훈",
        objectName: "박지아",
        relation: "딸",
        source: "structured",
        sourceRole: "assistant",
        firstSeenTurn: 12,
        lastSeenTurn: 18,
      },
    ],
  });

  assert.equal(result.rewritten, 0);
  assert.equal(result.text, source);
});

test("keeps everyday sibling reference without inventing a name or a family edge", () => {
  const source = '*박지훈이 외쳤다.* "박지아랑 내 동생한테서 떨어져!"';
  const result = removeUnsupportedRelationshipClaims({
    text: source,
    identities,
    relations,
  });

  assert.equal(result.text, source);
  assert.equal(result.rewritten, 0);
  assert.doesNotMatch(result.text, /박지아랑 박지아/u);
});

test("does not match possessives inside 막내, 이제, 안내 or names", () => {
  for (const phrase of [
    "막내 동생 윤청아를 데려왔어요.",
    "이제 언니는 쉬어요.",
    "안내 부모님도 이쪽으로 오세요.",
    "우리 엄마인형을 찾았어요.",
  ]) {
    const source = `*이수진이 윤청아를 보며 말했다.* "${phrase}"`;
    const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
    assert.equal(result.text, source);
    assert.equal(result.rewritten, 0);
  }
});

test("does not match family terms inside 형편, 형식, 아이디어 or 아들딸", () => {
  const source = '*이수진이 말했다.* "제 형편은 괜찮아요. 우리 아이디어와 제 형식을 보세요. 우리 아들딸들이 왔어요."';
  const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
  assert.equal(result.text, source);
  assert.equal(result.rewritten, 0);
});

test("social sibling references remain natural even without a registered blood relationship", () => {
  for (const phrase of ["우리 언니한테", "제 오빠는", "내 동생을", "저희 누나가", "우리 형과", "우리동생한테는"]) {
    const source = `*이수진은 윤청아를 보며 말했다.* "${phrase} 책을 보여 주세요."`;
    const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
    assert.equal(result.text, source);
    assert.equal(result.rewritten, 0);
    assert.deepEqual(result.claims, []);
  }
});

test("explicit sibling identity and biological or adoptive assertions still require canon", () => {
  for (const phrase of ["내 동생이다.", "우리 친동생을 데려왔어.", "내 양동생이야."]) {
    const source = `*이수진은 윤청아를 보며 말했다.* "${phrase}"`;
    const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
    assert.equal(result.rewritten, 1);
    assert.doesNotMatch(result.text, /(?:내|우리)\s*(?:친|양)?동생/u);
  }
  const explicit = removeUnsupportedRelationshipClaims({
    text: "윤청아는 이수진의 언니였다. 박지아는 책을 읽었다.", identities, relations: [],
  });
  assert.equal(explicit.removed, 1);
  assert.doesNotMatch(explicit.text, /언니였다/u);
  assert.match(explicit.text, /박지아는 책을 읽었다/u);
});

test("whole-word matching retains checks for unsupported child and spouse claims", () => {
  for (const [phrase, expected] of [
    ["우리 애기는 쉬어요.", "그 아이는 쉬어요."],
    ["제 아내에게는 책이 있어요.", "그 사람에게는 책이 있어요."],
    ["내남편한테 책을 주세요.", "그 사람한테 책을 주세요."],
  ]) {
    const source = `*이수진은 윤청아를 보며 말했다.* "${phrase}"`;
    const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
    assert.equal(result.rewritten, 1);
    assert.ok(result.text.includes(expected), result.text);
  }
});

test("family reference processing leaves INFO contents intact", () => {
  const metadata = '```INFO\n메모: 우리 언니\n다음 일정: 제 아내에게 책 전달\n```';
  const source = '*이수진이 윤청아를 보며 말했다.* "우리 언니는 쉬어요."\n\n' + metadata;
  const result = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
  assert.equal(result.text, source);
  assert.equal(result.rewritten, 0);
});

test("streamed paragraph checks and complete-response checks keep the same everyday references", () => {
  const { createGuardedTextStream } = loadGuard("guarded_text_stream.ts");
  const source = '*이수진은 윤청아에게 책을 건넸다.*\n\n"이제 언니는 쉬어요. 막내 동생도 왔어요. 우리 언니한테 책을 드려요."\n\n```INFO\n메모: 제 아내에게 책 전달\n```';
  const complete = removeUnsupportedRelationshipClaims({ text: source, identities, relations: [] });
  assert.equal(complete.text, source);
  for (const size of [1, 7, 43]) {
    let contextText = "";
    const gate = createGuardedTextStream(text => {
      const result = removeUnsupportedRelationshipClaims({ text, contextText, identities, relations: [] });
      contextText = (contextText + "\n" + text).slice(-1200);
      return result.text;
    }, { paragraphs: true });
    for (let i = 0; i < source.length; i += size) gate.push(source.slice(i, i + size));
    gate.finish();
    assert.equal(gate.output().trim(), complete.text);
  }
});

test("repairs duplicate coordinated names and pluralized personal names", () => {
  const result = removeUnsupportedRelationshipClaims({
    text: '"박지아랑 박지아한테서 떨어져! 박도훈한테, 박도훈한테 왜 그래! 박도훈들한테서 물러나!"',
    identities: [...identities, { name: "박도훈", aliases: ["도훈"] }],
    relations,
  });

  assert.equal(result.rewritten, 3);
  assert.match(result.text, /박지아한테서 떨어져/u);
  assert.match(result.text, /박도훈한테 왜 그래/u);
  assert.match(result.text, /그들한테서 물러나/u);
  assert.doesNotMatch(result.text, /박지아랑 박지아|박도훈한테, 박도훈|박도훈들/u);
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
  assert.match(block, /주변 인물의 이름으로 추측 치환하지 않는다/u);
});


test("pregnancy, childbirth and caring for a child do not make the subject the other adult's child", () => {
  const adults = [{ name: "김하린" }, { name: "이도윤" }];
  for (const source of [
    "김하린은 임신했다.",
    "김하린은 이도윤의 아이를 임신했다.",
    "김하린은 이도윤의 아기를 잉태했다.",
    "김하린은 이도윤의 애기를 낳았다.",
    "김하린은 이도윤의 아이를 출산했다.",
    "김하린은 이도윤의 아이를 임신하지 않도록 피임했다.",
    "김하린은 이도윤의 아이를 유산했다.",
    "김하린은 이도윤의 아이를 돌보았다.",
    "김하린은 이도윤의 아이와 함께 있었다.",
  ]) {
    const result = removeUnsupportedRelationshipClaims({ text: source, identities: adults, relations: [] });
    assert.equal(result.text, source);
    assert.equal(result.removed, 0);
    assert.deepEqual(result.claims, []);
  }
});

test("pregnancy evidence cannot authenticate a false parent-child identity", () => {
  const adults = [{ name: "김하린" }, { name: "이도윤" }];
  for (const source of ["김하린은 이도윤의 아이였다.", "이도윤은 김하린의 아버지였다."]) {
    const result = removeUnsupportedRelationshipClaims({
      text: source,
      identities: adults,
      relations: [],
      trustedUserTexts: ["김하린은 이도윤의 아이를 임신했다."],
    });
    assert.equal(result.removed, 1);
    assert.equal(result.text, "");
  }
});

test("explicit family identities keep working with present and past copulas", () => {
  const adults = [{ name: "김하린" }, { name: "이도윤" }];
  for (const source of ["김하린은 이도윤의 딸이다.", "김하린은 이도윤의 딸이었다.", "김하린은 이도윤의 딸입니다."]) {
    assert.equal(removeUnsupportedRelationshipClaims({ text: source, identities: adults, relations: [] }).removed, 1);
    assert.equal(removeUnsupportedRelationshipClaims({ text: source, identities: adults, relations: [], trustedUserTexts: [source] }).text, source);
  }
});
