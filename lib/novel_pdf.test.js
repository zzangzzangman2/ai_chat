/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const textCalls = [];

class FakePdfDocument {
  constructor(options) {
    this.page = {
      width: 420,
      height: 595,
      margins: { ...options.margins },
    };
    this.handlers = new Map();
    this.pages = [this.page];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  once(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  registerFont() { return this; }
  rect() { return this; }
  fill() { return this; }
  fillColor() { return this; }
  font() { return this; }
  fontSize() { return this; }
  moveDown() { return this; }
  heightOfString() { return 18; }

  text(value, ...args) {
    const options = args.find((arg) => arg && typeof arg === "object") || {};
    textCalls.push({ value: String(value), options, page: this.pages.indexOf(this.page) });
    return this;
  }

  addPage() {
    this.page = {
      width: 420,
      height: 595,
      margins: { top: 50, right: 44, bottom: 50, left: 44 },
    };
    this.pages.push(this.page);
    return this;
  }

  bufferedPageRange() {
    return { start: 0, count: this.pages.length };
  }

  switchToPage(index) {
    this.page = this.pages[index];
    return this;
  }

  end() {
    this.handlers.get("data")?.(Buffer.from("pdf"));
    this.handlers.get("end")?.();
  }
}

const source = fs.readFileSync("lib/novel_pdf.ts", "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText;
const moduleObj = { exports: {} };
const customRequire = (id) => {
  if (id === "pdfkit") return FakePdfDocument;
  if (id === "@/lib/novel_export") return {};
  return require(id);
};
new Function("require", "module", "exports", js)(customRequire, moduleObj, moduleObj.exports);
const { buildNovelPdf } = moduleObj.exports;

test("novel PDF hides export metadata and aligns narration with dialogue", async () => {
  textCalls.length = 0;
  await buildNovelPdf({
    title: "창작물 빙의 시뮬레이션",
    author: "테스트",
    generatedAt: new Date("2026-08-26T00:00:00Z"),
    chapters: [{
      index: 1,
      title: "제 1화 문을 연 사람",
      body: "지문 첫 문단입니다.\n\n\"대화 문단입니다.\"\n\n이어지는 지문입니다.",
      startTurn: 1,
      endTurn: 24,
    }],
  });

  assert.equal(textCalls.filter((call) => call.value === "창작물 빙의 시뮬레이션").length, 1);
  assert.equal(textCalls.some((call) => /원문\s*1-24턴/u.test(call.value)), false);
  assert.equal(textCalls.some((call) => /전체 채팅|메시지를 바탕으로/u.test(call.value)), false);

  const bodyCalls = textCalls.filter((call) =>
    ["지문 첫 문단입니다.", "\"대화 문단입니다.\"", "이어지는 지문입니다."].includes(call.value)
  );
  assert.equal(bodyCalls.length, 3);
  assert.deepEqual(bodyCalls.map((call) => call.options.indent), [0, 0, 0]);
  assert.deepEqual(bodyCalls.map((call) => call.options.lineGap), [4.4, 4.4, 4.4]);
  assert.deepEqual(bodyCalls.map((call) => call.options.paragraphGap), [9, 9, 9]);
});

test("puts introduction and contents before chapters and character profiles on the last pages", async () => {
  textCalls.length = 0;
  await buildNovelPdf({
    title: "유리문 너머의 낮", introduction: "닫힌 문을 두드리는 낯선 손님.",
    chapters: [
      { index: 1, title: "제 1화 방문", body: "첫 번째 장 본문.", startTurn: 1, endTurn: 2 },
      { index: 2, title: "제 2화 재회", body: "마지막 장 본문.", startTurn: 3, endTurn: 4 },
    ],
    characters: [{ name: "지은", introduction: "문을 연 사람." }, { name: "민수", introduction: "찾아온 손님." }],
  });
  const firstPageFor = (text) => textCalls.find((call) => call.value === text)?.page;
  assert.equal(firstPageFor("유리문 너머의 낮"), 0);
  assert.equal(firstPageFor("작품 소개"), 1);
  assert.equal(firstPageFor("목차"), 2);
  assert.equal(firstPageFor("제 1화 방문"), 2);
  assert.equal(firstPageFor("첫 번째 장 본문."), 3);
  assert.equal(firstPageFor("마지막 장 본문."), 4);
  assert.deepEqual(textCalls.filter((call) => call.value === "등장인물 소개").map((call) => call.page), [2, 5]);
  assert.equal(firstPageFor("지은"), 5);
  assert.equal(firstPageFor("문을 연 사람."), 5);
  assert.equal(firstPageFor("찾아온 손님."), 5);
});
