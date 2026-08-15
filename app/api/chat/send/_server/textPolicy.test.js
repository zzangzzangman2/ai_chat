/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTextPolicy() {
  const source = fs.readFileSync(path.join(__dirname, "textPolicy.ts"), "utf8");
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
  formatStoryTurnsForMode,
  selectMessagesBeforeCurrentUser,
} = loadTextPolicy();

test("current user turn is excluded from historical prompt context", () => {
  const messages = [
    { id: "u1", role: "user", content: "첫 행동" },
    { id: "a1", role: "assistant", content: "첫 반응" },
    { id: "u2", role: "user", content: "지금 행동" },
  ];

  assert.deepEqual(
    selectMessagesBeforeCurrentUser(messages, "u2").map((message) => message.id),
    ["u1", "a1"]
  );
});

test("regenerating an older turn excludes its old reply and future turns", () => {
  const messages = [
    { id: "u1", role: "user", content: "첫 행동" },
    { id: "a1", role: "assistant", content: "교체할 반응" },
    { id: "u2", role: "user", content: "미래 행동" },
    { id: "a2", role: "assistant", content: "미래 반응" },
  ];

  assert.deepEqual(
    selectMessagesBeforeCurrentUser(messages, "u1").map((message) => message.id),
    []
  );
});

test("novel history keeps explicit user and assistant roles", () => {
  const context = formatStoryTurnsForMode(
    [
      { role: "user", content: "*문을 열었다*" },
      { role: "assistant", content: '"누구세요?"' },
    ],
    "주인공",
    "상대",
    "novel"
  );

  assert.match(context, /^\[PREVIOUS USER TURN\]\n\*문을 열었다\*/);
  assert.match(context, /\[PREVIOUS ASSISTANT TURN\]\n"누구세요\?"$/);
});
