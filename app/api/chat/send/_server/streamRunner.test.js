const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const guardModule = { exports: {} };
Function("exports", "module", "require", transpile("lib/turn_completion_guard.ts"))(
  guardModule.exports,
  guardModule,
  require
);
const runnerModule = { exports: {} };
const localRequire = (id) =>
  id.endsWith("lib/turn_completion_guard") ? guardModule.exports : require(id);
Function("exports", "module", "require", transpile(path.join(__dirname, "streamRunner.ts")))(
  runnerModule.exports,
  runnerModule,
  localRequire
);
const { runOptionalShortContinue } = runnerModule.exports;

const passthroughParams = {
  allowSecondCalls: false,
  oneShot: true,
  disallowG3ProContinue: true,
  promptMinForGuide: 300,
  promptMaxChars: 1200,
  maxOutputTokensForCall: 1200,
  combinedUsage: { finishReason: "STOP", outputTokens: 100 },
  systemForContinuation: "continue",
  opts: { maxReasoningTokens: 768 },
  mergeUsage: (base, add) => ({ ...base, ...add }),
  safeEnqueue: () => {
    throw new Error("bounded recovery must publish a replacement, not a trailing delta");
  },
  stripEndMarker: (value) => String(value || ""),
  stripStandaloneSeparatorLines: (value) => String(value || ""),
  stripUrlsAndMediaMarkdown: (value) => String(value || ""),
  streamDebug: false,
  streamTag: "test",
};

test("bounded recovery repairs short STOP while preserving one trailing panel", async () => {
  let calls = 0;
  let promptReasons = [];
  const fence = "```";
  const result = await runOptionalShortContinue({
    ...passthroughParams,
    raw: `*둘은 서로를 바라봤다.*\n\n"저는 혜진이요."${fence}상태\n날짜: 10:07\n${fence}`,
    currentUserText: "너네 학교에서 제일 예쁜 애가 누구야?",
    allowBoundedRecovery: true,
    makeContinueUser: (body, reasons) => {
      assert.doesNotMatch(body, /```/u);
      promptReasons = reasons;
      return "continue";
    },
    generateText: async () => {
      calls += 1;
      return {
        text: `*다른 아이도 고개를 들었다.*\n\n"저도 혜진이라고 생각해요."\n\n${fence}상태\n잘못된 중복 상태\n${fence}`,
        usage: { finishReason: "STOP", outputTokens: 80 },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.replaced, true);
  assert.deepEqual(promptReasons, ["SHORT_BODY", "PLURAL_RESPONSE_INCOMPLETE"]);
  assert.match(result.raw, /다른 아이도 고개를 들었다/u);
  assert.equal((result.raw.match(/```상태/gu) || []).length, 1);
  assert.match(result.raw, /날짜: 10:07\n```$/u);
});

test("complete STOP remains one-shot", async () => {
  let calls = 0;
  const result = await runOptionalShortContinue({
    ...passthroughParams,
    raw: '*둘은 차례로 답했다.*\n\n"첫 답이에요."\n\n"두 번째 답이에요."',
    currentUserText: "둘 다 대답해",
    promptMinForGuide: 20,
    allowBoundedRecovery: true,
    makeContinueUser: () => "continue",
    generateText: async () => {
      calls += 1;
      return { text: "unexpected", usage: {} };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.replaced, false);
});
