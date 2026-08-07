"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clearEchoedPromptRegion,
  clearPreviousTerminalRows,
  displayWidth,
  promptPersonaFields,
  terminalRowsForLine,
} = require("./dos-chat.js");

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
