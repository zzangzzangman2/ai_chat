"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const Database = require("better-sqlite3");

// Extract only the production functions under test: importing the route would
// initialize the user's database and provider configuration.
const source = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");
const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
function compile(text) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function declarations(names) {
  return ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(ast)).join("\n");
}
function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE chat_memory_blocks(chatId TEXT, startTurn INTEGER, endTurn INTEGER, meta TEXT, PRIMARY KEY(chatId,startTurn))");
  const names = ["throwIfMemoryRefreshAborted", "parseMemoryBlockMeta", "loadPendingMemoryWork", "updateMemoryBlockMeta"];
  const helpers = Function("db", compile(declarations(names)) + `\nreturn {${names.join(",")}};`)(db);
  return { db, ...helpers };
}
function summaryAttempt(f, signal) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runSummaryAttempt") initializer = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const errors = [];
  const run = Function("req", "generationErrors", "throwIfMemoryRefreshAborted",
    compile(`const attempt=${initializer};`) + "\nreturn attempt;"
  )({ signal }, errors, f.throwIfMemoryRefreshAborted);
  return { run, errors };
}
test("aborted summary attempts propagate and never become successful fallback input", async () => {
  const f = fixture();
  try {
    const a = summaryAttempt(f, new AbortController().signal);
    await assert.rejects(a.run("primary", async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }), { name: "AbortError" });
    assert.deepEqual(a.errors, []);
    const controller = new AbortController();
    const b = summaryAttempt(f, controller.signal);
    await assert.rejects(b.run("primary", async () => { controller.abort(); return "completed text"; }), { name: "AbortError" });
  } finally { f.db.close(); }
});
test("ordinary provider errors remain eligible for provisional preservation", async () => {
  const f = fixture();
  try {
    const a = summaryAttempt(f, new AbortController().signal);
    assert.equal(await a.run("primary", async () => { throw new Error("429 Resource exhausted"); }), "");
    assert.deepEqual(a.errors, ["primary:429 Resource exhausted"]);
  } finally { f.db.close(); }
});
test("legacy truncated fallbacks remain pending until a real replacement clears the marker", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO chat_memory_blocks VALUES (?,?,?,?)").run("chat", 1, 3, JSON.stringify({ deterministicFallbackUsed: true, customEvidence: "kept" }));
    assert.deepEqual(f.loadPendingMemoryWork("chat", 300).summary, { startTurn: 1, endTurn: 3, title: "대화 자동 보존", lastAttemptAt: 0 });
    f.updateMemoryBlockMeta("chat", 1, { summaryRepairPending: false });
    assert.equal(f.loadPendingMemoryWork("chat", 300).summary, null);
    assert.equal(JSON.parse(f.db.prepare("SELECT meta FROM chat_memory_blocks").get().meta).customEvidence, "kept");
  } finally { f.db.close(); }
});
test("failed graph extraction keeps its exact old range across later summary progress", () => {
  const f = fixture();
  try {
    const insert = f.db.prepare("INSERT INTO chat_memory_blocks VALUES (?,?,?,?)");
    insert.run("chat", 10, 12, JSON.stringify({ structuredGraphPending: { startTurn: 1, endTurn: 12 } }));
    insert.run("chat", 298, 300, "{}");
    assert.deepEqual(f.loadPendingMemoryWork("chat", 300).graph, { blockStartTurn: 10, startTurn: 1, endTurn: 12, lastAttemptAt: 0 });
    f.updateMemoryBlockMeta("chat", 10, { structuredGraphPending: null });
    assert.equal(f.loadPendingMemoryWork("chat", 300).graph, null);
  } finally { f.db.close(); }
});
test("pending work belonging to undone future turns is excluded", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO chat_memory_blocks VALUES (?,?,?,?)").run("chat", 10, 12,
      JSON.stringify({ summaryRepairPending: true, structuredGraphPending: { startTurn: 1, endTurn: 12 } }));
    assert.deepEqual(f.loadPendingMemoryWork("chat", 9), { summary: null, graph: null });
  } finally { f.db.close(); }
});

test("cancelled graph extraction cannot apply character or fact changes", async () => {
  const f = fixture();
  const controller = new AbortController();
  const deps = {
    db: { prepare: () => ({ all: () => [{ name: "기존인물" }] }) },
    throwIfMemoryRefreshAborted: f.throwIfMemoryRefreshAborted,
    buildAuthoritativePersonaFacts: () => [],
    loadStructuredCharacterIdentities: () => [],
    loadCanonicalCharacterFacts: () => [],
    extractStructuredCharacterGraph: async () => {
      controller.abort();
      return { ok: false, characters: [], relationships: [], facts: [] };
    },
    withCurrentChatHistory: () => { throw new Error("must not write"); },
    StaleChatHistoryError: class extends Error {},
  };
  const refresh = Function(...Object.keys(deps), compile(declarations(["refreshStructuredCharacterState"])) + "\nreturn refreshStructuredCharacterState;")(...Object.values(deps));
  try {
    await assert.rejects(refresh({ chatId: "chat", signal: controller.signal }), { name: "AbortError" });
  } finally { f.db.close(); }
});

test("summary and graph repairs alternate even when both keep failing", async () => {
  const f = fixture();
  const insert = f.db.prepare("INSERT INTO chat_memory_blocks VALUES (?,?,?,?)");
  insert.run("chat", 1, 3, JSON.stringify({ summaryRepairPending: true }));
  insert.run("chat", 10, 12, JSON.stringify({ structuredGraphPending: { startTurn: 1, endTurn: 12 } }));
  const selection = source.slice(source.indexOf("    const repairMetaRow = repair ?"), source.indexOf("    // 이미 장기요약이 끝난 기존 채팅이라도"));
  assert.ok(selection.includes("structuredGraphAttemptedAt"));
  let graphAttempts = 0;
  const dependencies = {
    db: f.db, chatId: "chat", summarizedEndTurn: 300, boundaryEndTurn: 300,
    historySnapshot: {}, personaName: "", personaAge: 0, personaGender: "", personaInfo: "", summaryModel: "stub", all: [], req: { signal: new AbortController().signal },
    loadPendingMemoryWork: f.loadPendingMemoryWork, parseMemoryBlockMeta: f.parseMemoryBlockMeta,
    updateMemoryBlockMeta: f.updateMemoryBlockMeta, throwIfMemoryRefreshAborted: f.throwIfMemoryRefreshAborted,
    withCurrentChatHistory: (_snapshot, run) => run(),
    refreshStructuredCharacterState: async () => { graphAttempts++; return { structuredGraphParsed: false }; },
    stripUrlsAndMediaMarkdown: value => value, formatTurnsLocal: () => "", selectMessagesForAssistantTurnRange: () => [],
    NextResponse: { json: value => value },
  };
  const run = Function(...Object.keys(dependencies), compile(`async function run(){
    const pendingWork=loadPendingMemoryWork(chatId,boundaryEndTurn);
    const repair=pendingWork.summary;
    ${selection}
    return { summaryRepairReached: true };
  }`) + "\nreturn run;")(...Object.values(dependencies));
  try {
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await run());
    assert.deepEqual(outcomes.map(result => Boolean(result.summaryRepairReached)), [true, false, true, false]);
    assert.equal(graphAttempts, 2);
    assert.ok(f.loadPendingMemoryWork("chat", 300).summary);
    assert.ok(f.loadPendingMemoryWork("chat", 300).graph);
    f.updateMemoryBlockMeta("chat", 1, { summaryRepairPending: false });
    assert.equal((await run()).reason, "pending_graph_retry");
  } finally { f.db.close(); }
});

test("successful catch-up does not back off merely because an older graph is pending", () => {
  let expression;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "retryNeeded") expression = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const needsRetry = Function("deterministicFallbackUsed", "forcedBadOutputSaved", "shouldRefreshStructuredGraph", "pendingWork", "structuredGraphParsed", `return ${expression};`);
  assert.equal(needsRetry(false, false, false, { graph: {} }, false), false);
  assert.equal(needsRetry(false, false, true, { graph: {} }, false), false);
  assert.equal(needsRetry(false, false, true, { graph: null }, false), true);
  assert.equal(needsRetry(false, false, true, { graph: null }, true), false);
  assert.equal(needsRetry(true, false, false, { graph: null }, false), true);
});

test("replacing a summary preserves an independent graph retry on the same block", () => {
  let expression;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "structuredGraphPending" &&
        node.initializer.getText(ast).includes("previousBlockMeta")) expression = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression);
  const pending = { startTurn: 1, endTurn: 3 };
  const next = Function("previousBlockMeta", "shouldRefreshStructuredGraph", "graphWindowStartTurn", "windowEndTurn", `return ${expression};`);
  assert.equal(next({ structuredGraphPending: pending }, false, 1, 3), pending);
  assert.deepEqual(next({}, true, 13, 24), { startTurn: 13, endTurn: 24 });
  assert.equal(next({}, false, 13, 24), null);
});
