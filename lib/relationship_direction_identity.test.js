const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function load(file) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", js)(require, mod, mod.exports);
  return mod.exports;
}

const { sanitizeAddressDirectionOutput: sanitize, formatAddressDirectionGuard } = load("lib/relationship_direction.ts");
const { createGuardedTextStream } = load("lib/guarded_text_stream.ts");
const persona = "이춘복";
const direction = (targetName, term, speakerName = persona) => ({
  speakerKey: speakerName === persona ? "persona" : `name:${speakerName}`,
  speakerName,
  targetKey: `name:${targetName}`,
  targetName,
  term,
  sourceRole: "user",
});
const directions = [
  direction("유아", "유아야"),
  direction("정수아", "수아야"),
  direction("강동석", "동석"),
  direction("박도훈", "장인어른"),
];

for (const text of [
  '최민호는 딸 유아에게 말했다. "유아야! 대답해! 원장님께서 묻고 계시잖니!"',
  '*최민호는 화면 속 딸을 향해 소리쳤다.*\n\n"유아야! 대답해!"',
  '서지연은 딸을 불렀다. “유아야, 이리 와.”',
  '김태철은 정수아에게 말했다. "수아야, 잠깐 기다려."',
  '송미란은 동료를 불렀다. "동석! 서류 좀 봐줘."',
  '최민호 | "유아야, 괜찮니?"',
]) {
  test(`preserves third-party name address: ${text}`, () => {
    assert.deepEqual(sanitize({ text, directions }), {
      text, replaced: 0, terms: [], reversedSpeakers: [],
    });
  });
}

for (const [name, term] of [
  ["유아", "유아야"], ["정수아", "정수아야"], ["정수아", "수아야"],
  ["강동석", "동석"], ["박도훈", "도훈아"], ["김민수", "민수 씨"],
  ["김민수", "김민수님"], ["Alex", "Alex"],
]) {
  test(`never substitutes a person's name even in attributed prose: ${term}`, () => {
    const text = `${name}는 ${persona}을 ${term}라고 불렀다.`;
    assert.equal(sanitize({ text, directions: [direction(name, term)] }).text, text);
  });
}

for (const text of [
  '"장인어른... "',
  '박도훈 | "장인어른, 안녕하세요."',
  '박도훈은 김태철을 장인어른이라 불렀다.',
  '박도훈은 이춘복을 보았다. 최민호는 김태철을 장인어른이라 불렀다.',
  '박도훈은 이춘복에게 말했다. "최민호가 장인어른이라고 불렀습니다."',
  '최민호는 김태철에게 말했다. "장인어른, 안녕하세요."',
  '이춘복은 박도훈을 장인어른이라 불렀다.',
  '박도훈은 이춘복에게 말했다. "장인어른, 안녕하세요.', // incomplete quote
]) {
  test(`preserves unproven reversal / quoted mention: ${text}`, () => {
    assert.equal(sanitize({ text, directions }).text, text);
  });
}

for (const [text, expected] of [
  ['도훈은 이춘복을 장인어른이라 불렀다.', '도훈은 이춘복을 이춘복이라 불렀다.'],
  ['박도훈은 이춘복에게 말했다. "장인어른, 안녕하세요."', '박도훈은 이춘복에게 말했다. "이춘복, 안녕하세요."'],
  ['*도훈은 춘복에게 물었다.*\n\n“장인어른, 괜찮으세요?”', '*도훈은 춘복에게 물었다.*\n\n“이춘복, 괜찮으세요?”'],
]) {
  test(`corrects only an explicitly reversed pair: ${text}`, () => {
    const result = sanitize({ text, directions });
    assert.equal(result.text, expected);
    assert.equal(result.replaced, 1);
    assert.deepEqual(result.terms, ["장인어른"]);
    assert.equal(sanitize({ text: result.text, directions }).text, expected);
  });
}

test("another canonical same-term direction to the recipient permits its use", () => {
  const text = '박도훈은 이춘복에게 말했다. "선배님, 안녕하세요."';
  const reciprocal = [
    direction("박도훈", "선배님"),
    { ...direction(persona, "선배님", "박도훈"), targetKey: "persona", isManual: true },
  ];
  assert.equal(sanitize({ text, directions: reciprocal }).text, text);
});

test("ambiguous shared short names cannot establish the speaker", () => {
  const shared = [direction("박도훈", "선배님"), direction("김도훈", "과장님")];
  const text = '도훈은 이춘복을 선배님이라 불렀다.';
  assert.equal(sanitize({ text, directions: shared }).text, text);
  assert.equal(
    sanitize({ text: '박도훈은 이춘복을 선배님이라 불렀다.', directions: shared }).replaced,
    1
  );
});

test("unsupported short names never compile to an empty identity match", () => {
  const text = '는 이춘복을 선배님이라 불렀다.';
  assert.equal(sanitize({ text, directions: [direction("봄", "선배님")] }).text, text);
});

test("fenced metadata and narrative references are byte-for-byte preserved", () => {
  const text = '```INFO\n박도훈은 이춘복을 장인어른이라 불렀다.\n```\n\n유아야, 라는 호명이 들렸다.';
  assert.equal(sanitize({ text, directions }).text, text);
});

test("buffered and every split of streaming text preserve the same name and markers", () => {
  const source = '*최민호는 딸 유아에게 말했다.*\n\n"유아야! 대답해!"\n\n*유아는 고개를 들었다.*';
  assert.equal(sanitize({ text: source, directions }).text, source);
  for (let at = 0; at <= source.length; at++) {
    const stream = createGuardedTextStream((text) => sanitize({ text, directions }).text);
    const output = stream.push(source.slice(0, at)) + stream.push(source.slice(at)) + stream.finish();
    assert.equal(output, source, `split at ${at}`);
    assert.equal(stream.output(), source);
  }
});

test("history and summary replay do not rewrite a valid third-party name", () => {
  const text = '[이전 AI 답변]\n최민호는 유아에게 말했다. "유아야!"\n[장기 요약]\n서지연은 딸을 불렀다. "유아야, 와 봐."';
  for (let replay = 0; replay < 3; replay++) assert.equal(sanitize({ text, directions }).text, text);
});

test("prompt scopes address directions to each pair and does not reserve names for the persona", () => {
  const prompt = formatAddressDirectionGuard(directions);
  assert.match(prompt, /다른 인물도/);
  assert.match(prompt, /이름.*치환하지 않는다/);
});
