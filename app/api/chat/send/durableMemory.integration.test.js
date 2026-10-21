/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = process.env.AI_TEST_ROOT || path.resolve(__dirname,'../../../..');
const ts = require(path.join(root,'node_modules/typescript'));
const cache = new Map();
function load(file){
  if(cache.has(file))return cache.get(file).exports;
  const mod={exports:{}};cache.set(file,mod);
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  Function('require','module','exports',js)(id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id),mod,mod.exports);
  return mod.exports;
}
const durable=load(path.join(root,'lib/durable_character_state.ts'));
const vital=load(path.join(root,'lib/vital_status_consistency_guard.ts'));
const continuity=load(path.join(root,'app/api/chat/send/_server/continuityState.ts'));
// Exercise the actual send route's closure without starting a server or using DB/API.
const route=fs.readFileSync(path.join(root,'app/api/chat/send/route.ts'),'utf8');
const ast=ts.createSourceFile('route.ts',route,ts.ScriptTarget.Latest,true);
let initializer;
let repairInitializer;
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='sanitizeVitalStatus')initializer=node.initializer.getText(ast);
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='memoryRepairPending')repairInitializer=node.initializer.getText(ast);
  ts.forEachChild(node,visit);
}
visit(ast);
assert.ok(initializer,'send route must define the shared generated-state sanitizer');
const closureJs=ts.transpileModule(`const result=${initializer};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const identities=[{name:'박도훈'},{name:'이서윤'}];
function setup(messages,historySummary=''){
  const canon=durable.deriveDurableCharacterCanon({messages,identities});
  const ledger=continuity.buildContinuityLedgerBlock({historySummary,identities,authoritativeLifeStates:canon.lifeStates});
  const sanitize=Function('removeUnsupportedVitalStatusClaims','guardGeneratedDurableCharacterState','trustedLegalStatusUserTexts','vitalStatusIdentities','establishedDeceasedNames','durableCharacterCanon','durableStateIdentities','personaNameFinal',closureJs+'\nreturn result;')(
    vital.removeUnsupportedVitalStatusClaims,durable.guardGeneratedDurableCharacterState,
    messages.filter(m=>m.role==='user').map(m=>m.content),identities,
    ledger.states.filter(s=>s.kind==='deceased').map(s=>s.name),canon,identities,'이서윤');
  return {canon,ledger,sanitize};
}
function timeline(event){
  return Array.from({length:500},(_,i)=>[
    {id:`u${i+1}`,role:'user',content:i===2?event:'마을의 풍경을 본다.'},
    {id:`a${i+1}`,role:'assistant',content:'조용한 하루가 지나갔다.'},
  ]).flat();
}
test('send sanitizer preserves historical life while blocking resurrection after 500 turns',()=>{
  const messages=timeline('박도훈은 칼에 찔려 죽었다.');
  messages.push({id:'bad-summary-source',role:'assistant',content:'박도훈은 살아서 돌아왔다.'});
  const {canon,ledger,sanitize}=setup(messages,'### 오기 (499-501턴)\n박도훈은 살아서 돌아왔다.');
  assert.equal(canon.lifeStates[0].sourceMessageId,'u3');
  assert.equal(ledger.states[0].kind,'deceased');
  const living='*박도훈은 문을 열고 들어와 웃으며 말했다.*';
  assert.equal(sanitize(living).text,living);
  assert.equal(sanitize(living,true).text,'');
  assert.equal(sanitize('*이서윤은 문을 열고 들어와 웃었다.*',true).removed,0);
});
test('explicit user revival and undo rebuild state in the actual send closure',()=>{
  const messages=timeline('박도훈은 현장에서 사망했다.');
  const revival={id:'revive',role:'user',content:'박도훈을 부활시킨다.'};
  const alive='*박도훈은 문을 열고 들어왔다.*';
  assert.equal(setup([...messages,revival]).sanitize(alive,true).removed,0);
  assert.ok(setup(messages).sanitize(alive,true).removed>0);
  assert.equal(setup(messages.filter(m=>m.id!=='u3')).sanitize(alive,true).removed,0);
});
test('turn 3 hostility survives ordinary later narration until explicit reconciliation',()=>{
  const messages=timeline('박도훈과 이서윤은 철천지원수다.');
  const friendly='*박도훈과 이서윤은 가장 소중한 친구로 서로를 껴안았다.*';
  messages.push({id:'friendly-error',role:'assistant',content:friendly});
  assert.ok(setup(messages).sanitize(friendly,true).removed>0);
  messages.push({id:'reconcile',role:'user',content:'박도훈과 이서윤은 서로 용서하고 화해했다.'});
  assert.equal(setup(messages).sanitize(friendly,true).removed,0);
});

test('completed summary cursor still signals pending repair, including legacy fallbacks',()=>{
  const Database=require(path.join(root,'node_modules/better-sqlite3'));
  const db=new Database(':memory:');
  db.exec('CREATE TABLE chat_memory_blocks(chatId TEXT,endTurn INTEGER,meta TEXT)');
  const js=ts.transpileModule(`const result=${repairInitializer};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const pending=Function('db','cid','boundaryEndTurn',js+'\nreturn result;');
  try {
    for(const [meta,expected] of [
      ['{}',false],['{broken',false],
      [JSON.stringify({summaryRepairPending:true}),true],
      [JSON.stringify({deterministicFallbackUsed:true}),true],
      [JSON.stringify({deterministicFallbackUsed:true,summaryRepairPending:false}),false],
      [JSON.stringify({structuredGraphPending:{startTurn:1,endTurn:3}}),true],
      [JSON.stringify({structuredGraphPending:null}),false],
    ]){
      db.prepare('DELETE FROM chat_memory_blocks').run();
      db.prepare('INSERT INTO chat_memory_blocks VALUES (?,?,?)').run('test',3,meta);
      assert.equal(pending(db,'test',500),expected,meta);
      assert.equal(pending(db,'test',0),false);
    }
  } finally {db.close();}
});
