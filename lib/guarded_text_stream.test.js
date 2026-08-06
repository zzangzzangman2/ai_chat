/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuardedTextStream() {
  const source = fs.readFileSync(
    path.join(__dirname, "guarded_text_stream.ts"),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    require
  );
  return loaded.exports;
}

const { createGuardedTextStream } = loadGuardedTextStream();

test("guarded stream preserves ordinary text and paragraph spacing exactly", () => {
  const gate = createGuardedTextStream((text) => text);
  const chunks = ["첫 문", "장이다.\n\n", "둘째 문장", "이다.\n"];
  const output = chunks.map((chunk) => gate.push(chunk)).join("") + gate.finish();

  assert.equal(output, chunks.join(""));
  assert.equal(gate.output(), chunks.join(""));
});

test("guarded stream validates a complete sentence before emitting it", () => {
  const gate = createGuardedTextStream((text) =>
    text.replace("당신은 피의자입니다.", "")
  );
  const first = gate.push("복도에 들어왔다.\n\n당신은 피의");
  const second = gate.push("자입니다.\n\n방문 목적을 확인했다.");
  const tail = gate.finish();

  assert.equal(first, "복도에 들어왔다.\n\n");
  assert.equal(second, "");
  assert.equal(tail, "방문 목적을 확인했다.");
  assert.equal(gate.output(), "복도에 들어왔다.\n\n방문 목적을 확인했다.");
});

test("guarded stream holds a fenced block until the closing fence arrives", () => {
  const gate = createGuardedTextStream((text) => text);

  assert.equal(gate.push("```STATUS\n피의자: 아님\n"), "");
  assert.equal(gate.push("```\n\n다음 문장이다. "), "```STATUS\n피의자: 아님\n```\n\n다음 문장이다. ");
  assert.equal(gate.finish(), "");
});
