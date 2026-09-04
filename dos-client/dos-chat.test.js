"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  startResponseStatus,
  chatStatusUpdatedAtSql,
  clearEchoedPromptRegion,
  clearPreviousTerminalRows,
  createInactivityWatchdog,
  isCtrlGShortcut,
  isShiftEnterKeypress,
  insertReadlineLineBreak,
  installShiftEnterLineBreak,
  buildContinueInstruction,
  continuationDelta,
  pickNextMaintenanceEntry,
  displayWidth,
  promptPersonaFields,
  terminalRowsForLine,
} = require("./dos-chat.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("DOS waiting line shows retry count and clears on completion or cancellation", () => {
  const output = [];
  const status = startResponseStatus(Date.now(), "응답 생성 중...", (text) => output.push(text));
  try {
    assert.match(output.at(-1), /응답 생성 중/);
    status.setMessage("응답 생성 실패 · 재시도 중… (1/5)");
    assert.match(output.at(-1), /재시도 중… \(1\/5\)/);
    status.setMessage("응답 생성 실패 · 재시도 중… (2/5)");
    assert.match(output.at(-1), /재시도 중… \(2\/5\)/);
    status.stop(true);
    assert.equal(output.at(-1), "\r\x1b[2K");
    const stoppedCount = output.length;
    status.setMessage("should not return");
    status.stop(true);
    assert.equal(output.length, stoppedCount);
  } finally {
    status.stop(true);
  }
});

test("DOS chat ordering supports DBs both with and without optional status timestamps", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, createdAt INTEGER); INSERT INTO chats VALUES ('chat', 100)");
    const readTime = (alias) => {
      const expression = chatStatusUpdatedAtSql(db, alias);
      return db.prepare(`SELECT MAX(COALESCE(${expression}, 0), createdAt) AS time FROM chats c`).get().time;
    };
    assert.equal(readTime("c"), 100);
    assert.equal(readTime(""), 100);
    db.exec("ALTER TABLE chats ADD COLUMN lastStatusUpdatedAt INTEGER; UPDATE chats SET lastStatusUpdatedAt=200");
    assert.equal(readTime("c"), 200);
    assert.equal(readTime(""), 200);
  } finally {
    db.close();
  }
});

test("response watchdog resets on stream activity and aborts only after inactivity", async () => {
  const watchdog = createInactivityWatchdog(undefined, 40);
  await wait(25);
  watchdog.touch();
  await wait(25);
  assert.equal(watchdog.signal.aborted, false);
  await wait(25);
  assert.equal(watchdog.signal.aborted, true);
  assert.equal(watchdog.didTimeout(), true);
  watchdog.stop();
});

test("response watchdog forwards a manual parent abort without reporting a timeout", () => {
  const parent = new AbortController();
  const watchdog = createInactivityWatchdog(parent.signal, 1_000);
  parent.abort();
  assert.equal(watchdog.signal.aborted, true);
  assert.equal(watchdog.didTimeout(), false);
  watchdog.stop();
});

test("Ctrl+G is recognized as the continue shortcut", () => {
  assert.equal(isCtrlGShortcut("\x07", undefined), true);
  assert.equal(isCtrlGShortcut("", { ctrl: true, name: "g" }), true);
  assert.equal(isCtrlGShortcut("g", { ctrl: false, name: "g" }), false);
});

test("Shift+Enter recognizes readline, CSI-u, and Windows Terminal key forms", () => {
  assert.equal(isShiftEnterKeypress("\r", { name: "return", shift: true }), true);
  assert.equal(isShiftEnterKeypress(undefined, { sequence: "\x1b[13;2u" }), true);
  assert.equal(isShiftEnterKeypress(undefined, { sequence: "\x1b[13;28;13;1;16;1_" }), true);
  assert.equal(isShiftEnterKeypress("\r", { name: "return", shift: false }), false);
});

test("Shift+Enter inserts a newline without submitting the readline question", () => {
  const ttyWrite = Symbol("_ttyWrite");
  let submitted = 0;
  const rl = {
    line: "첫째둘째",
    cursor: 2,
    [ttyWrite]() { submitted += 1; },
  };

  const remove = installShiftEnterLineBreak(rl, { enableProtocol: false });
  rl[ttyWrite](undefined, { sequence: "\x1b[13;2u" });
  assert.equal(rl.line, "첫째\n둘째");
  assert.equal(rl.cursor, 3);
  assert.equal(submitted, 0);

  rl[ttyWrite]("\r", { name: "return", shift: false });
  assert.equal(submitted, 1);
  remove();
});

test("multiline insertion also uses readline native editing when available", () => {
  const inserted = [];
  const rl = {
    _insertString(value) { inserted.push(value); },
  };
  assert.equal(insertReadlineLineBreak(rl), true);
  assert.deepEqual(inserted, ["\n"]);
});

test("continue instruction includes the latest answer tail", () => {
  const instruction = buildContinueInstruction("앞부분-" + "가".repeat(950));
  assert.match(instruction, /직전 답변의 마지막 문장 다음부터/u);
  assert.equal(instruction.endsWith("가".repeat(900)), true);
});

test("continuationDelta prints only newly appended content", () => {
  assert.equal(continuationDelta("기존 답변", "기존 답변\n새 문장"), "새 문장");
  assert.equal(continuationDelta("기존 답변", "완전히 교체된 답변"), "완전히 교체된 답변");
});

test("background maintenance prioritizes memory and newest character work", () => {
  const characterJobs = new Map([
    ["old", { id: "old" }],
    ["new", { id: "new" }],
  ]);
  const memoryJobs = new Map([["chat", { id: "memory" }]]);

  assert.deepEqual(pickNextMaintenanceEntry(characterJobs, memoryJobs), {
    kind: "memory",
    entry: ["chat", { id: "memory" }],
  });
  memoryJobs.clear();
  assert.deepEqual(pickNextMaintenanceEntry(characterJobs, memoryJobs), {
    kind: "character",
    entry: ["new", { id: "new" }],
  });
});

test("terminalRowsForLine counts a short input as one terminal row", () => {
  assert.equal(terminalRowsForLine("이춘복> 짧은 입력", 80), 1);
});

test("terminalRowsForLine counts wrapped Korean input using display cells", () => {
  const input =
    "이춘복> *그때 채원이등교* 왔는데? 너 그말책임질수있어? 어린애가 지금 무죄추정원칙도모르고 넌 반장 out 다음교시때 반장선거";
  assert.equal(terminalRowsForLine(input, 120), 2);
  assert.equal(terminalRowsForLine(input, 52), 3);
});

test("terminalRowsForLine wraps a wide character instead of splitting it at the edge", () => {
  assert.equal(terminalRowsForLine("aaaa한aaaa", 5), 3);
});

test("clearPreviousTerminalRows clears every wrapped row and returns to the first", () => {
  assert.equal(
    clearPreviousTerminalRows(2),
    "\x1b[2A\r\x1b[2K\x1b[1B\r\x1b[2K\x1b[1A\r"
  );
});

test("clearEchoedPromptRegion also reclaims the blank line above the prompt", () => {
  // 프롬프트가 "\n이름> " 이라 입력 위에는 항상 우리가 만든 빈 줄이 하나 있다.
  // 한 줄 더 올라가 화면 끝까지 지워야 오른쪽 끝 줄바꿈 모델 차이와 무관하게
  // 원문이 남지 않는다.
  assert.equal(clearEchoedPromptRegion(1), "\x1b[2A\r\x1b[0J");
  assert.equal(clearEchoedPromptRegion(3), "\x1b[4A\r\x1b[0J");
  assert.equal(clearEchoedPromptRegion(0), "\x1b[2A\r\x1b[0J");
});

test("an input that exactly fills the terminal still gets fully erased", () => {
  // 실제 사고 입력: 프롬프트까지 합친 표시폭이 정확히 120셀이라 120열
  // 터미널에서 conhost는 한 줄을 더 쓰고 계산식은 그걸 세지 못했다.
  const prompt = "이춘복> ";
  const typed =
    "*다음날밤 남성의 딸을 유심히봤던 인물 16살 베이비페이스 165cm 정도의 몸매*";
  const echoed = `${prompt}${typed}`;
  const width = displayWidth(echoed);
  const columns = width; // 정확히 한 줄을 꽉 채우는 경우
  assert.equal(width % columns, 0);

  // 계산식은 보류 줄바꿈 기준으로 1줄이라고 본다.
  assert.equal(terminalRowsForLine(echoed, columns), 1);
  // 지우기는 그 위 빈 줄까지 올라가고 화면 끝까지 밀어버리므로,
  // conhost가 한 줄을 더 썼더라도 원문이 남지 않는다.
  assert.equal(clearEchoedPromptRegion(1), "\x1b[2A\r\x1b[0J");
});

function fakeReadline(answers) {
  const asked = [];
  let i = 0;
  return {
    asked,
    question: async (label) => {
      asked.push(label);
      return answers[i++] ?? "";
    },
  };
}

test("persona setup asks for all four fields in order", async () => {
  const rl = fakeReadline(["춘복", "16", "남", "고등학생"]);
  const fields = await promptPersonaFields(rl, {});

  assert.deepEqual(fields, {
    personaName: "춘복",
    personaAge: "16",
    personaGender: "남",
    personaInfo: "고등학생",
  });
  assert.equal(rl.asked.length, 4);
  assert.match(rl.asked[0], /^이름 /u);
  assert.match(rl.asked[1], /^나이/u);
  assert.match(rl.asked[2], /^성별 /u);
  assert.match(rl.asked[3], /^정보 /u);
});

test("Enter keeps the value the room already has", async () => {
  const rl = fakeReadline(["", "", "", ""]);
  const settings = {
    personaName: "기존이름",
    personaAge: 22,
    personaGender: "여",
    personaInfo: "기존정보",
  };
  const fields = await promptPersonaFields(rl, settings);

  assert.equal(fields.personaName, "기존이름");
  assert.equal(fields.personaAge, "22");
  assert.equal(fields.personaGender, "여");
  assert.equal(fields.personaInfo, "기존정보");
  // 기존값을 프롬프트에 보여 줘야 Enter가 유지라는 걸 알 수 있다.
  assert.match(rl.asked[0], /기존이름/u);
});

test("an empty room shows blank defaults rather than inventing a persona", async () => {
  const rl = fakeReadline(["", "", "", ""]);
  const fields = await promptPersonaFields(rl, {});

  assert.equal(fields.personaName, "");
  assert.match(rl.asked[0], /비어있음/u);
});
