/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const Database = require("better-sqlite3");

function loadTs(file, customRequire = require) {
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)(customRequire, loaded, loaded.exports);
  return loaded.exports;
}

const models = loadTs("lib/models.ts");
const ui = loadTs("app/components/chat/ChatArea/textUtils.ts", (id) =>
  id === "@/lib/models" ? models : require(id)
);
const dos = require("../dos-client/dos-chat.js");
const billing = loadTs("app/api/chat/send/_server/billing.ts");
const current = "gemini-3.8-flash";
const aliases = [
  "gemini-3-flash-preview", "gemini-3.1-flash", "gemini-3.5-flash",
  "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.7-flash-preview",
  "google/gemini-3.7-flash", "publishers/google/models/gemini-3.7-flash",
  "gemini-3.8-flash-preview", current,
];

test("current Flash, legacy rooms and provider-prefixed IDs resolve to 3.8", () => {
  assert.equal(models.GEMINI_3_FLASH_MODEL, current);
  assert.deepEqual(models.CHAT_MODEL_IDS, ["gemini-2.5-pro", current, "gemini-3.1-pro-preview"]);
  assert.equal(models.DEFAULT_CHAT_MODEL, "gemini-3.1-pro-preview");
  for (const model of aliases) {
    assert.equal(models.normalizeModelId(model), current, model);
    assert.equal(models.coerceChatModelId(model), current, model);
    assert.equal(models.providerModelNameForGemini(model), current, model);
    assert.equal(models.isCurrentGeminiFlashModel(model), true, model);
    assert.equal(models.isAllowedChatModel(model), true, model);
  }
});

test("web and DOS agree on the model label and LOW/MID/HIGH presets", () => {
  assert.deepEqual(dos.MODELS, models.CHAT_MODEL_IDS);
  assert.equal(dos.MODEL_OPTIONS[1].label, "Gemini 3.8 Flash");
  assert.equal(dos.modelByInput("2"), current);
  assert.equal(dos.modelByInput("Gemini 3.8 Flash"), current);
  for (const model of aliases) {
    assert.equal(ui.getModelDisplayLabel(model), "3.8-flash", model);
    assert.equal(ui.getModelBadge(model).label, "3.8-flash", model);
    assert.equal(dos.modelByInput(model), current, model);
    assert.deepEqual(ui.getReasoningLevelOptions(model), ["low", "middle", "high"]);
    assert.deepEqual(dos.getReasoningPresets(model), { low: 0, middle: 640, high: 1024 });
    for (const [level, tokens] of Object.entries(dos.getReasoningPresets(model))) {
      assert.equal(ui.getReasoningPresets(model)[level], tokens);
      assert.equal(ui.inferReasoningLevel(model, tokens), level);
    }
  }
});

// Execute the production request selection and pre-generation policy together.
// Mock only context/transport helpers; no database or provider is contacted.
const sendRouteSource = fs.readFileSync("app/api/chat/send/route.ts", "utf8");
const requestSelection = sendRouteSource.match(
  /const rtModel =[\s\S]*?(?=\s*try\s*\{\s*console\.log\(JSON\.stringify\(\{\s*tag: "send\.runtime\.pick")/
);
const contextReasoningPolicy = sendRouteSource.match(/const userLine =[\s\S]*?(?=\s*const continueBody =)/);
assert.ok(requestSelection && contextReasoningPolicy, "test the production selection and context policy");
const selectRequestOpts = new Function("scope", ts.transpileModule(`
  const {
    runtime, settings, req, continueMode, userText, personaName, renderMode,
    authorWantsStatus, historySummaryForPrompt, context, dynamicCharacterContext,
    manualCharacterRosterFallback, userTurnCount, debugReasons, strlen,
    buildUserLineForMode, coerceChatModelId, DEFAULT_CHAT_MODEL, ONE_SHOT,
    defaultReasoningTokensForModel, isGemini3FlashModel, isGemini3ProModel,
  } = scope;
  ${requestSelection[0]}
  ${contextReasoningPolicy[0]}
  return opts;
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

function requestScope(overrides = {}) {
  return {
    ...models,
    ONE_SHOT: true,
    runtime: undefined,
    settings: { model: current },
    req: { signal: new AbortController().signal },
    continueMode: false,
    userText: "일주일 후로 스킵하고 이전 관계와 상태를 정리해 줘.",
    personaName: "테스트 사용자", renderMode: "novel",
    authorWantsStatus: true,
    historySummaryForPrompt: "기억".repeat(4500),
    context: "대화".repeat(3500),
    dynamicCharacterContext: { block: "인물".repeat(500) },
    manualCharacterRosterFallback: "", userTurnCount: 50,
    debugReasons: [], strlen: (text) => String(text || "").length,
    buildUserLineForMode: (text) => text,
    ...overrides,
  };
}

test("Flash keeps the selected level even for heavy time-skips and legacy auto-reasoning settings", () => {
  const previous = process.env.CHAT_FLASH_AUTO_REASONING;
  try {
    for (const automatic of [undefined, "1", "0"]) {
      if (automatic === undefined) delete process.env.CHAT_FLASH_AUTO_REASONING;
      else process.env.CHAT_FLASH_AUTO_REASONING = automatic;
      for (const model of [current, "gemini-3.7-flash"]) {
        for (const tokens of [0, 640, 1024]) {
          for (const continueMode of [false, true]) {
            const scope = requestScope({ settings: { model, maxReasoningTokens: tokens }, continueMode });
            const opts = selectRequestOpts(scope);
            assert.equal(opts.maxReasoningTokens, tokens, `${model}, selected=${tokens}, auto=${automatic}`);
            assert.deepEqual(scope.debugReasons, []);
          }
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CHAT_FLASH_AUTO_REASONING;
    else process.env.CHAT_FLASH_AUTO_REASONING = previous;
  }
});

test("Flash uses MID by default but preserves explicit LOW and runtime-over-saved precedence", () => {
  assert.equal(models.defaultReasoningTokensForModel(current), 640);
  assert.equal(selectRequestOpts(requestScope()).maxReasoningTokens, 640);
  for (const tokens of [0, 640, 1024]) {
    const scope = requestScope({
      runtime: { model: current, maxReasoningTokens: tokens },
      settings: { model: current, maxReasoningTokens: 1024 },
    });
    assert.equal(selectRequestOpts(scope).maxReasoningTokens, tokens);
  }
});

test("persisted Flash migration is idempotent and preserves reasoning and output choices", () => {
  const source = fs.readFileSync("lib/db.ts", "utf8");
  const migration = source.match(/`(UPDATE chat_settings\s+SET model=\?[\s\S]*?)`\s*\)\.run\(GEMINI_3_FLASH_MODEL\)/);
  assert.ok(migration, "run the production migration SQL, not a test-only copy");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE chat_settings (chatId TEXT PRIMARY KEY, model TEXT, maxReasoningTokens INTEGER, maxOutputTokens INTEGER)");
    const rows = [
      ["low", "gemini-3.7-flash", 0, 1200],
      ["mid", "gemini-3.7-flash", 640, 1700],
      ["high", "gemini-3.7-flash-preview", 1024, 2500],
      ["older", "gemini-3.6-flash", 640, 1200],
      ["current", current, 0, 1200],
      ["pro", "gemini-3.1-pro-preview", 768, 1700],
    ];
    const insert = db.prepare("INSERT INTO chat_settings VALUES (?, ?, ?, ?)");
    rows.forEach((row) => insert.run(...row));
    assert.equal(db.prepare(migration[1]).run(current).changes, 4);
    assert.equal(db.prepare(migration[1]).run(current).changes, 0);
    for (const [chatId, model, reasoning, output] of rows) {
      assert.deepEqual(db.prepare("SELECT * FROM chat_settings WHERE chatId=?").get(chatId), {
        chatId, model: chatId === "pro" ? model : current,
        maxReasoningTokens: reasoning, maxOutputTokens: output,
      });
    }
  } finally {
    db.close();
  }
});

test("3.8 cost estimates use official introductory pricing and its expiry", () => {
  assert.deepEqual(billing.getModelPricing(current, Date.UTC(2026, 8, 3)), { inPer1M: 0.75, outPer1M: 3.75 });
  assert.deepEqual(billing.getModelPricing(current, Date.UTC(2026, 11, 31, 23, 59, 59)), { inPer1M: 0.75, outPer1M: 3.75 });
  assert.deepEqual(billing.getModelPricing(current, Date.UTC(2027, 0, 1)), { inPer1M: 1.5, outPer1M: 7.5 });
});

function mockAi() {
  const requests = [];
  const response = {
    text: "정상 응답입니다.",
    candidates: [{ content: { role: "model", parts: [{ text: "정상 응답입니다." }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 2, totalTokenCount: 20 },
  };
  class GoogleGenAI {
    constructor() {
      this.models = {
        generateContent: async (req) => { requests.push(req); return response; },
        generateContentStream: async (req) => {
          requests.push(req);
          return (async function* () { yield response; })();
        },
      };
    }
  }
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-no-network";
  try {
    const ai = loadTs("lib/ai.ts", (id) => {
      if (id === "@google/genai") return { GoogleGenAI };
      if (id === "@/lib/models") return models;
      return require(id);
    });
    return { ai, requests };
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
}

test("normal and streaming calls send 3.8 with supported thinking and no sampling/prefill", async () => {
  const { ai, requests } = mockAi();
  for (const streaming of [false, true]) {
    for (const model of [current, "gemini-3.7-flash", "google/gemini-3.7-flash-preview"]) {
      for (const [tokens, level] of [[0, "low"], [640, "medium"], [1024, "high"]]) {
        const before = requests.length;
        const params = {
          system: "테스트", user: "응답해 주세요.",
          opts: { model, maxOutputTokens: 1200, maxReasoningTokens: tokens,
            temperature: 0.7, topP: 0.9, topK: 32, disableRefusalFallback: true },
        };
        if (streaming) {
          const generated = await ai.generateTextStream(params);
          let text = "";
          for await (const delta of generated.stream) text += delta;
          const final = await generated.final;
          assert.equal(text, "정상 응답입니다.");
          assert.equal(final.text, text);
        } else {
          assert.equal((await ai.generateText(params)).text, "정상 응답입니다.");
        }
        assert.equal(requests.length, before + 1, "no extra generation call");
        const req = requests.at(-1);
        assert.equal(req.model, current);
        assert.deepEqual(req.config.thinkingConfig, { thinkingLevel: level });
        for (const unsupported of ["temperature", "topP", "topK", "candidateCount", "frequencyPenalty", "presencePenalty"]) {
          assert.equal(unsupported in req.config, false, unsupported);
        }
        assert.deepEqual(req.contents.map((turn) => turn.role), ["user"]);
      }
    }
  }
});
