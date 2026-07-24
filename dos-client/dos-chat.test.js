"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clearPreviousTerminalRows,
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
