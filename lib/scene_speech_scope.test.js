const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(file) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function('require', 'module', 'exports', js)(id => id.startsWith('.') ? load(id + '.ts') : require(id), mod, mod.exports);
  return mod.exports;
}
const { removeUnrequestedOffSceneSpeech: filter } = load('scene_speech_scope.ts');
const { createGuardedTextStream } = load('guarded_text_stream.ts');
const offSceneCharacters = [{ characterName: '민서' }, { characterName: '하린' }];

test('an addressed family keeps its own response while an unsolicited third party is filtered', () => {
  const text = '*가주는 고개를 끄덕였다.*\n\n"다음에 또 오게."\n\n*제갈청아는 소매를 잡아당기며 말했다.*\n\n"제 이야기도 들어 주세요."\n\n*안주인은 웃었다.*\n\n"설이를 잘 부탁하네."';
  const result = filter({ text, currentUserText: '감사합니다.',
    offSceneCharacters: [{ characterName: '제갈청아' }, { characterName: '청아' }],
    addressedCharacters: [{ characterName: '가주' }, { characterName: '안주인' }],
  });
  assert.equal(result.removed, 2);
  assert.match(result.text, /다음에 또 오게/);
  assert.match(result.text, /설이를 잘 부탁하네/);
  assert.doesNotMatch(result.text, /제갈청아|제 이야기도/);
});

test('an absent short-name character does not suppress the distinct local full-name speaker', () => {
  const text = '*제갈청아는 고개를 끄덕였다.*\n\n"알겠습니다."';
  assert.equal(filter({ text, offSceneCharacters: [{ characterName: '청아' }] }).text, text);
});
const fixture = '*지아는 서류를 펼쳤다.*\n\n"함께 확인해요."\n\n*문밖의 민서는 안으로 말을 건넸다.*\n\n"어서 서명하세요!"\n\n*하린은 고개를 끄덕이며 거들었다.*\n\n"제 말도 들어 주세요!"\n\n*지아는 다음 장을 넘겼다.*\n\n"여기 날짜를 봐요."\n\n```INFO\n장소: 서재\n\n민서: 마당\n```';
const run = (text, extra = {}) => filter({ text, offSceneCharacters, currentUserText: '계속 확인해.', ...extra });

test('removes off-scene narration and its following dialogue, retaining the local scene and INFO', () => {
  const result = run(fixture);
  assert.equal(result.removed, 4);
  assert.doesNotMatch(result.text.split('```')[0], /민서|하린|어서 서명|제 말도/);
  assert.match(result.text, /함께 확인해요/);
  assert.match(result.text, /여기 날짜를 봐요/);
  assert.ok(result.text.endsWith('```INFO\n장소: 서재\n\n민서: 마당\n```'));
});

test('every chunk split yields the same output without leaking a removed voice', () => {
  const expected = run(fixture).text.trim();
  for (const size of [1, 2, 7, 19, 81, fixture.length]) {
    let contextText = '';
    const gate = createGuardedTextStream((text) => {
      const result = run(text, { contextText });
      contextText = `${contextText}\n${text}`.slice(-1600);
      return result.text;
    }, { paragraphs: true });
    const emitted = [];
    for (let i = 0; i < fixture.length; i += size) emitted.push(gate.push(fixture.slice(i, i + size)));
    emitted.push(gate.finish());
    assert.equal(gate.output().trim(), expected, `chunk size ${size}`);
    assert.equal(emitted.join(''), gate.output());
    assert.doesNotMatch(emitted.join('').split('```')[0], /어서 서명|제 말도/);
  }
});

test('requested contact, group replies and approved world events remain available', () => {
  for (const currentUserText of ['밖에 누구야? 대답해.', '전화 받아봐.', '다들 의견 말해봐.', '들어와.']) {
    assert.equal(run(fixture, { currentUserText }).text, fixture);
  }
  assert.equal(run(fixture, { allowExternalContact: true }).text, fixture);
  const named = '*민서는 문밖에서 말했다.*\n\n"네, 듣고 있어요."';
  assert.equal(run(named, { currentUserText: '민서야, 어떻게 생각해?' }).text, named);
});

test('mentioning or recalling an absent person does not remove local speech', () => {
  const text = '*지아는 민서에게 받은 편지를 펼쳤다.*\n\n"민서는 여기 없지만 편지는 남아 있네요."\n\n*민서와 함께했던 지난날을 떠올리며 지아는 미소 지었다.*\n\n*지아는 민서와 함께 일하고 싶다고 말했다.*\n\n*지아는 민서의 말을 인용했다.*';
  assert.equal(run(text).text, text);
});

test('unknown remote speakers are also filtered, without requiring roster registration', () => {
  const text = '*문밖에서 낯선 사람이 안으로 말을 걸었다.*\n\n"서둘러요!"\n\n*지아는 서류를 펼쳤다.*\n\n"이 항목부터 볼까요?"';
  const result = run(text);
  assert.equal(result.removed, 2);
  assert.doesNotMatch(result.text, /서둘러요/);
  assert.match(result.text, /이 항목부터/);
});

test('a mixed background list cannot swallow the local paragraph or its next dialogue', () => {
  const text = '*지아는 문서를 펼쳤다. 민서는 마당에서 하린과 함께 서 있었다.*\n\n"첫 항목을 읽을게요."';
  const result = run(text);
  assert.equal(result.text, '*지아는 문서를 펼쳤다.*\n\n"첫 항목을 읽을게요."');
});

test('a local listener may mention an ordinary outside sound and continue speaking', () => {
  const text = '*지아는 문밖에서 들려오는 바람 소리를 듣고 말했다.*\n\n"바람이 세네요."';
  assert.equal(run(text).text, text);
});

test('possessive voice attribution in a mixed paragraph still owns the next quote', () => {
  const text = '*지아는 책을 펼쳤다. 민서의 목소리가 날카롭게 울렸다.*\n\n"어서 읽으세요!"\n\n*지아는 다음 장을 넘겼다.*\n\n"이어서 읽을게요."';
  const result = run(text);
  assert.doesNotMatch(result.text, /민서|어서 읽으세요/);
  assert.match(result.text, /지아는 책을 펼쳤다/);
  assert.match(result.text, /이어서 읽을게요/);
});

test('a named addressee keeps her reply while other present speakers cannot answer for her', () => {
  const text='*지아는 지도를 펼쳤다.*\n\n"여기로 가면 돼요."\n\n*민서는 옆에서 대신 대답했다.*\n\n"제 설명부터 들어요!"\n\n하린: "저도 한마디 할게요."\n\n*지아는 출발점을 짚었다.*\n\n"이어서 설명할게요."';
  const result=filter({text,offSceneCharacters,addressedCharacters:[{characterName:'지아'}],currentUserText:'그래, 다음은?'});
  assert.match(result.text,/여기로 가면/);
  assert.match(result.text,/이어서 설명/);
  assert.doesNotMatch(result.text,/민서|하린|제 설명|한마디/);
});
