const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/relationship_direction.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const {
  addressDirectionsConflict,
  formatAddressDirectionGuard,
  sanitizeAddressDirectionOutput,
  selectCanonicalAddressDirections,
} = moduleObj.exports;

const userDirection = {
  id: "user",
  speakerKey: "persona",
  speakerName: "주인공",
  targetKey: "name:상대",
  targetName: "상대",
  term: "선배님",
  sourceRole: "user",
  lastSeenTurn: 10,
};
const reversedAssistant = {
  id: "assistant",
  speakerKey: "name:상대",
  speakerName: "상대",
  targetKey: "persona",
  targetName: "주인공",
  term: "선배님",
  sourceRole: "assistant",
  lastSeenTurn: 20,
};

assert.equal(addressDirectionsConflict(userDirection, reversedAssistant), true);
assert.deepEqual(selectCanonicalAddressDirections([reversedAssistant, userDirection]).map((row) => row.id), ["user"]);
assert.match(formatAddressDirectionGuard([reversedAssistant, userDirection]), /주인공 → 상대: “선배님”/);
assert.doesNotMatch(formatAddressDirectionGuard([reversedAssistant, userDirection]), /상대 → 주인공/);

const familyDirection = {
  ...userDirection,
  id: "family-user",
  speakerName: "이춘복",
  targetKey: "name:박도훈",
  targetName: "박도훈",
  term: "장인어른",
};
const reversedOutput = sanitizeAddressDirectionOutput({
  text: '도훈은 고개를 숙였다. "네... 넷...! 장인어른..." 도훈은 이춘복을 장인어른이라 부르며 따라갔다.',
  directions: [familyDirection],
});
assert.equal(reversedOutput.replaced, 2);
assert.doesNotMatch(reversedOutput.text, /장인어른/);
assert.match(reversedOutput.text, /이춘복/);

const streamedVocative = sanitizeAddressDirectionOutput({
  text: "장인어른... ",
  directions: [familyDirection],
});
assert.equal(streamedVocative.text, "이춘복... ");

const canonicalNarration = "이춘복은 박도훈을 장인어른이라 불렀다.";
assert.equal(
  sanitizeAddressDirectionOutput({
    text: canonicalNarration,
    directions: [familyDirection],
  }).text,
  canonicalNarration
);

const infoBlock = "```INFO\n관계: 박도훈(장인어른)\n```";
assert.equal(
  sanitizeAddressDirectionOutput({ text: infoBlock, directions: [familyDirection] }).text,
  infoBlock
);
console.log("relationship_direction tests passed");
