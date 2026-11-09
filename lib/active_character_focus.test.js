/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function loadModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (id) => id.startsWith(".")
    ? loadModule(path.resolve(path.dirname(sourcePath), `${id}.ts`))
    : require(id);
  new Function("require", "module", "exports", js)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

const { resolveActiveCharacterFocus, usesSecondPersonReference, applyActiveFocusToScene } = loadModule("lib/active_character_focus.ts");
const identities = [
  { id: "jia", name: "박지아", aliases: '["지아"]' },
  { id: "jieun", name: "유지은", aliases: '["지은"]' },
];

assert.equal(resolveActiveCharacterFocus({ identities, currentUserText: "지아야, 이리 와" }).names[0], "박지아");
assert.deepEqual(
  resolveActiveCharacterFocus({
    identities,
    currentUserText: "너한테 물어보는 거야",
    previousUserTexts: ["그래, 계속해", "지아야, 이리 와", "지은은 어디 있어?"],
  }).names,
  ["박지아"]
);
assert.equal(usesSecondPersonReference("너무 늦었어"), false);
assert.equal(usesSecondPersonReference("넌 왜 그래?"), true);
console.log("active_character_focus tests passed");

const test = require("node:test");
const family = [
  { id: "wife", name: "모용설" },
  { id: "father", name: "가주", aliases: "모용세가 가주", profile: "모용설의 부친이자 이춘복의 장인" },
  { id: "mother", name: "안주인", profile: "모용세가 가주의 부인이자 모용설의 모친" },
  { id: "visitor", name: "제갈청아", profile: "제갈세가의 여식" },
  { id: "other", name: "청아" },
];
const options = { identities: family, personaName: "이춘복", relationships: [{ subjectName: "이춘복", objectName: "모용설", relation: "배우자" }] };
test("in-law greeting resolves the spouse's two parents and preserves the unnamed follow-up", () => {
  const greeting = "*장인어른 장모님에게인사*";
  const focus = resolveActiveCharacterFocus({ ...options, currentUserText: greeting });
  assert.deepEqual(focus.names, ["가주", "안주인"]);
  assert.deepEqual(focus.familyNames, ["모용설"]);
  assert.equal(focus.exclusive, false);
  const follow = resolveActiveCharacterFocus({ ...options, currentUserText: "감사합니다. 다음에 또 찾아뵐게요.", previousUserTexts: [greeting, "제갈청아야, 정리하고 와"] });
  assert.deepEqual(follow.names, focus.names);
  assert.equal(follow.reason, "continued-address");
});
test("talking to the parents about their daughter does not give the daughter's character the reply", () => {
  const focus = resolveActiveCharacterFocus({ ...options, currentUserText: "모용설은 제가 잘 보살필게요.", previousUserTexts: ["*장인어른 장모님에게인사*"] });
  assert.deepEqual(focus.names, ["가주", "안주인"]);
});
test("explicit new addressee and scene changes release the family conversation", () => {
  const previousUserTexts = ["*장인어른 장모님에게인사*"];
  assert.deepEqual(resolveActiveCharacterFocus({ ...options, currentUserText: "제갈청아야, 이리 와", previousUserTexts }).names, ["제갈청아"]);
  assert.deepEqual(resolveActiveCharacterFocus({ ...options, currentUserText: "서재로 가자", previousUserTexts }).names, []);
});
test("ambiguous families are not guessed, but the explicit owner disambiguates them", () => {
  const twoFamilies = { ...options, identities: [...family,
    { id: "f2", name: "제갈가주", profile: "제갈청아의 부친" }, { id: "m2", name: "제갈부인", profile: "제갈청아의 모친" }],
    relationships: [...options.relationships, { subjectName: "이춘복", objectName: "제갈청아", relation: "배우자" }] };
  assert.equal(resolveActiveCharacterFocus({ ...twoFamilies, currentUserText: "*장인어른 장모님께 인사*" }).locked, false);
  assert.deepEqual(resolveActiveCharacterFocus({ ...twoFamilies, currentUserText: "*모용설 부모님께 인사*" }).names, ["가주", "안주인"]);
});
test("only an in-person address overrides stale off-scene classification", () => {
  const fact = name => ({ characterName: name, characterAliases: [], evidence: "이전 장면", messageIndex: 0 });
  const scene = { present: [fact("제갈청아")], offScene: [fact("가주"), fact("안주인")], location: "" };
  const focus = resolveActiveCharacterFocus({ ...options, currentUserText: "*장인어른 장모님께 인사*" });
  const placed = applyActiveFocusToScene(scene, focus);
  assert.deepEqual(placed.present.map(r => r.characterName), ["제갈청아", "가주", "안주인"]);
  assert.deepEqual(placed.offScene, []);
  const remote = resolveActiveCharacterFocus({ ...options, currentUserText: "전화로 장인어른 장모님께 인사한다" });
  assert.equal(applyActiveFocusToScene(scene, remote), scene);
});

test("direct names and compact vocatives own the reply in every chat", () => {
  for (const currentUserText of ["지아야 오늘 어때?", "야 박지아 이리 와서 설명해줘", "으지아야좋다, 다음은?", "박지아에게 질문한다", "박지아"]) {
    const focus=resolveActiveCharacterFocus({identities,currentUserText});
    assert.deepEqual(focus.names,["박지아"],currentUserText);
    assert.equal(focus.exclusive,false,currentUserText);
    assert.equal(focus.locked,true,currentUserText);
  }
});

test("unnamed follow-ups retain a recent listener without making old attention permanent", () => {
  const previousUserTexts=["계속 설명해줘","지아야, 지도 좀 보여줘"];
  const focus=resolveActiveCharacterFocus({identities,currentUserText:"그래, 다음은?",previousUserTexts});
  assert.deepEqual(focus.names,["박지아"]);
  assert.equal(focus.exclusive,false);
  assert.equal(focus.reason,"continued-address");
  assert.equal(resolveActiveCharacterFocus({identities,currentUserText:"그래, 다음은?",previousUserTexts:[...Array(100).fill("계속 설명해줘"),...previousUserTexts]}).locked,false);
});

test("a reported third person is a topic, not an automatic replacement speaker", () => {
  const focus=resolveActiveCharacterFocus({identities,currentUserText:"지은은 어디 있어?",previousUserTexts:["지아야, 지도 좀 보여줘"]});
  assert.deepEqual(focus.names,["박지아"]);
  const noListener=resolveActiveCharacterFocus({identities,currentUserText:"지은이 허락한 일이야"});
  assert.equal(noListener.locked,false);
  assert.equal(noListener.exclusive,undefined);
});

test("new listener, group answers and scene cuts release the old exclusive reply", () => {
  const previousUserTexts=["지아야, 지도 좀 보여줘"];
  assert.deepEqual(resolveActiveCharacterFocus({identities,currentUserText:"지은아 설명해줘",previousUserTexts}).names,["유지은"]);
  for(const currentUserText of ["다들 의견 말해봐","너네 모두 대답해","다들망원경준비해","모두 출발 준비해","서재로 가자"]){
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText,previousUserTexts}).locked,false,currentUserText);
  }
  assert.equal(resolveActiveCharacterFocus({identities,currentUserText:"계속해",previousUserTexts:["다들 의견 말해봐",...previousUserTexts]}).locked,false);
});

test("addressing a remote person does not teleport them into the room", () => {
  for(const currentUserText of ["지아야 어디 있어?","전화로 지아에게 질문한다"]){
    const focus=resolveActiveCharacterFocus({identities,currentUserText});
    assert.equal(focus.inPerson,false,currentUserText);
  }
});

test("compact aliases cannot steal a different full name or an ambiguous short name", () => {
  const names=[{id:"one",name:"제갈청아"},{id:"two",name:"청아"}];
  assert.deepEqual(resolveActiveCharacterFocus({identities:names,currentUserText:"으제갈청아야설명해줘"}).names,["제갈청아"]);
  assert.deepEqual(resolveActiveCharacterFocus({identities:names,currentUserText:"청아야 설명해줘"}).names,["청아"]);
  const ambiguous=[{id:"one",name:"박지아"},{id:"two",name:"김지아"}];
  assert.equal(resolveActiveCharacterFocus({identities:ambiguous,currentUserText:"지아야 설명해줘"}).locked,false);
});

test("arrival and stage progression release old focus now and on subsequent turns", () => {
  for (const direction of ["*도착*", "*작전계속진행*", "회의 시작", "*지은이 도착했다*", "유지은이 들어왔다.", "*식당상황*", "장면 전환: 식당"]) {
    const previousUserTexts=["지아야 지도 좀 설명해줘"];
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText:direction,previousUserTexts}).locked,false,direction);
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText:"그래, 다음은?",previousUserTexts:[direction,...previousUserTexts]}).locked,false,direction);
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText:"너는 어떻게 생각해?",previousUserTexts:[direction,...previousUserTexts]}).locked,false,direction);
  }
});

test("arrival plans and third-person topics do not steal a direct conversation", () => {
  for(const currentUserText of ["지은이 도착하면 알려줘", "지은이 도착했는지 확인해줘", "지은은 어디 있어?"]) {
    const focus=resolveActiveCharacterFocus({identities,currentUserText,previousUserTexts:["지아야 지도 좀 설명해줘"]});
    assert.deepEqual(focus.names,["박지아"]);
    assert.equal(focus.exclusive,false);
  }
});

test("only explicit private conversations restrict other speakers and a scene change ends that restriction", () => {
  for (const request of ["지아야 너만 대답해", "박지아만 대답해", "지아에게만 묻는다", "지아야 단둘이 이야기하자"]) {
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText:request}).exclusive,true,request);
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText:"다음은?",previousUserTexts:[request]}).exclusive,true,request);
    assert.equal(resolveActiveCharacterFocus({identities,currentUserText:"*도착*",previousUserTexts:[request]}).locked,false,request);
  }
});

test("an old address does not teleport someone back after a real exit", () => {
  const fact={characterName:"박지아",characterAliases:["지아"],evidence:"지아는 떠났다",messageIndex:3};
  const scene={present:[],offScene:[fact],location:"서재"};
  const focus=resolveActiveCharacterFocus({identities,currentUserText:"다음은?",previousUserTexts:["지아야 지도 좀 설명해줘"]});
  assert.equal(applyActiveFocusToScene(scene,focus),scene);
});

test("title spacing resolves the same character without matching longer names", () => {
  const {findMentionedCharacterIds}=loadModule("lib/character_mentions.ts");
  const titled=[{id:"guest",name:"영안공주"},{id:"other",name:"안공주"}];
  assert.deepEqual([...findMentionedCharacterIds(titled,"영안 공주가 들어왔다")],["guest"]);
  assert.deepEqual(resolveActiveCharacterFocus({identities:titled,currentUserText:"영안 공주에게 질문한다"}).names,["영안공주"]);
  assert.equal(resolveActiveCharacterFocus({identities:titled,currentUserText:"영안 공주가 도착했다.",previousUserTexts:["안공주야 말해줘"]}).locked,false);
});
