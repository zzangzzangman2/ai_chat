const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync("lib/novel_export.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const {
  buildNovelSourceChunks,
  cleanNovelSourceText,
  parseGeneratedNovelChapter,
  safeNovelFilename,
} = moduleObj.exports;

test("removes UI-only panels while retaining narrative source", () => {
  const cleaned = cleanNovelSourceText([
    "지은은 방문을 열었다.",
    "",
    "STATUS: 생성 완료",
    "{{img:https://example.invalid/a.png}}",
    "<<<END_OF_OUTPUT>>>",
  ].join("\n"));
  assert.equal(cleaned, "지은은 방문을 열었다.");
});

test("keeps every user and assistant message in chronological turn groups", () => {
  const messages = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    messages.push({ role: "user", content: `USER-${turn} ${"가".repeat(1800)}` });
    messages.push({ role: "assistant", content: `ASSISTANT-${turn} ${"나".repeat(1800)}` });
  }
  const chunks = buildNovelSourceChunks(messages, { maxChars: 6000, maxUserTurns: 4 });
  assert.ok(chunks.length >= 3);
  const combined = chunks.map((chunk) => chunk.source).join("\n");
  for (let turn = 1; turn <= 6; turn += 1) {
    assert.equal((combined.match(new RegExp(`USER-${turn}`, "g")) || []).length, 1);
    assert.equal((combined.match(new RegExp(`ASSISTANT-${turn}`, "g")) || []).length, 1);
    assert.match(combined, new RegExp(`주인공 원문 · ${turn}턴[\\s\\S]*ASSISTANT-${turn}`));
  }
  assert.deepEqual(chunks.map((chunk) => [chunk.startTurn, chunk.endTurn]), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]);
});

test("parses a generated chapter title and normalizes a safe PDF filename", () => {
  const chapter = parseGeneratedNovelChapter("# 어둠 속의 방문\n\n첫 문단.\n\n둘째 문단.", {
    index: 2,
    startTurn: 5,
    endTurn: 8,
  });
  assert.equal(chapter.title, "제 2화 어둠 속의 방문");
  assert.equal(chapter.body, "첫 문단.\n\n둘째 문단.");
  assert.equal(safeNovelFilename('밤: 별? <초고>'), "밤 별 초고-웹소설.pdf");
});
