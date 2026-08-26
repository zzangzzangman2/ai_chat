/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuardModule() {
  const sourcePath = path.join(__dirname, "recognition_consistency_guard.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
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
    require
  );
  return loaded.exports;
}

const {
  deriveCurrentSceneExclusions,
  deriveCurrentScenePresence,
  findRecognitionContradiction,
  findScenePresenceContradiction,
  removeRecognitionContradictionPassages,
  removeScenePresenceContradictionPassages,
} = loadGuardModule();

const recognition = [
  {
    characterId: "jinwoo-id",
    characterName: "정진우",
    characterAliases: ["진우", "오빠"],
    firstInteractionTurn: 41,
    lastInteractionTurn: 88,
    evidence: "정진우와 이춘복이 직접 대면해 여러 차례 대화하고 다퉜다.",
  },
  {
    characterId: "arin-id",
    characterName: "정아린",
    characterAliases: ["아린"],
    firstInteractionTurn: 59,
    lastInteractionTurn: 71,
    evidence: "정아린과 이춘복이 직접 대면했다.",
  },
];

function find(text, overrides = {}) {
  return findRecognitionContradiction({
    text,
    personaName: "이춘복",
    personaAliases: ["춘복", "주인공"],
    currentUserText: "*아린에게 다가간다* 이 할애비가 응원하마.",
    sceneCharacterNames: ["정진우", "정아린"],
    recognition,
    ...overrides,
  });
}

test("catches a known speaker treating a role-noun persona as a stranger", () => {
  const result = find([
    "*정아린은 다가오는 노인을 보고 몸을 굳혔다.*",
    "",
    "*정진우가 아린의 앞을 가로막고 눈앞의 노인을 향해 분노를 토해냈다.*",
    "",
    '"당신 뭐야! 당장 떨어져!"',
  ].join("\n"));

  assert.equal(result?.characterName, "정진우");
  assert.match(result?.matchedText || "", /당신\s*뭐야/u);
});

test("resolves a stored character alias as the speaker", () => {
  const result = find([
    "*오빠가 노인을 향해 소리쳤다.*",
    "",
    '"그쪽은 누구야?"',
  ].join("\n"));

  assert.equal(result?.characterName, "정진우");
});

test("resolves speaker attribution written after the dialogue", () => {
  const result = find('"당신은 누구십니까?" 정진우가 물었다.');
  assert.equal(result?.characterName, "정진우");
});

test("catches particle, contraction and implicit-address variants", () => {
  for (const dialogue of [
    '"당신이 누구냐?"',
    '"넌 대체 누구야?"',
    '"누구세요?"',
  ]) {
    const result = find(`*정진우가 노인을 향해 물었다.*\n\n${dialogue}`);
    assert.equal(result?.characterName, "정진우", dialogue);
  }
});

test("resolves a stored persona alias without requiring the canonical name", () => {
  const result = find("*정진우는 춘복을 처음 보는 사람처럼 대했다.*");
  assert.equal(result?.characterName, "정진우");
});

test("still catches explicit named-persona recognition contradictions", () => {
  const result = find("*정진우는 이춘복을 낯선 사람처럼 바라보며 경계했다.*");
  assert.equal(result?.characterName, "정진우");
});

test("does not confuse the known character target with the speaker", () => {
  const result = find([
    "*이춘복이 정진우에게 물었다.*",
    "",
    '"당신 누구야?"',
  ].join("\n"));
  assert.equal(result, null);
});

test("allows identity questions aimed at an explicitly named third party", () => {
  const result = find(
    [
      "*정진우가 민수를 향해 물었다.*",
      "",
      '"당신 누구야?"',
    ].join("\n"),
    { sceneCharacterNames: ["정진우", "정아린", "민수"] }
  );
  assert.equal(result, null);
});

test("keeps a named third-party question valid even when the persona is nearby", () => {
  const result = find(
    [
      "*정진우가 이춘복 옆에 선 민수를 향해 물었다.*",
      "",
      '"당신 누구야?"',
    ].join("\n"),
    { sceneCharacterNames: ["정진우", "정아린", "민수"] }
  );
  assert.equal(result, null);
});

test("allows a genuine new third party introduced by the user", () => {
  const result = find(
    [
      "*정진우가 새로 온 남자를 가로막고 물었다.*",
      "",
      '"당신 누구야?"',
    ].join("\n"),
    { currentUserText: "*처음 보는 남자를 데리고 방으로 들어온다*" }
  );
  assert.equal(result, null);
});

test("does not confuse unknown motives with failure to recognize a person", () => {
  const result = find([
    "*정진우가 노인을 노려보며 경고했다.*",
    "",
    '"당신이 왜 여기 있는지는 모르겠지만 아린에게서 떨어져."',
  ].join("\n"));
  assert.equal(result, null);
});

test("last-resort filtering removes an alias-based contradiction passage", () => {
  const result = removeRecognitionContradictionPassages({
    text: [
      "*정진우가 노인을 향해 소리쳤다.*",
      "",
      '"당신 뭐야?"',
      "",
      "*아린은 숨을 골랐다.*",
    ].join("\n"),
    personaName: "이춘복",
    currentUserText: "*아린에게 다가간다*",
    sceneCharacterNames: ["정진우", "정아린"],
    recognition,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /당신\s*뭐야/u);
  assert.match(result.text, /아린은 숨을 골랐다/u);
});

const sceneIdentities = [
  { name: "안유진", aliases: ["유진"] },
  { name: "장원영", aliases: ["원영"] },
];

function derivePresence(messages) {
  return deriveCurrentScenePresence({
    messages: messages.map((content, index) => ({
      role: index % 2 ? "user" : "assistant",
      content,
    })),
    identities: sceneIdentities,
  });
}

test("derives an already-present character from recent entry and active-state prose", () => {
  const present = derivePresence([
    "*먼저 끌려와 무릎을 꿇고 있던 안유진은 입술을 깨물었다.*",
    "그다음 여자 나와. 이제 네 명 남았다.",
    "*원형 단상에 무릎을 꿇고 있던 안유진은 고개를 들었다.*",
  ]);

  assert.deepEqual(present.map((fact) => fact.characterName), ["안유진"]);
  assert.match(present[0].evidence, /무릎을 꿇고 있던 안유진/u);
});

test("catches the reproduced duplicate arrival for a character already in the scene", () => {
  const present = derivePresence([
    "*먼저 끌려와 무릎을 꿇고 있던 안유진은 아무 말도 하지 못했다.*",
    "그다음 여자 나와. 이제 네 명 남았다.",
  ]);
  const contradiction = findScenePresenceContradiction({
    text: "*경비대원들의 손아귀에 붙잡혀 끌려 내려온 것은 스타쉽 소속의 안유진이었다.*",
    currentUserText: "그다음 여자 나와. 이제 네 명 남았다.",
    presentCharacters: present,
  });

  assert.equal(contradiction?.characterName, "안유진");
  assert.equal(contradiction?.kind, "duplicate_entry");
});

test("catches a repeated self-introduction even after the arrival paragraph is gone", () => {
  const present = derivePresence([
    "*안유진은 단상에 무릎을 꿇고 있었다.*",
    "그다음 여자 나와.",
  ]);
  const contradiction = findScenePresenceContradiction({
    text: '"회장님… 스타쉽… 안유진입니다…"',
    currentUserText: "그다음 여자 나와.",
    presentCharacters: present,
  });

  assert.equal(contradiction?.kind, "duplicate_introduction");
});

test("allows ordinary movement by a character who remains in the same scene", () => {
  const present = derivePresence([
    "*안유진은 단상에 무릎을 꿇고 있었다.*",
    "이제 반응을 본다.",
  ]);
  const contradiction = findScenePresenceContradiction({
    text: "*안유진은 단상에서 내려와 회장을 바라봤다.*",
    currentUserText: "이제 반응을 본다.",
    presentCharacters: present,
  });

  assert.equal(contradiction, null);
});

test("an explicit exit clears transient presence and permits a later return", () => {
  const present = derivePresence([
    "*안유진은 방 안에 서 있었다.*",
    "*경비대가 안유진을 밖으로 끌려 나가게 했다.*",
  ]);

  assert.deepEqual(present, []);
  assert.equal(
    findScenePresenceContradiction({
      text: "*잠시 뒤 안유진이 다시 들어왔다.*",
      currentUserText: "다시 불러와.",
      presentCharacters: present,
    }),
    null
  );
});

test("an assistant-invented flight does not erase recent scene presence", () => {
  const present = deriveCurrentScenePresence({
    messages: [
      { role: "assistant", content: "*박지아는 소은의 곁에 서 있었다.*" },
      { role: "user", content: "둘이 서로 얼굴을 평가해봐." },
      {
        role: "assistant",
        content: "지아는 견디지 못하고 자신의 방으로 도망쳐버렸다.",
      },
    ],
    identities: [{ name: "박지아", aliases: ["지아"] }],
  });

  assert.deepEqual(present.map((fact) => fact.characterName), ["박지아"]);
});

test("an explicit scene cut clears people from the prior location", () => {
  const present = derivePresence([
    "*안유진은 방 안에 서 있었다.*",
    "*다음 날, 장소를 옮겨 회의실에서 대화를 시작했다.*",
  ]);

  assert.deepEqual(present, []);
});

test("a scene cut later in the same message clears earlier paragraphs", () => {
  const present = deriveCurrentScenePresence({
    messages: [
      {
        role: "assistant",
        content: [
          "*안유진은 방 안에 서 있었다.*",
          "",
          "*다음 날, 장소를 옮겨 회의실에서 대화를 시작했다.*",
        ].join("\n"),
      },
    ],
    identities: sceneIdentities,
  });

  assert.deepEqual(present, []);
});

test("does not confuse a different new arrival with the present character", () => {
  const present = derivePresence([
    "*안유진은 단상에 무릎을 꿇고 있었다.*",
    "그다음 여자 나와.",
  ]);
  const contradiction = findScenePresenceContradiction({
    text: "*문이 열리고 장원영이 안으로 들어왔다.*",
    currentUserText: "그다음 여자 나와.",
    presentCharacters: present,
  });

  assert.equal(contradiction, null);
});

test("does not bind another person's entry verb to a present character later in the sentence", () => {
  const present = derivePresence([
    "*안유진은 단상에 무릎을 꿇고 있었다.*",
    "그다음 여자 나와.",
  ]);
  const contradiction = findScenePresenceContradiction({
    text: "*장원영이 들어왔고 안유진은 고개를 들어 그녀를 바라봤다.*",
    currentUserText: "그다음 여자 나와.",
    presentCharacters: present,
  });

  assert.equal(contradiction, null);
});

test("last-resort scene filtering removes duplicate arrival and introduction passages", () => {
  const present = derivePresence([
    "*안유진은 단상에 무릎을 꿇고 있었다.*",
    "그다음 여자 나와.",
  ]);
  const result = removeScenePresenceContradictionPassages({
    text: [
      "*끌려 내려온 것은 스타쉽 소속의 안유진이었다.*",
      "",
      '"스타쉽 안유진입니다."',
      "",
      "*단상에 남은 사람들은 다음 호명을 기다렸다.*",
      "",
      "```INFO\n남은 인원: 4\n```",
    ].join("\n"),
    currentUserText: "그다음 여자 나와.",
    presentCharacters: present,
  });

  assert.equal(result.removed, 2);
  assert.deepEqual(result.characterNames, ["안유진"]);
  assert.doesNotMatch(result.text, /안유진입니다|끌려 내려온 것은/u);
  assert.match(result.text, /단상에 남은 사람들/u);
  assert.match(result.text, /```INFO\n남은 인원: 4\n```/u);
});

test("scene filtering is byte-for-byte transparent when no contradiction exists", () => {
  const present = derivePresence([
    "*안유진은 단상에 무릎을 꿇고 있었다.*",
    "반응을 본다.",
  ]);
  const text = "\n\n*안유진은 천천히 고개를 들었다.*\n\n";
  const result = removeScenePresenceContradictionPassages({
    text,
    currentUserText: "반응을 본다.",
    presentCharacters: present,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, text);
});

test("keeps user-expelled characters excluded until the user explicitly recalls them", () => {
  const identities = [
    { name: "이수진", aliases: ["수진"] },
    { name: "박지훈", aliases: ["지훈"] },
    { name: "박지아", aliases: ["지아"] },
  ];
  const messages = [
    {
      role: "user",
      content: "*이수진과 박지훈을 머리채 끌고 와서 문밖으로 내쫒으며 말했다* 여기는 못 들어와.",
    },
    {
      role: "assistant",
      content: "*이수진과 박지훈은 복도에 남았다.*",
    },
    { role: "user", content: "지아랑 다 나와봐." },
  ];

  const excluded = deriveCurrentSceneExclusions({ messages, identities });
  assert.deepEqual(
    excluded.map((fact) => fact.characterName).sort(),
    ["박지훈", "이수진"]
  );

  const recalled = deriveCurrentSceneExclusions({
    messages: [
      ...messages,
      { role: "user", content: "이수진은 다시 들어와." },
    ],
    identities,
  });
  assert.deepEqual(recalled.map((fact) => fact.characterName), ["박지훈"]);
});

test("catches a current character being made to flee without a user instruction", () => {
  const present = deriveCurrentScenePresence({
    messages: [
      {
        role: "assistant",
        content: "*박지아는 소은의 곁에 서 있었다.*",
      },
    ],
    identities: [{ name: "박지아", aliases: ["지아"] }],
  });
  const contradiction = findScenePresenceContradiction({
    text: "지아는 그 상황을 견디지 못하고 자신의 방으로 도망쳐버렸다.",
    currentUserText: "둘이 서로 얼굴을 평가해봐.",
    presentCharacters: present,
  });

  assert.equal(contradiction?.characterName, "박지아");
  assert.equal(contradiction?.kind, "unauthorized_exit");
});

test("catches an expelled character re-entering without a user recall", () => {
  const excluded = deriveCurrentSceneExclusions({
    messages: [
      {
        role: "user",
        content: "*이수진을 문밖으로 내쫓았다* 다시는 못 들어오게 해라.",
      },
    ],
    identities: [{ name: "이수진", aliases: ["수진"] }],
  });
  const contradiction = findScenePresenceContradiction({
    text: "열린 현관문 너머에 있던 이수진은 다급히 안으로 기어들어 왔다.",
    currentUserText: "둘이 서로 얼굴을 평가해봐.",
    presentCharacters: [],
    excludedCharacters: excluded,
  });

  assert.equal(contradiction?.characterName, "이수진");
  assert.equal(contradiction?.kind, "unauthorized_reentry");
});

test("drops the story suffix after an unauthorized cast substitution", () => {
  const excluded = deriveCurrentSceneExclusions({
    messages: [
      { role: "user", content: "*이수진을 문밖으로 내쫓았다* 못 들어오게 해라." },
    ],
    identities: [{ name: "이수진", aliases: ["수진"] }],
  });
  const result = removeScenePresenceContradictionPassages({
    text: [
      "이수진은 다급히 안으로 기어들어 왔다.",
      "",
      '이수진이 말했다. "제가 대신할게요."',
      "",
      "```INFO",
      "현재 위치: 거실",
      "```",
    ].join("\n"),
    currentUserText: "둘이 서로 얼굴을 평가해봐.",
    presentCharacters: [],
    excludedCharacters: excluded,
  });

  assert.equal(result.removed, 1);
  assert.deepEqual(result.kinds, ["unauthorized_reentry"]);
  assert.doesNotMatch(result.text, /이수진|대신할게요/u);
  assert.match(result.text, /```INFO\n현재 위치: 거실\n```/u);
});

test("allows a present character to leave when the user orders it", () => {
  const present = deriveCurrentScenePresence({
    messages: [
      { role: "assistant", content: "*박지아는 방 안에 서 있었다.*" },
    ],
    identities: [{ name: "박지아", aliases: ["지아"] }],
  });
  const contradiction = findScenePresenceContradiction({
    text: "*박지아는 고개를 숙이고 자신의 방으로 돌아갔다.*",
    currentUserText: "이제 방으로 돌아가.",
    presentCharacters: present,
  });

  assert.equal(contradiction, null);
});
