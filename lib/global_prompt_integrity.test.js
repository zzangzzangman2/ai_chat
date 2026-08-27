const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("character memory prompts distinguish memory owner from physical owner", () => {
  const route = read("app/api/chat/send/route.ts");
  const dynamic = read("lib/dynamic_character_context.ts");

  assert.doesNotMatch(
    route,
    /Detailed encounter logs below belong only to the character under the same ## heading/u
  );
  assert.doesNotMatch(
    dynamic,
    /각 기억은 character_id의 인물에게만 적용한다/u
  );
  assert.match(route, /memory owner[\s\S]{0,220}not the grammatical subject/u);
  assert.match(dynamic, /character_id는 기억 소유자/u);
  assert.match(dynamic, /모든 신체 속성의 소유자가 아니다/u);
});

test("manual detailed context is fallback-only when dynamic context exists", () => {
  const route = read("app/api/chat/send/route.ts");
  assert.match(
    route,
    /physicalFactIdentities,\s*!dynamicCharacterContext\.block/u
  );
});

test("physical ownership guard covers prompt memory and both output paths", () => {
  const route = read("app/api/chat/send/route.ts");
  const systemAssembly = route.match(/const system = \[[\s\S]*?\]\.filter\(Boolean\)/u)?.[0] || "";

  assert.equal((systemAssembly.match(/physicalFactOwnershipBlock/gu) || []).length, 1);
  assert.match(route, /historyPhysicalOwnershipView/u);
  assert.match(route, /physicalOwnershipTailQualified/u);
  assert.match(route, /streamPhysicalOwnershipQualified/u);
  assert.match(route, /physicalOwnershipOutputChecked/u);
});

test("assistant repetition cannot promote NPC body facts in extraction or canon prompt", () => {
  const structured = read("lib/structured_relationship_memory.ts");
  const canonical = read("lib/canonical_character_facts.ts");

  assert.match(structured, /예외 없이 \[어시스턴트\] 지문만으로 키·체중·체형·외모 facts를 새로 만들지 않는다/u);
  assert.match(canonical, /fact\.sourceRole !== "user"/u);
  assert.match(canonical, /"height", "weight", "body_build", "appearance"/u);
});
