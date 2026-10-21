/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = process.env.AI_TEST_ROOT || path.resolve(__dirname, '../../../../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = {exports:{}};
  cache.set(file, mod);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  Function('require','module','exports',js)(id => id.startsWith('.')
    ? load(path.resolve(path.dirname(file),id+'.ts')) : require(id), mod, mod.exports);
  return mod.exports;
}
const {buildContinuityLedgerBlock} = load(path.join(root, 'app/api/chat/send/_server/continuityState.ts'));
const identities = [{name:'박도훈'}];
const death = {name:'박도훈',kind:'deceased',turnNo:3,evidence:'박도훈은 칼에 찔려 죽었다.'};
test('turn 3 source death survives a turn 500 summary hallucination', () => {
  const result = buildContinuityLedgerBlock({identities,
    historySummary:'### 과거 사건 (1-3턴)\n박도훈은 현장에서 사망했다.\n\n### 오기 (499-501턴)\n박도훈은 살아서 돌아왔다.',
    authoritativeLifeStates:[death],
  });
  assert.equal(result.states.find(s=>s.name==='박도훈').kind,'deceased');
  assert.match(result.block,/3턴/);
  assert.match(result.block,/칼에 찔려 죽었다/);
});
test('explicit source revival clears stale summary death without deleting history', () => {
  const historySummary='### 과거 사건 (1-3턴)\n박도훈은 현장에서 사망했다.';
  const result=buildContinuityLedgerBlock({identities,historySummary,
    authoritativeLifeStates:[{...death,kind:'alive',turnNo:500,evidence:'박도훈을 부활시킨다.'}],
  });
  assert.equal(result.states.some(s=>s.kind==='deceased'),false);
  assert.match(historySummary,/사망했다/);
});
test('a source state does not overwrite a different character',()=>{
  const result=buildContinuityLedgerBlock({identities:[...identities,{name:'이서윤'}],
    historySummary:'### 사건 (1-3턴)\n이서윤은 현장에서 사망했다.',
    authoritativeLifeStates:[{...death,kind:'alive',turnNo:500}],
  });
  assert.deepEqual(result.states.map(s=>s.name),['이서윤']);
});

test('an alias overlapping another canonical name cannot inherit their source state',()=>{
  const result=buildContinuityLedgerBlock({identities:[...identities,{name:'이서윤',aliases:'박도훈'}],
    historySummary:'',authoritativeLifeStates:[death],
  });
  assert.deepEqual(result.states.map(s=>s.name),['박도훈']);
});
