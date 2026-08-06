/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function transpileModule(filename, customRequire = require) {
  const source = fs.readFileSync(path.join(__dirname, filename), "utf8");
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
    customRequire
  );
  return loaded.exports;
}

const knowledge = transpileModule("character_knowledge.ts");
const firewallModule = transpileModule(
  "epistemic_prompt_firewall.ts",
  (specifier) => {
    if (specifier === "@/lib/character_knowledge") return knowledge;
    throw new Error(`Unexpected test import: ${specifier}`);
  }
);

const {
  buildEpistemicPromptFirewall,
  omitWorldOnlyRelationshipsFromPrompt,
  sanitizeCharacterEpistemicText,
  sanitizeGeneratedEpistemicText,
  sanitizeSharedEpistemicText,
} = firewallModule;

function relation(overrides = {}) {
  return {
    id: "secret-1",
    subjectKey: "name:이춘복",
    subjectName: "이춘복",
    subjectRosterId: "lee",
    relation: "숨겨진 범죄 가해자",
    slotKey: "secret",
    objectKey: "name:정아린",
    objectName: "정아린",
    objectRosterId: "arin",
    objectRole: "이춘복이 몰래 침입해 정아린을 해쳤지만 아직 발각되지 않았다.",
    knownByNames: [],
    knowledgeEvidence: "",
    firstSeenTurn: 1,
    lastSeenTurn: 10,
    updatedAt: 1,
    source: "structured",
    isManual: false,
    ...overrides,
  };
}

function graph(relations) {
  return { personaName: "정진우", nodes: [], affinities: [], relations };
}

test("shared summaries cannot promote a world-only secret to NPC knowledge", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const source = [
    "### 법정 참관",
    "누명을 쓴 노인의 재판에 진짜 가해자인 이춘복이 나타났다.",
    "",
    "### 현재 관찰",
    "윤동현은 이춘복이 법정 방청석에 앉은 모습을 직접 봤다.",
  ].join("\n");
  const result = sanitizeSharedEpistemicText(source, firewall);

  assert.equal(result.redactedSegments, 1);
  assert.doesNotMatch(result.text, /누명|진짜 가해자/u);
  assert.match(result.text, /법정 방청석에 앉은 모습/u);
});

test("world-only relationship details are omitted from NPC-facing graph views", () => {
  const secret = relation();
  const publicFact = relation({
    id: "known-1",
    knownByNames: ["윤동현"],
    relation: "수사관과 조사 대상자",
    objectRole: "윤동현이 이춘복의 법정 소란을 직접 목격했다.",
  });
  const sourceGraph = graph([secret, publicFact]);
  const firewall = buildEpistemicPromptFirewall(sourceGraph);
  const filtered = omitWorldOnlyRelationshipsFromPrompt(sourceGraph, firewall);

  assert.deepEqual(filtered.relations.map((item) => item.id), ["known-1"]);
  assert.equal(sourceGraph.relations.length, 2);
});

test("prior assistant assertions are filtered without suppressing unrelated facts", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const source = [
    "### 잘못된 과거 지문",
    "이춘복이 원흉이라는 결론을 수사관은 이미 알고 있었다.",
    "",
    "### 별개의 공개 사건",
    "다른 마을의 공개 재판에서는 김민수가 누명을 벗었다.",
  ].join("\n");
  const result = sanitizeSharedEpistemicText(source, firewall);

  assert.doesNotMatch(result.text, /이춘복이 원흉/u);
  assert.match(result.text, /김민수가 누명을 벗었다/u);
});

test("indirect hidden conclusions are filtered even when the actor name is omitted", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const unsupported = "법정에는 억울하게 누명을 쓴 피고인의 오열이 울렸다.";
  const publicEvidence = "법정에는 피해 검체가 범행 증거로 제출되었다.";

  assert.equal(sanitizeSharedEpistemicText(unsupported, firewall).text, "");
  assert.equal(
    sanitizeSharedEpistemicText(publicEvidence, firewall).text,
    publicEvidence
  );
});

test("a character-scoped memory is retained only for an explicit knower", () => {
  const firewall = buildEpistemicPromptFirewall(
    graph([relation({ knownByNames: ["이춘복", "할아버지"] })])
  );
  const claim = "이춘복이 몰래 침입한 진범이라는 사실을 기억한다.";

  assert.equal(
    sanitizeCharacterEpistemicText(claim, "윤동현", firewall).text,
    ""
  );
  assert.equal(
    sanitizeCharacterEpistemicText(claim, "이춘복", firewall).text,
    claim
  );
});

test("observable suspicion remains available without the hidden conclusion", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const observation = "윤동현은 이춘복이 재판에 찾아온 행동을 수상하게 여겼다.";
  const result = sanitizeSharedEpistemicText(observation, firewall);

  assert.equal(result.redactedSegments, 0);
  assert.equal(result.text, observation);
});

test("generated output removes only unsupported secret sentences", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const source = [
    "이춘복이 병원 복도에 들어왔다.",
    "수사관은 그가 재판의 진짜 원흉임을 이미 알고 있었다.",
    "윤동현은 방문 목적을 확인하려고 앞을 막았다.",
  ].join(" ");
  const result = sanitizeGeneratedEpistemicText(source, firewall);

  assert.equal(result.redactedSegments, 1);
  assert.match(result.text, /병원 복도에 들어왔다/u);
  assert.doesNotMatch(result.text, /원흉/u);
  assert.match(result.text, /방문 목적을 확인/u);
});
