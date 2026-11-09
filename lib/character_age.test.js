/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const cache = new Map();
let factRows = [];
let vitalRows = [];
const db = { prepare(sql) {
  if (sql.includes('FROM chat_character_facts')) return { all: () => factRows };
  if (sql.includes('FROM chats')) return { get: () => ({ createdAt: 1 }) };
  if (sql.includes('FROM chat_settings')) return { get: () => ({ personaAge: 30 }) };
  if (sql.includes('FROM chat_character_roster')) return { all: () => [{ id: 'person1', name: '제갈청아', aliases: '', profile: '', role: '', createdAt: 1 }] };
  if (sql.includes('SELECT id, personKey FROM chat_character_vitals')) return { all: () => [] };
  if (sql.startsWith('DELETE FROM chat_character_vitals')) return { run: () => { throw new Error('Unexpected deletion'); } };
  if (sql.includes('INSERT INTO chat_character_vitals')) return { run: (...row) => vitalRows.push(row) };
  throw new Error('Unexpected database access: ' + sql);
}, transaction(fn) { return fn; } };
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function('require', 'module', 'exports', js)(id => {
    if (id === '@/lib/db') return { db };
    if (id === '@/lib/crypto') return { decryptIfPossible: String, encryptIfPossible: String };
    if (id.startsWith('@/lib/')) return load(path.join(__dirname, id.slice(6) + '.ts'));
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
    return require(id);
  }, mod, mod.exports);
  return mod.exports;
}
const age = load(path.join(__dirname, 'character_age.ts'));
const canonical = load(path.join(__dirname, 'canonical_character_facts.ts'));
const original = { sourceRole: 'assistant', value: '20세', turnNo: 3, confidence: 95,
  evidence: '제갈청아는 올해 스무 살이다.', factKey: 'age', subjectName: '제갈청아' };
const ages = [{ name: '제갈청아', age: 20 }, { name: '청아', age: 28 }, { name: '남궁하', age: 24 }];
const guard = text => age.enforceCharacterAges({ text, ages }).text;

test('a grounded first age survives hundreds of later turns and repeated conflicting AI claims', () => {
  const later = Array.from({ length: 300 }, (_, i) => ({ ...original, value: '21세', turnNo: i + 10, evidence: `제갈청아는 21세이다. 장면 ${i}` }));
  assert.equal(age.resolveCanonicalAgeCandidate([...later, original]).value, '20세');
  assert.equal(age.resolveCanonicalAgeCandidate([original, { ...original, sourceRole: 'user', value: '22세', turnNo: 500 }]).value, '22세');
});

test('a guess, past age, future age, denial, question, or evidence for another age is not canon', () => {
  for (const evidence of ['스무 살쯤으로 보였다.', '제갈청아는 스무 살이 아니다.', '당시 스무 살이었다.', '스무 살이 되면 떠나자.', '스무 살인가?', '스물한 살이다.']) {
    assert.equal(age.resolveCanonicalAgeCandidate([{ ...original, evidence }]), null, evidence);
  }
  assert.equal(age.resolveCanonicalAgeCandidate([{ ...original, confidence: 60 }]), null);
});

test('current named age and self introduction are repaired without changing similar names or other people', () => {
  const raw = '"다섯 번째로 찾아온 제갈청아이옵니다…… 나이는 스물한 살이며, 만나서 반갑습니다."\n*청아는 28세이다. 남궁하는 24세이다.*';
  const fixed = guard(raw);
  assert.match(fixed, /나이는 스무 살이며/);
  assert.match(fixed, /청아는 28세/);
  assert.match(fixed, /남궁하는 24세/);
  assert.equal(guard('*스물한 살인 제갈청아가 서류를 읽었다.*'), '*스무 살인 제갈청아가 서류를 읽었다.*');
  assert.equal(guard('*제갈청아의 나이는 21세이다.*'), '*제갈청아의 나이는 20세이다.*');
});

test('past ages, questions, comparisons, denial, and unspecified speakers are preserved', () => {
  for (const raw of ['제갈청아는 열다섯 살 때 이곳에 왔다.', '작년에 제갈청아는 열아홉 살이었다.', '제갈청아는 21세가 되면 출발한다.', '제갈청아는 21세가 아니라 20세이다.', '제갈청아는 21세 맞니?', '제갈청아는 21세라고 거짓말했다.', '제갈청아는 청아보다 세 살 어리다.', '"저는 스물한 살입니다."']) {
    assert.equal(guard(raw), raw);
  }
  assert.equal(guard('*제갈청아가 말했다.*\n"저는 스물한 살입니다."'), '*제갈청아가 말했다.*\n"저는 스무 살입니다."');
});

test('unknown speakers and name suffixes cannot inherit a known age', () => {
  const raw = '*홍청아는 35세이다. 제갈청아는 미소를 지었다.*';
  assert.equal(guard(raw), raw);
  assert.equal(age.enforceCharacterAges({ text: '*제갈청아가 민서를 만났다.*\n"저는 30세입니다."', ages, characters: [...ages, { name: '민서' }] }).rewritten, 0);
});

test('streamed paragraphs and legacy string aliases retain the same age attribution', () => {
  const { createGuardedTextStream } = load(path.join(__dirname, 'guarded_text_stream.ts'));
  const raw = '*제갈청아가 말했다.*\n\n"저는 스물한 살입니다."';
  let contextText = '';
  const stream = createGuardedTextStream(text => {
    const checked = age.enforceCharacterAges({ text, contextText, ages, characters: [{ name: '제갈청아', aliases: '제갈 소저,청아 소저' }] });
    contextText += text;
    return checked.text;
  }, { paragraphs: true });
  let output = '';
  for (const ch of raw) output += stream.push(ch);
  output += stream.finish();
  assert.equal(output, '*제갈청아가 말했다.*\n\n"저는 스무 살입니다."');
});

test('only user corrections and later explicit time jumps update the established age', () => {
  const messages = [
    { role: 'user', content: '10년이 지났다.' },
    { role: 'assistant', content: original.evidence },
    ...Array.from({ length: 400 }, () => ({ role: 'assistant', content: '제갈청아는 21세이다.' })),
  ];
  const get = extra => age.buildCharacterAgeCanon({ facts: [original], messages: [...messages, ...extra] })[0].age;
  assert.equal(get([]), 20);
  assert.equal(get([{ role: 'user', content: '그로부터 1년이 지났다.' }]), 21);
  assert.equal(get([{ role: 'user', content: '한 년이 지났다.' }]), 21);
  assert.equal(get([{ role: 'user', content: '제갈청아는 원래 23세이다.' }]), 23);
  assert.equal(get([{ role: 'user', content: '제갈청아는 21세 아니야?' }]), 20);
  assert.equal(get([{ role: 'user', content: '만약 2년 뒤라면?' }]), 20);
  assert.equal(get([{ role: 'user', content: '제갈청아는 "5년이 지났다"라고 읽는다.' }]), 20);
});

test('independent chats do not share ages and missing evidence does not replay ancient time jumps', () => {
  assert.deepEqual(age.buildCharacterAgeCanon({ facts: [], messages: [{ role: 'assistant', content: original.evidence }] }), []);
  assert.equal(age.buildCharacterAgeCanon({ facts: [original], messages: [{ role: 'user', content: '10년 후.' }] })[0].age, 20);
});

test('stored single age reaches the canon prompt even outside focus and beyond the other fact limit', () => {
  factRows = [{ ...original, id: 'age1', subjectKey: 'person1', factValue: original.value, category: 'age', authority: 40 }];
  const facts = canonical.loadCanonicalCharacterFacts('new-chat');
  assert.equal(facts[0].value, '20세');
  const many = Array.from({ length: 130 }, (_, i) => ({ ...facts[0], factKey: 'occupation', subjectName: '주인공', value: `직업 ${i}` }));
  const prompt = canonical.formatCanonicalCharacterFactsBlock({
    persona: canonical.buildAuthoritativePersonaFacts({ name: '주인공' }), facts: [...many, ...facts], focusNames: ['주인공'],
  });
  assert.match(prompt, /제갈청아 · 나이: 20세/);
});

test('character registry fills missing age from the same source and respects later user changes', () => {
  const { syncCharacterVitals } = load(path.join(__dirname, 'character_vitals.ts'));
  factRows = [{ ...original, id: 'age1', subjectKey: 'person1', factValue: original.value, category: 'age', authority: 40 }];
  for (const [content, expected] of [['계속 이야기한다.', 20], ['그로부터 1년이 지났다.', 21], ['제갈청아는 24세이다.', 24]]) {
    vitalRows = [];
    syncCharacterVitals({ chatId: 'chat', canon: { roleAnchors: [] }, personaName: '주인공', personaAge: 30,
      messages: [{ role: 'assistant', content: original.evidence, createdAt: 2 }, { role: 'user', content, createdAt: 3 }] });
    const row = vitalRows.find(row => row.includes('제갈청아'));
    assert.ok(row);
    assert.equal(row[6], expected);
  }
});

test('production sanitizer performs the correction and all response paths invoke it', () => {
  const route = fs.readFileSync(path.join(__dirname, '../app/api/chat/send/route.ts'), 'utf8');
  const ast = ts.createSourceFile('route.ts', route, ts.ScriptTarget.Latest, true);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'sanitizeCharacterAgeText') initializer = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer);
  const js = ts.transpileModule(`const sanitize=${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sanitize = Function('enforceCharacterAges', 'characterAgeCanon', 'continuityLedgerIdentities', 'dbg', 'cid', 'reqId', js + '\nreturn sanitize;')(age.enforceCharacterAges, ages, ages, () => {}, 'chat', 'request');
  assert.equal(sanitize('제갈청아는 21세이다.'), '제갈청아는 20세이다.');
  assert.match(route, /sanitizeCommunicationAbilities\(sanitizeCharacterAgeText\(physicalOwnership.text\)\)/);
  assert.match(route, /sanitizeScenePresence\(sanitizeCharacterAgeText\(physicalOwnership.text, streamCommunicationContext\), streamCommunicationContext\)/);
  assert.match(route, /sanitizeScenePresence\(sanitizeCharacterAgeText\(physicalOwnership.text\)\)/);
  assert.match(route, /sanitizeScenePresence\(sanitizeCharacterAgeText\(physicalOwnershipOutputChecked.text\)\)/);
});

test('multiple numbers in evidence distinguish an exact age from an upper bound', () => {
  const fact = { ...original, value: '19세', evidence: '모용설 소저는 올해 꼭 열아홉 살로, 아직 스무 살이 채 되지 않았다.' };
  assert.equal(age.resolveCanonicalAgeCandidate([fact]).value, '19세');
  assert.equal(age.resolveCanonicalAgeCandidate([{ ...fact, value: '20세' }]), null);
  assert.equal(age.resolveCanonicalAgeCandidate([{ ...original, value: '28세', evidence: '큰형님께서는 아직 스물여덟밖에 되지 않으셨고' }]).value, '28세');
  assert.equal(age.resolveCanonicalAgeCandidate([{ ...original, value: '18세', evidence: '올해 열여덟이 된 아가씨라오.' }]).value, '18세');
});

test('first introductions survive incomplete extraction and later age drift for an entire cast', () => {
  const characters = ['채연', '금하', '서령', '녹주', '청아', '설영', '연화', '단비'].map(name => ({ name }));
  const intro = '"제 이름은 채연이고, 나이는 스물한 살입니다. 금하와 서령이는 이제 스무 살, 녹주와 청아는 열아홉 살입니다."\n"저는 열여덟 살 설영입니다."\n"제 이름은 연화고, 설영이 사매랑 같은 열여덟 살이에요! 막내 단비는 이제 겨우 열일곱 살입니다."';
  const messages = [{ role: 'assistant', content: intro }, ...Array.from({ length: 500 }, () => ({ role: 'assistant', content: '녹주는 열다섯 살이다. 단비는 18세이다. 연화는 15세이다.' }))];
  const wrongLaterFacts = [{ ...original, subjectName: '녹주', value: '15세', evidence: '녹주는 열다섯 살이다.' }];
  const current = age.buildCharacterAgeCanon({ facts: wrongLaterFacts, characters, messages });
  assert.deepEqual(Object.fromEntries(current.map(person => [person.name, person.age])), {
    채연: 21, 금하: 20, 서령: 20, 녹주: 19, 청아: 19, 설영: 18, 연화: 18, 단비: 17,
  });
  factRows = [];
  const canonicalFacts = canonical.loadCanonicalCharacterFacts('isolated-chat', { characters, messages });
  const prompt = canonical.formatCanonicalCharacterFactsBlock({ persona: canonical.buildAuthoritativePersonaFacts({ name: '주인공' }), facts: canonicalFacts, focusNames: ['주인공'] });
  assert.match(prompt, /녹주 · 나이: 19세/);
  assert.match(prompt, /연화 · 나이: 18세/);
  // A new chat has its own introductions even when the names are reused.
  assert.equal(age.buildCharacterAgeCanon({ facts: [], characters, messages: [{ role: 'assistant', content: '녹주는 25세이다.' }] })[0].age, 25);
});

test('self-reference is resolved to the local speaker, never another character with a pronoun alias', () => {
  const characters = [{ name: '유이설', aliases: ['소첩'] }, { name: '남궁하' }, { name: '제갈청아' }, { name: '가주' }, { name: '팽소희' }, { name: '조문기' }];
  const localAges = [{ name: '유이설', age: 28 }, { name: '남궁하', age: 20 }, { name: '제갈청아', age: 20 }, { name: '팽소희', age: 18 }];
  const text = '*가주는 찻잔을 들었다. 남궁하가 입매를 열며 앞으로 나선다.*\n\n"소첩의 나이는 올해 스물한 살입니다."\n\n*남궁하의 말을 듣던 제갈청아는 고개를 들었다.*\n\n"소녀 역시 스물두 살입니다."';
  const result = age.enforceCharacterAges({ text, ages: localAges, characters });
  assert.equal(result.rewritten, 2);
  assert.deepEqual(result.names, ['남궁하', '제갈청아']);
  const reporting = '*가주가 말했다.*\n"팽소희 소저는 가주의 막내딸로, 올해 열여덟이 된 아가씨라오."\n*조문기가 말했다.*\n"제갈 소저께서는 올해 스무 살이시온데 객청에서 기다리십니다."';
  const discovered = age.buildCharacterAgeCanon({ facts: [], characters, messages: [{ role: 'assistant', content: reporting }] });
  assert.ok(discovered.every(person => !['가주', '조문기'].includes(person.name)));
});

test('a background group cannot become the speaker of an unnamed age statement', () => {
  const characters = ['백천', '윤종', '현종', '현영', '소소', '마춘삼'].map(name => ({ name }));
  const text = '*백천과 윤종이 소리를 듣는다. 현종과 현영, 소소, 마춘삼 역시 고개를 들지 못한다.*\n"소녀는 올해 열여덟 살입니다."';
  assert.deepEqual(age.buildCharacterAgeCanon({ facts: [], characters, messages: [{ role: 'assistant', content: text }] }), []);
});

test('group age conflicts are corrected per person rather than assigning one age to everybody', () => {
  const localAges = [{ name: '녹주', age: 19 }, { name: '설영', age: 18 }];
  const direct = age.enforceCharacterAges({ text: '녹주와 설영은 열일곱 살입니다.', ages: localAges });
  assert.match(direct.text, /녹주는 열아홉 살, 설영은 열여덟 살입니다/);
  const leading = age.enforceCharacterAges({ text: '열일곱 살인 녹주와 설영이 책을 읽는다.', ages: localAges });
  assert.match(leading.text, /열아홉 살인 녹주, 열여덟 살인 설영/);
  assert.equal(age.enforceCharacterAges({ text: '열다섯 살인 연화까지 모였다.', ages: [{ name: '연화', age: 18 }] }).text, '열여덟 살인 연화까지 모였다.');
});

test('future plans do not age the cast and an explicit user change survives later AI drift', () => {
  const characters = [{ name: '민서' }];
  const messages = [{ role: 'assistant', content: '민서는 22세이다.' }, { role: 'user', content: '5년 뒤에 찾아갈게.' }, { role: 'user', content: '민서는 원래 24세이다.' }, { role: 'assistant', content: '민서는 22세이다.' }];
  const current = age.buildCharacterAgeCanon({ facts: [], characters, messages });
  assert.equal(current[0].age, 24);
  assert.equal(age.buildCharacterAgeCanon({ facts: [], characters, messages: messages.slice(0, 2) })[0].age, 22);
  assert.equal(age.buildCharacterAgeCanon({ facts: [], characters, messages: messages.slice(0, 1) })[0].age, 22);
});
