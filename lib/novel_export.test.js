/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync("lib/novel_export.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const {
  buildNovelSourceChunks,
  buildNovelChapterPrompt,
  buildNovelSystemPrompt,
  chooseGeneratedNovelTitle,
  collectNovelCharacters,
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

test("retains diegetic digital text but removes app status panels", () => {
  const cleaned = cleanNovelSourceText([
    "```상태",
    "장소: 거실",
    "```",
    "```message",
    "[지은] 지금 도착했어.",
    "```",
  ].join("\n"));
  assert.doesNotMatch(cleaned, /장소: 거실/u);
  assert.match(cleaned, /\[지은\] 지금 도착했어\./u);
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

test("uses a generated story title instead of a chat-room title", () => {
  const chapter = parseGeneratedNovelChapter(
    "작품 제목: 유리문 너머의 낮\n화 제목: 돌아온 사람\n\n첫 문단.",
    { index: 1, startTurn: 1, endTurn: 24 }
  );
  assert.equal(chapter.novelTitle, "유리문 너머의 낮");
  assert.equal(chapter.title, "제 1화 돌아온 사람");
  assert.equal(chapter.body, "첫 문단.");
  assert.equal(chooseGeneratedNovelTitle([chapter]), "유리문 너머의 낮");

  const fallback = { ...chapter, novelTitle: undefined, title: "제 1화 돌아온 사람" };
  assert.equal(chooseGeneratedNovelTitle([fallback]), "돌아온 사람");
});

test("removes duplicated episode and chapter numbers from generated titles", () => {
  const chapter = parseGeneratedNovelChapter("제 8화 8장. 공범\n\n본문.", {
    index: 8,
    startTurn: 169,
    endTurn: 192,
  });
  assert.equal(chapter.title, "제 8화 공범");
  assert.equal(chapter.body, "본문.");

  const labeled = parseGeneratedNovelChapter("화 제목: 제8장: 공범\n\n본문.", {
    index: 8,
    startTurn: 169,
    endTurn: 192,
  });
  assert.equal(labeled.title, "제 8화 공범");
});

test("uses the current Korean web-novel style profile without forcing trendy tropes", () => {
  const system = buildNovelSystemPrompt();
  const chapter = buildNovelChapterPrompt({
    chunkIndex: 1,
    chunkCount: 2,
    previousTail: "",
    source: "[주인공 원문 · 1턴]\n문을 열었다.",
  });
  assert.match(system, /2025-2026년/u);
  assert.match(system, /모바일 스크롤/u);
  assert.match(system, /한 문단은 1-3문장/u);
  assert.match(system, /회귀·빙의·상태창을 유행이라는 이유로 만들지 않는다/u);
  assert.match(system, /허공을 가르다/u);
  assert.match(system, /인물이 모르는 사실을 전지적으로 확정하지 않는다/u);
  assert.match(system, /지문과 대사는 모두 들여쓰기 없이 같은 왼쪽 선/u);
  assert.match(system, /채팅방 제목, 원문 범위, 메시지 수/u);
  assert.match(system, /채팅방 제목을 작품 제목으로 복사하지 않는다/u);
  assert.match(system, /같은 종결 리듬이 세 문장 연속 이어지지 않게 퇴고/u);
  assert.match(system, /~했고\.', '~하는데\.'/u);
  assert.match(system, /단문·중문·조금 긴 문장/u);
  assert.match(chapter, /다음 사건을 미리 만들지 않는다/u);
  assert.match(chapter, /별도 프롤로그를 만들지 말고/u);
  assert.match(chapter, /novelTitle에 새로 지은 작품 제목/u);
  assert.match(chapter, /채팅방 제목은 참고하거나 복사하지 않는다/u);
  assert.match(chapter, /본문에는 장 제목을 다시 쓰거나 원문 턴 범위/u);
  assert.match(chapter, /문단 사이는 빈 줄 하나로 통일/u);
  assert.match(chapter, /동일한 과거형 종결 3연속/u);
  assert.match(chapter, /짧은 단문 5연속/u);
  assert.match(chapter, /검수 과정은 출력하지 않는다/u);
  assert.match(system, /등장인물 소개는 책 맨 뒤 부록에만/u);
  assert.match(system, /본문에 끼워 넣지 않는다/u);
});

test("structured chapters separate front matter and character introductions from prose", () => {
  const data = {
    novelTitle: "유리문 너머의 낮", title: "제 1화 1장. 돌아온 사람",
    introduction: "낯선 손님이 닫힌 문을 두드린다.",
    body: '문이 열렸다.\n\n"오랜만이야."',
    characters: [{ name: "  지은  ", introduction: "문을 연 사람." }],
  };
  const chapter = parseGeneratedNovelChapter(`\x60\x60\x60json\n${JSON.stringify(data)}\n\x60\x60\x60`, {
    index: 1, startTurn: 1, endTurn: 2,
  });
  assert.equal(chapter.title, "제 1화 돌아온 사람");
  assert.equal(chapter.novelTitle, data.novelTitle);
  assert.equal(chapter.introduction, data.introduction);
  assert.equal(chapter.body, data.body);
  assert.deepEqual(chapter.characters, [{ name: "지은", introduction: "문을 연 사람." }]);
  const later = parseGeneratedNovelChapter(JSON.stringify(data), { index: 2, startTurn: 3, endTurn: 4 });
  assert.equal(later.novelTitle, undefined);
  assert.equal(later.introduction, undefined);
});

test("collects characters from every chapter in first-appearance order without duplicate spoilers", () => {
  assert.deepEqual(collectNovelCharacters([
    { characters: [{ name: " 지은 ", introduction: "문을 연 사람." }] },
    { characters: [{ name: "지은", introduction: "사건의 범인." }, { name: "민수", introduction: "찾아온 손님." }] },
    {},
  ]), [{ name: "지은", introduction: "문을 연 사람." }, { name: "민수", introduction: "찾아온 손님." }]);
  assert.match(buildNovelChapterPrompt({ chunkIndex: 2, chunkCount: 2, previousTail: "", source: "원문", knownCharacters: ["지은"] }), /같은 인물은 이 표기를 유지.*\n\["지은"\]/u);
});

test("rejects truncated or invalid structured manuscripts instead of printing JSON in the PDF", () => {
  const source = { index: 2, startTurn: 3, endTurn: 4 };
  assert.throws(() => parseGeneratedNovelChapter('{"body":"잘린 본문', source), /2장 원고 응답이 완성되지/u);
  assert.throws(() => parseGeneratedNovelChapter('{"title":"제목","body":42,"characters":[]}', source), /2장 원고 형식/u);
});
