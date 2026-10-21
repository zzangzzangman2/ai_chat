/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");
const ts=require("typescript");
const loaded={exports:{}};
const output=ts.transpileModule(fs.readFileSync(path.join(__dirname,"persistent_character_conditions.ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
Function("exports","module","require",output)(loaded.exports,loaded,()=>{throw new Error("Pure condition tests must not access external dependencies");});
const {derivePersistentCharacterConditions,buildPersistentCharacterConditionsBlock,guardGeneratedPersistentCharacterConditions}=loaded.exports;
const identities=[{name:"유이설",aliases:'["이설"]'},{name:"청명",aliases:[]},{name:"단비",aliases:"단 사매"}];
const msg=(id,role,content,turnNo)=>({id,role,content,turnNo});
const pregnant=msg("pregnancy-3","user","*유이설 임신함*",3);
const derive=(messages,extra={})=>derivePersistentCharacterConditions({messages,identities,...extra});
const guard=(text,canon=derive([pregnant]))=>guardGeneratedPersistentCharacterConditions({text,canon,identities});

test("bare user pregnancy notation survives 500 turns without repeated prompting",()=>{
  const messages=[pregnant,...Array.from({length:497},(_,index)=>msg(`m${index}`,"assistant","일행은 다음 여정을 이어갔다.",index+4)),msg("a500","assistant",'*청명은 "유이설의 임신은 헛소리야"라고 말했다.*',500)];
  const state=derive(messages).pregnancies[0];
  assert.equal(state.status,"pregnant");assert.equal(state.turnNo,3);assert.equal(state.sourceMessageId,"pregnancy-3");assert.equal(state.history.length,1);
});

test("the 200-turn event stays the initial source after 217 and 263 confirmations",()=>{
  const state=derive([msg("u200","user","*유이설 임신함*",200),msg("a217","assistant","유이설은 회임하였다.",217),msg("u263","user","이설이가 잉태하였는데 이제 여정을 떠난다.",263)]).pregnancies[0];
  assert.equal(state.turnNo,200);assert.equal(state.sourceMessageId,"u200");assert.equal(state.history.length,1);assert.equal(state.lastConfirmedTurn,263);
});

test("plain statements and colloquial alias particles resolve to the correct person",()=>{
  for(const text of ["유이설은 임신했다.","이설이가 임신했다.","이설이는 회임하였다.","이설 임신함"]){
    assert.equal(derive([msg("u3","user",text,3)]).pregnancies[0]?.name,"유이설",text);
  }
});

test("first completed narrator diagnosis and legacy model role can establish pregnancy",()=>{
  const state=derive([msg("a3","model","유이설의 태기를 확인했다.",3)]).pregnancies[0];
  assert.equal(state?.status,"pregnant");assert.equal(state.sourceRole,"assistant");
});

test("quoted denial, ignorance and disbelief cannot cancel world state",()=>{
  for(const text of ['청명은 "유이설은 임신하지 않았다"라고 말했다.',"청명은 유이설의 임신을 믿지 않았다.","청명은 유이설이 임신한 사실을 몰랐다.","유이설은 임신하지 않았다."]){
    const state=derive([pregnant,msg("a500","assistant",text,500)]).pregnancies[0];
    assert.equal(state.status,"pregnant",text);assert.equal(state.sourceMessageId,"pregnancy-3",text);
  }
});

test("generated dialogue denial and a character's disbelief remain untouched",()=>{
  for(const text of ['"유이설의 임신은 지어낸 헛소리야."','청명: "유이설은 임신하지 않았다."',"*청명은 유이설의 임신을 헛소리로 취급했다.*","*청명은 유이설의 임신을 믿지 않았다.*"]){
    assert.equal(guard(text).text,text,text);
  }
});

test("generated narrator cannot negate a pinned pregnancy as objective fact",()=>{
  for(const text of ["*유이설은 임신하지 않았다.*","*유이설의 임신은 지어낸 헛소리였다.*","*유이설의 태기는 없었다.*"]){
    const result=guard(text);assert.equal(result.text,"",text);assert.equal(result.removed,1,text);
  }
});

test("an unrelated narrator sentence remains with balanced narration markers",()=>{
  assert.equal(guard("*유이설은 임신하지 않았다. 청명은 문을 닫았다.*").text,"*청명은 문을 닫았다.*");
});

test("birth ends current pregnancy but retains the initial pregnancy event",()=>{
  const canon=derive([pregnant,msg("a500","assistant","이설이는 아이를 출산했다.",500)]);
  const state=canon.pregnancies[0];assert.equal(state.status,"ended");assert.equal(state.outcome,"birth");assert.equal(state.history.length,2);assert.equal(state.history[0].sourceMessageId,"pregnancy-3");
  assert(buildPersistentCharacterConditionsBlock(canon).includes("과거 임신은 3턴"));
});

test("completed miscarriage and termination are transitions, including assistant narration",()=>{
  for(const [text,outcome]of[["유이설은 유산했다.","miscarriage"],["유이설은 임신을 중단했다.","termination"]]){
    const state=derive([pregnant,msg("a500","assistant",text,500)]).pregnancies[0];assert.equal(state.status,"ended",text);assert.equal(state.outcome,outcome,text);
  }
});

test("a completed diagnostic correction changes state without erasing its provenance",()=>{
  const state=derive([pregnant,msg("a500","assistant","검사 결과 유이설은 임신이 아닌 것으로 확인됐다.",500)]).pregnancies[0];
  assert.equal(state.status,"corrected_not_pregnant");assert.equal(state.outcome,"correction");assert.equal(state.history.length,2);assert.equal(state.sourceMessageId,"a500");
});

test("an explicit user setting correction may resolve an erroneous pregnancy",()=>{
  const state=derive([pregnant,msg("u500","user","설정 정정: 유이설 임신 아님.",500)]).pregnancies[0];
  assert.equal(state.status,"corrected_not_pregnant");
});

test("questions, plans, threats, metaphors and possibilities do not establish pregnancy",()=>{
  for(const text of ["유이설은 임신했나요?","유이설이 임신했을지도 모른다.","유이설은 임신할 계획이다.","만약 유이설이 임신했다면 좋겠다.","유이설의 새로운 발상은 비유적으로 잉태하였다.",'"유이설 임신함"이라고 거짓말했다.',"유이설은 임신했다는 소문을 들었다."]){
    assert.deepEqual(derive([msg("u3","user",text,3)]).pregnancies,[],text);
  }
});

test("questions and hypothetical endpoints cannot terminate a prior pregnancy",()=>{
  for(const text of ["유이설은 출산했나요?","유이설은 출산할 예정이다.","만약 유이설은 유산했다면 어떻게 되지?","유이설은 낙태하겠다고 협박했다.","유이설은 출산하지 않았다."]){
    assert.equal(derive([pregnant,msg("u500","user",text,500)]).pregnancies[0].status,"pregnant",text);
  }
});

test("undo restores pregnancy before birth and removes a deleted initial event",()=>{
  assert.deepEqual(derive([]).pregnancies,[]);
  assert.equal(derive([pregnant,msg("a500","assistant","유이설은 출산했다.",500)]).pregnancies[0].status,"ended");
  assert.equal(derive([pregnant]).pregnancies[0].status,"pregnant");
});

test("another person's pregnancy or delivery is not assigned to the observer",()=>{
  const canon=derive([pregnant,msg("a500","assistant","청명은 단비의 임신을 확인했다.",500)]);
  assert.equal(canon.pregnancies.length,2);assert.equal(canon.pregnancies.find((state)=>state.name==="유이설").status,"pregnant");assert.equal(canon.pregnancies.find((state)=>state.name==="단비").status,"pregnant");
  assert.equal(canon.pregnancies.some((state)=>state.name==="청명"),false);
  assert.deepEqual(derive([msg("a3","assistant","청명은 친구의 임신을 확인했다.",3)]).pregnancies,[]);
});

test("a shared alias cannot transfer a condition to either owner",()=>{
  const canon=derive([msg("u3","user","이설 임신함",3)],{identities:[{name:"유이설",aliases:["이설"]},{name:"김이설",aliases:["이설"]}]});
  assert.deepEqual(canon.pregnancies,[]);
});

test("world facts do not silently grant NPC knowledge",()=>{
  const canon=derive([pregnant]);const block=buildPersistentCharacterConditionsBlock(canon);
  assert.equal(canon.pregnancies[0].knowledgeScope,"world_only");
  assert(block.includes("NPC가 알고 있다는 뜻이 아니다"));assert(block.includes("자동 공유하지 않는다"));
});

test("explicit app turn zero is retained for prologue events",()=>{
  assert.equal(derive([msg("intro","assistant","유이설은 임신했다.",0)]).pregnancies[0].turnNo,0);
});

test("the event at the end of a long turn retains its name and predicate evidence",()=>{
  const canon=derive([msg("long","user",`${"일행은 긴 여정을 이어갔다 ".repeat(200)} 유이설 임신함`,3)]);
  const state=canon.pregnancies[0];assert.equal(state.status,"pregnant");assert(state.evidence.includes("유이설"));assert(state.evidence.includes("임신함"));assert(state.evidence.length<=250);
});

test("separate chats with the same names never inherit each other's condition",()=>{
  const first=derive([pregnant,msg("a500","assistant","일행은 다시 마을에 도착했다.",500)]);
  const fresh=derive([msg("new-1","user","유이설은 길을 걷는다.",1)]);
  assert.equal(first.pregnancies[0].status,"pregnant");
  assert.deepEqual(fresh.pregnancies,[]);
  const second=derive([msg("new-pregnancy-3","user","이설이가 임신했다.",3),msg("new-500","assistant","일행은 산에 도착했다.",500)]);
  assert.equal(second.pregnancies[0].status,"pregnant");
  assert.equal(second.pregnancies[0].sourceMessageId,"new-pregnancy-3");
  assert.deepEqual(derive([]).pregnancies,[]);
});

test("denying a claim is not narrator confirmation of the claim",()=>{
  for(const text of ["유이설은 임신했다는 말을 부정했다.","유이설은 임신했다는 주장을 부인했다."]){
    assert.deepEqual(derive([msg("a3","assistant",text,3)]).pregnancies,[],text);
    assert.equal(guard(text).text,text,text);
  }
});

test("a past birth reference does not end the current pregnancy",()=>{
  const canon=derive([pregnant,msg("a500","assistant","유이설은 예전에 아이를 출산했다.",500)]);
  assert.equal(canon.pregnancies[0].status,"pregnant");
  const memory="*과거에 유이설은 임신하지 않았다.*";
  assert.equal(guard(memory).text,memory);
});

test("the other parent's possessive name does not steal pregnancy ownership",()=>{
  const canon=derive([msg("a3","assistant","유이설은 청명의 아이를 임신했다.",3)]);
  assert.equal(canon.pregnancies.length,1);assert.equal(canon.pregnancies[0].name,"유이설");
});

test("a friend's fetal death is not assigned to the mentioned observer",()=>{
  const canon=derive([pregnant,msg("a500","assistant","유이설의 친구 뱃속 태아가 사망했다.",500)]);
  assert.equal(canon.pregnancies[0].status,"pregnant");assert.equal(canon.pregnancies[0].history.length,1);
});

test("birth followed by another pregnancy in the same sentence applies in event order",()=>{
  const state=derive([pregnant,msg("a500","assistant","유이설은 출산했다가 다시 임신했다.",500)]).pregnancies[0];
  assert.equal(state.status,"pregnant");assert.deepEqual(state.history.map((event)=>event.outcome),["pregnancy","birth","pregnancy"]);
});

test("completed diagnostic corrections remain possible in generated narration",()=>{
  const text="*검사 결과 유이설은 임신하지 않았음이 확인되었다.*";
  assert.equal(guard(text).text,text);
  assert.equal(derive([pregnant,msg("a500","assistant",text,500)]).pregnancies[0].status,"corrected_not_pregnant");
});

test("conditional and negated pregnancy-state phrases never establish pregnancy",()=>{
  for(const text of ["유이설은 임신한 상태였다면 쉬었을 것이다.","유이설은 임신한 상태라면 쉬어야 한다.","유이설은 임신한 상태가 아니었다.","유이설은 임신 중이 아니었다."]){
    assert.deepEqual(derive([msg("u3","user",text,3)]).pregnancies,[],text);
  }
});

test("explicit ongoing pregnancy and gestational-age statements establish the condition",()=>{
  for(const text of ["유이설은 임신 중이다.","유이설은 임신 3개월이다.","유이설은 임신 12주차이다.","유이설은 임신한 상태였다."]){
    assert.equal(derive([msg("u3","user",text,3)]).pregnancies[0]?.status,"pregnant",text);
  }
});

test("gestational-age hypotheticals and questions remain unconfirmed",()=>{
  for(const text of ["유이설은 임신 3개월이라면 쉬어야 한다.","유이설은 임신 3개월일 가능성이 있다.","유이설은 임신 중인가요?"]){
    assert.deepEqual(derive([msg("u3","user",text,3)]).pregnancies,[],text);
  }
});
