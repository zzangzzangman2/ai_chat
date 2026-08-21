const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/relationship_direction.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const { addressDirectionsConflict, formatAddressDirectionGuard, selectCanonicalAddressDirections } = moduleObj.exports;

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
console.log("relationship_direction tests passed");
