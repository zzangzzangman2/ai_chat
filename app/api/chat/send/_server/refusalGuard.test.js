/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const NEWLINE = String.fromCharCode(10);
const ts = require("typescript");

function loadRefusalGuard() {
  const source = fs.readFileSync(path.join(__dirname, "refusalGuard.ts"), "utf8");
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

const {
  inspectRefusalOutput,
  isRefusalLikeOutput,
  refusalRerollMax,
  refusalRerollSamplingOverride,
  widenSamplingForReroll,
} = loadRefusalGuard();

test("빈 응답을 거부로 판정한다", () => {
  assert.equal(inspectRefusalOutput("").reason, "empty_output");
  assert.equal(inspectRefusalOutput("   \n  ").reason, "empty_output");
});

test("streamFinal이 넣는 STATUS 안내 블록을 거부로 판정한다", () => {
  const status = [
    "```STATUS",
    "error: empty_output",
    "note: 모델이 빈 응답(또는 차단된 응답)을 반환했습니다.",
    "```",
  ].join("\n");
  assert.equal(inspectRefusalOutput(status).reason, "empty_output");
});

test("메타 블록만 있고 서사 본문이 없으면 거부로 판정한다", () => {
  const infoOnly = [
    "```INFO",
    "위치: 타워 200층",
    "임시규칙: 안전 정책 위반으로 인한 생성 중단",
    "```",
  ].join("\n");
  assert.equal(inspectRefusalOutput(infoOnly).reason, "empty_output");
});

test("모델 거부문을 판정한다 (한국어/영어)", () => {
  assert.ok(isRefusalLikeOutput("죄송합니다. 해당 요청은 안전 정책에 따라 생성할 수 없습니다."));
  assert.ok(isRefusalLikeOutput("요청하신 내용에는 응답할 수 없습니다."));
  assert.ok(isRefusalLikeOutput("I'm sorry, but I can't help with that request."));
});

test("거부문이 지문 마커로 감싸여 있어도 판정한다", () => {
  // textPolicy가 거부 문장을 *...*로 감싸는 경로가 있어서, 마커 유무로는 구분할 수 없다.
  assert.ok(isRefusalLikeOutput("*죄송합니다. 요청하신 내용은 생성할 수 없습니다.*"));
});

test("극중 인물의 사과 대사는 거부가 아니다", () => {
  const inCharacter = [
    "*그녀는 고개를 깊이 숙였다.*",
    "",
    '"죄송해요…… 정말 죄송해요…… 제발 용서해주세요……"',
  ].join("\n");
  assert.equal(isRefusalLikeOutput(inCharacter), false);
});

test("인물의 거절 대사는 따옴표 종류와 무관하게 모델 거부가 아니다", () => {
  for (const [open, close] of [['"', '"'], ["“", "”"], ["「", "」"], ["『", "』"]]) {
    assert.equal(isRefusalLikeOutput(`${open}못 하겠습니다. 그 자료는 제공할 수 없습니다.${close}`), false);
    assert.equal(isRefusalLikeOutput(`*민수는 고개를 저었다.*\n\n${open}도와드릴 수 없습니다.${close}`), false);
  }
});

test("인물의 거절을 전달하는 간접화법은 모델 거부가 아니다", () => {
  for (const scene of [
    "*민수는 그 자료를 제공할 수 없다고 말했다.*",
    "*그녀는 지금은 도와드릴 수 없다며 조용히 대답했다.*",
    "*그는 계속할 수 없다면서 중얼거렸다.*",
  ]) {
    assert.equal(isRefusalLikeOutput(scene), false, scene);
  }
});

test("인용문이나 극중 대사가 있어도 바깥의 실제 모델 거부는 유지한다", () => {
  for (const refusal of [
    '요청하신 "장면"은 생성할 수 없습니다.',
    '"다음에 만나자."\n\n죄송합니다. 해당 요청은 처리할 수 없습니다.',
    '*민수는 도와드릴 수 없다고 말했다.*\n\n요청하신 내용에는 응답할 수 없습니다.',
    '*민수는 도와드릴 수 없다고 말했다.*\n\n죄송합니다. 이 요청은 도와드릴 수 없습니다.',
    'I cannot help with the request "continue the scene".',
  ]) {
    assert.equal(inspectRefusalOutput(refusal).reason, "model_refusal", refusal);
  }
});

test("명시적인 차단 STATUS는 극중 대사보다 우선한다", () => {
  assert.equal(inspectRefusalOutput('"못 하겠습니다."\n```STATUS\nerror: blocked_output\n```').reason, "blocked_output");
});

test("정상 서사는 거부가 아니다", () => {
  const scene = [
    "*창밖으로 번지는 빗소리를 오래 듣고 있던 그는 천천히 고개를 돌렸다. 방 안의 공기가 무겁게 가라앉았다.*",
    "",
    '"…이제 어떻게 할 생각이야?"',
  ].join("\n");
  assert.equal(isRefusalLikeOutput(scene), false);
});

test("긴 본문은 거부 문구가 섞여 있어도 거부로 보지 않는다", () => {
  // 장면 안에서 인물이 정책이나 규칙을 언급할 수 있다. 거부문은 짧다는 성질로 가른다.
  const long = "*".concat("그는 안전 지침을 떠올렸다. ".repeat(60), "*");
  assert.equal(isRefusalLikeOutput(long), false);
});

// (2026-09-04) 실제로 DB에 저장돼 버린 거부문. gemini-3.8-flash는 비스트리밍으로 도는데
// 리롤 루프가 스트리밍 경로 안에만 있어서 한 번도 다시 굴리지 않았다.
// 판정 자체는 통과했음을 고정해 둔다(회귀 시 원인을 다시 헤매지 않도록).
test("한국어 상태창이 붙은 거부문을 거부로 판정한다", () => {
  const stored = [
    "*성폭력이나 비동의적 성행위를 묘사하는 내용은 생성할 수 없습니다.*",
    "",
    "```상태",
    "날짜: 2026년 3월 2일 10:01",
    "장소: 안양소년원 2층 원장실",
    "빙의: 1일차",
    "호감도: 박민지 -15 | 김태철 -18 | 정수아 -30 | 박형식 15 | 최정훈 0",
    "```",
  ].join(NEWLINE);
  const check = inspectRefusalOutput(stored);
  assert.equal(check.refused, true);
  assert.equal(check.reason, "model_refusal");
});

test("자동 리롤은 레거시 환경변수 값과 무관하게 항상 꺼져 있다", () => {
  const prev = process.env.AI_REFUSAL_REROLL_MAX;
  try {
    delete process.env.AI_REFUSAL_REROLL_MAX;
    assert.equal(refusalRerollMax(), 0);
    for (const value of ["0", "1", "5", "10", "99", "-3", "not-a-number", ""]) {
      process.env.AI_REFUSAL_REROLL_MAX = value;
      assert.equal(refusalRerollMax(), 0, value);
    }
  } finally {
    if (prev === undefined) delete process.env.AI_REFUSAL_REROLL_MAX;
    else process.env.AI_REFUSAL_REROLL_MAX = prev;
  }
});

test("실제 스트리밍/버퍼드 경로는 거절·빈 응답·차단 후 추가 생성이나 재시도 알림을 보내지 않는다", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "route.ts"), "utf8");
  const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const retryBlocks = [];
  function visit(node) {
    if (ts.isBlock(node) && node.statements.length === 2 &&
        ts.isVariableStatement(node.statements[0]) && ts.isWhileStatement(node.statements[1]) &&
        node.statements[0].getText(ast).includes("const maxRerolls = refusalRerollMax()")) {
      retryBlocks.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(retryBlocks.length, 2, "both transport paths must use the disabled retry policy");

  for (const block of retryBlocks) {
    for (const text of ["요청하신 내용에는 응답할 수 없습니다.", "", "```STATUS\nerror: blocked_output\n```", "정상 응답입니다."]) {
      let calls = 0;
      const events = [];
      const generate = async () => {
        calls += 1;
        return { text, combinedRaw: text };
      };
      const run = new Function("refusalRerollMax", "inspectRefusalOutput", "generate", "safeEnqueue", `
        return (async () => {
          let generation = await generate();
          let first = generation;
          let refusalRerollAttempt = 0;
          const runMainGeneration = generate;
          const runFirstGeneration = generate;
          ${block}
          return { generation, first, refusalRerollAttempt };
        })();
      `);
      const result = await run(refusalRerollMax, inspectRefusalOutput, generate, (event) => events.push(event));
      assert.equal(calls, 1, "only the original generation may run");
      assert.equal(result.refusalRerollAttempt, 0);
      assert.equal(result.generation.combinedRaw, text);
      assert.equal(result.first.text, text);
      assert.deepEqual(events, []);
    }
  }
});

test("리롤 회차마다 샘플링이 넓어진다", () => {
  // 같은 temperature로 다시 굴리면 같은 거부가 재현되므로, 회차가 오르면 반드시 넓어져야 한다.
  assert.deepEqual(refusalRerollSamplingOverride(0), {});
  const a1 = refusalRerollSamplingOverride(1);
  const a2 = refusalRerollSamplingOverride(2);
  assert.ok(a1.temperature > 0.18);
  assert.ok(a2.temperature > a1.temperature);
  assert.ok(a2.topP > a1.topP);
  assert.ok(a2.topK > a1.topK);
});

test("샘플링 확장에는 상한이 있다", () => {
  const hot = widenSamplingForReroll({ temperature: 0.18, topP: 0.82, topK: 32 }, 99);
  assert.ok(hot.temperature <= 1.1);
  assert.ok(hot.topP <= 0.98);
  assert.ok(hot.topK <= 64);
});
