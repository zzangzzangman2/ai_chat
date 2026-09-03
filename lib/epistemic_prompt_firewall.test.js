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
  buildGroundedEpistemicFactIds,
  buildEpistemicPromptFirewall,
  omitWorldOnlyRelationshipsFromPrompt,
  sanitizeCharacterEpistemicText,
  sanitizeGeneratedEpistemicText,
  sanitizeRecentAssistantEpistemicText,
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

test("limited secrets are removed from the shared prompt view", () => {
  const firewall = buildEpistemicPromptFirewall(
    graph([relation({ knownByNames: ["이춘복", "정아린"] })])
  );
  const source = "이춘복이 몰래 침입해 정아린을 해친 비공개 사건이다.";

  assert.equal(sanitizeSharedEpistemicText(source, firewall).text, "");
  assert.equal(
    sanitizeCharacterEpistemicText(source, "정아린", firewall).text,
    source
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

test("recent assistant context removes a secret sentence without erasing the turn", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const source = [
    "이춘복이 병원 복도에 들어왔다.",
    "수사관은 그가 재판의 진짜 원흉임을 이미 알고 있었다.",
    "윤동현은 방문 목적을 확인하려고 앞을 막았다.",
  ].join(" ");
  const result = sanitizeRecentAssistantEpistemicText(source, firewall);

  assert.equal(result.redactedSegments, 1);
  assert.match(result.text, /병원 복도에 들어왔다/u);
  assert.doesNotMatch(result.text, /진짜 원흉/u);
  assert.match(result.text, /방문 목적을 확인/u);
});

test("generated output preserves paragraph spacing when nothing is redacted", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const source = "*첫 번째 지문이다.*\n\n\"두 번째 대사다.\"\n\n```STATUS\n정상\n```\n";
  const result = sanitizeGeneratedEpistemicText(source, firewall);

  assert.equal(result.redactedSegments, 0);
  assert.equal(result.text, source);
});

test("generated output keeps surrounding blank lines when one sentence is redacted", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const source = "이춘복이 복도에 들어왔다.\n\n수사관은 그가 재판의 원흉임을 안다.\n\n방문 목적을 확인했다.";
  const result = sanitizeGeneratedEpistemicText(source, firewall);

  assert.equal(result.redactedSegments, 1);
  assert.equal(result.text, "이춘복이 복도에 들어왔다.\n\n방문 목적을 확인했다.");
});

test("stored narration grounds an established event without granting NPC knowledge", () => {
  const firewall = buildEpistemicPromptFirewall(graph([relation()]));
  const groundedFactIds = buildGroundedEpistemicFactIds(firewall, [
    "이춘복이 병원에 몰래 침입했다.",
  ]);

  const narration = sanitizeGeneratedEpistemicText(
    "이춘복은 이전에 확보한 마스터키로 병원에 몰래 침입했다.",
    firewall,
    { groundedFactIds }
  );
  const leakedKnowledge = sanitizeGeneratedEpistemicText(
    "수사관은 이춘복이 몰래 침입한 사실을 이미 알고 있었다.",
    firewall,
    { groundedFactIds }
  );

  assert.equal(narration.redactedSegments, 0);
  assert.match(narration.text, /마스터키/u);
  assert.equal(leakedKnowledge.redactedSegments, 1);
  assert.equal(leakedKnowledge.text, "");
});

test("police dialogue cannot turn a witness-only family hostage crime into a charge", () => {
  const secret = relation({
    id: "family-hostage-secret",
    subjectName: "이춘복",
    objectName: "박지아",
    relation: "비공개 감금 성폭력 가해자와 피해자",
    objectRole:
      "이춘복이 박지아의 가족을 인질로 잡고 감금하여 성폭력을 가했지만 신고되거나 수사기관에 전달되지 않았다.",
    knownByNames: ["이춘복", "박지아", "소은", "유지은", "박도훈", "박지훈", "이수진"],
    knowledgeEvidence: "밀실 안에서 피해자와 가족만 범행을 목격했다.",
  });
  const firewall = buildEpistemicPromptFirewall(graph([secret]));
  const source = [
    "*경찰관이 수배 전단을 들고 죄명을 설명했다.*",
    "",
    '"그는 현재 또 다른 일가족을 인질로 잡고 여중생을 납치해 유린한 혐의도 받고 있습니다."',
    "",
    "*교사는 공개된 탈옥 사실을 확인했다.*",
  ].join("\n");
  const result = sanitizeGeneratedEpistemicText(source, firewall, {
    groundedFactIds: new Set(["family-hostage-secret"]),
  });

  assert.equal(result.redactedSegments, 1);
  assert.doesNotMatch(result.text, /일가족|여중생을 납치/u);
  assert.match(result.text, /공개된 탈옥/u);
});

test("an explicitly authorized witness may state the same private fact", () => {
  const secret = relation({
    id: "family-hostage-secret",
    subjectName: "이춘복",
    objectName: "박지아",
    relation: "비공개 감금 성폭력 가해자와 피해자",
    objectRole:
      "이춘복이 박지아의 가족을 인질로 잡고 감금하여 성폭력을 가했다.",
    knownByNames: ["이춘복", "박지아", "소은", "유지은"],
    knowledgeEvidence: "소은은 현장에서 범행을 직접 목격했다.",
  });
  const firewall = buildEpistemicPromptFirewall(graph([secret]));
  const source = [
    "*소은은 떨리는 목소리로 자신이 목격한 일을 말했다.*",
    "",
    '"그 사람은 지아의 일가족을 인질로 잡고 우리를 납치해 유린했어요."',
  ].join("\n");
  const result = sanitizeGeneratedEpistemicText(source, firewall, {
    groundedFactIds: new Set(["family-hostage-secret"]),
  });

  assert.equal(result.redactedSegments, 0);
  assert.equal(result.text, source);
});
