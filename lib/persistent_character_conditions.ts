import type { DurableCharacterIdentity, DurableStateMessage } from "./durable_character_state";

export type PregnancyEvent = {
  name: string;
  status: "pregnant" | "ended" | "corrected_not_pregnant";
  outcome: "pregnancy" | "birth" | "miscarriage" | "termination" | "correction";
  sourceRole: "user" | "assistant";
  sourceMessageId: string;
  turnNo: number;
  evidence: string;
};
export type PersistentPregnancyState = PregnancyEvent & {
  history: PregnancyEvent[];
  knowledgeScope: "world_only";
  lastConfirmedTurn: number;
  lastConfirmedMessageId: string;
};
export type PersistentCharacterConditions = { pregnancies: PersistentPregnancyState[] };

function norm(value: string) { return value.normalize("NFKC").toLocaleLowerCase("ko-KR"); }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function aliasList(value: DurableCharacterIdentity["aliases"]) {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value || "");
  try { const parsed: unknown = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map(String); } catch { /* Legacy aliases. */ }
  return text.split(/[,;|\n]/u);
}
type Mention = { name: string; start: number; end: number };
function makeMatcher(identities: DurableCharacterIdentity[]) {
  const owners = new Map<string, Set<string>>();
  const spellings = new Map<string,string>();
  const canonical = new Map<string,string>();
  for (const identity of identities) {
    const name = String(identity.name || "").trim();
    if (!name) continue;
    canonical.set(norm(name),name);
    for (const raw of [name,...aliasList(identity.aliases)]) {
      const variant = raw.trim();
      if (variant.length < 2) continue;
      const key = norm(variant);
      const names = owners.get(key) || new Set<string>();
      names.add(name); owners.set(key,names); spellings.set(key,variant);
    }
  }
  const resolved = new Map<string,string>();
  for (const [key,names] of owners) {
    if (canonical.has(key)) resolved.set(key,canonical.get(key)!);
    else if (names.size === 1) resolved.set(key,[...names][0]);
  }
  const variants = [...resolved.keys()].map((key) => spellings.get(key)!).sort((a,b) => b.length-a.length);
  const regex = variants.length ? new RegExp(`(?<![가-힣A-Za-z0-9_])(?:${variants.map(escapeRegex).join("|")})(?=$|(?:에게|한테|께서|으로|이라고|라는|의|은|는|이|가|을|를|와|과|도|만|야|아|님|씨)|[^가-힣A-Za-z0-9_])`,"giu") : null;
  return (text: string): Mention[] => {
    if (!regex) return [];
    regex.lastIndex=0;
    return [...text.matchAll(regex)].map((match) => ({name:resolved.get(norm(match[0]))!,start:match.index!,end:match.index!+match[0].length}));
  };
}
function narration(text: string) {
  return text.replace(/```[\s\S]*?(?:```|$)/gu," ")
    .replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|‘[^’\n]*(?:’|$)|'[^'\n]*(?:'|$)/gu," ");
}
function sourceSentences(text: string) {
  return narration(text).split(/(?<=[.!?。！？])\s+|[\r\n]+/u).map((item) => item.replace(/\s+/gu," ").trim()).filter(Boolean);
}
const UNCERTAIN = /[?？]|(?:만약|가정|상상|가능성|일지도|한지도|한\s*것\s*같|했을지도|일\s*수|할\s*수|했을\s*수|계획|예정|협박|위협|비유|소문|풍문|농담|꿈속|꿈에서|환상|회상|과거에|예전에|지난번|출산했던|출산한\s*적이|연극|배역)|(?:임신|회임|잉태|출산|유산)[^.!?\n]{0,20}(?:한다면|하면|했으면|했다면|였다면|이었다면|라면|겠|할까|했니|인가|인가요|했나요|할지도)/u;
const MENTAL_OR_REPORTED = /(?:생각(?:했|하|한)|믿(?:었|는다|지|고)|여(?:겼|긴|기)|부정(?:했|하|한)|부인(?:했|하|한)|추측|의심|주장|오해|착각|거짓말|말했|말하|말한|들었|듣고|보도|소식|취급|일축|몰랐|모르|알지\s*못)/u;
const PREGNANT = /(?:임신|회임|잉태)(?:했|하였|함|중|한\s*(?:상태|것(?:이|으로)\s*확인)|(?:이|을)?\s*(?:확인(?:됐|되었|했)|확정(?:됐|되었)))|(?:임신|회임|잉태)\s*(?:중(?:이다|이었다|이었음|임)|\d{1,2}\s*(?:개월|주(?:차)?)(?:이다|째다|임|이었다|이었음))|태기(?:가|를)?\s*(?:있(?:다|었|음)|확인(?:했|됐|되었))/u;
const BIRTH = /(?:출산(?:했|하였|함|을\s*마쳤)|(?:아이|아기)(?:를)?\s*낳(?:았|았다)|분만(?:했|하였|을\s*마쳤|이\s*끝났))/u;
const MISCARRIAGE = /(?:유산(?:했|하였|함|이\s*(?:확인됐|확인되었|일어났|발생했))|태아(?:가)?\s*사망(?:했|함))/u;
const TERMINATION = /(?:낙태(?:했|하였|함)|임신(?:을|이)?\s*(?:중단(?:했|함|됐)|종결(?:했|함|됐)|종료(?:됐|되었|함)))/u;
const DENIAL = /(?:임신|회임|잉태)(?:하(?:지|지는)|한\s*적(?:이|은)?|한\s*상태(?:가|는)?|\s*중(?:이|은)?|이|은|는)?\s*(?:않|못했|아니|아닌|아님|없)|(?:임신|회임|잉태)(?:은|는|이|가|라는\s*말은|이라는\s*말은|\s*사실은)?\s*(?:전혀\s*|모두\s*|완전히\s*)?(?:거짓|헛소리|지어낸|허구|사실이\s*아니)|태기(?:가|는)?\s*없/u;
const CORRECTION_CONTEXT = /(?:검사\s*결과|재검(?:사)?\s*결과|진단\s*결과|진맥\s*결과|검사로|재검으로|오진|설정\s*(?:정정|수정|취소)|임신\s*설정(?:을)?\s*취소|정정한다|정정함)/u;
const CORRECTION_COMPLETED = /(?:확인(?:됐|되었|했)|판명(?:됐|되었)|밝혀졌|진단(?:됐|되었)|아니(?:었다|었음|다)|않(?:았다|았음)|없(?:었다|었음))/u;

function subjectTail(sentence: string, mention: Mention, mentions: Mention[]) {
  const following=sentence.slice(mention.end);
  // A possessor is the condition owner only when the possessed noun names their
  // own condition/body. "Y의 아이를 임신" makes Y the other parent, not the carrier.
  if(/^의\s/u.test(following)&&!/^의\s*(?:임신|회임|잉태|태기|태아|뱃속|자궁|몸|맥|배(?:가|는|에|\s))/u.test(following)) return "";
  const next = mentions.find((item) => item.start >= mention.end
    && !/^의\s*(?:아이|아기|자식|혈육)(?:를|을|\s)/u.test(sentence.slice(item.end)));
  const tail=sentence.slice(mention.end,next?.start);
  return /^(?:이가|이는|이도|이를|이의|이에게|은|는|이|가|도|의|에게)?(?:\s|[,*]|$)/u.test(tail) ? tail : "";
}
function eventOwned(tail: string, match: RegExpMatchArray) {
  const before=tail.slice(0,match.index).replace(/^(?:이가|이는|이도|이를|이의|이에게)(?=\s)/u,"")
    .replace(/[가-힣A-Za-z]{2,20}의\s*(?:아이|아기|자식|혈육)(?:를|을)?/gu," ");
  // Known subjects are cut at the next name; unknown subordinate subjects and
  // possessors are also unsafe ("X는 친구의 임신을 확인했다").
  for (const subject of before.matchAll(/(?:^|\s)([가-힣]{1,20})(?:이|가|은|는|의)(?=\s)/gu)) {
    if (/^(?:년|개월|달|일|시간|분|초|때에|후에|뒤에|마지막에)$/u.test(subject[1])) continue;
    if (/(?:했다|었다|았다|하다)$/u.test(subject[1])) continue;
    return false;
  }
  return true;
}
function ownedEvents(tail: string, pattern: RegExp) {
  return [...tail.matchAll(new RegExp(pattern.source,`${pattern.flags.replace(/g/gu,"")}g`))]
    .filter((match)=>eventOwned(tail,match));
}
function ownedEvent(tail: string, pattern: RegExp) {
  return ownedEvents(tail,pattern)[0]||null;
}
function excerpt(sentence: string, mention: Mention, at: number) {
  if(sentence.length<=250) return sentence;
  const room=235-(mention.end-mention.start);
  const start=Math.max(0,at-45);
  const end=Math.min(sentence.length,start+room);
  const pieces=mention.start>=start&&mention.end<=end ? [sentence.slice(start,end)] : [sentence.slice(mention.start,mention.end),sentence.slice(start,end)];
  return pieces.map((part)=>part.trim()).join(" … ");
}

/** Rebuild from retained raw messages, so undo removes both the event and state.
 * Pregnancy is world state; this function never grants that knowledge to an NPC.
 */
export function derivePersistentCharacterConditions(params: {
  messages: DurableStateMessage[];
  identities: DurableCharacterIdentity[];
}): PersistentCharacterConditions {
  const findMentions=makeMatcher(params.identities);
  const states=new Map<string,PersistentPregnancyState>();
  let userTurn=0;
  for(const message of params.messages) {
    const rawRole=String(message.role||"").toLowerCase();
    const role=rawRole==="model"?"assistant":rawRole;
    if(role!=="user"&&role!=="assistant") continue;
    if(role==="user") userTurn++;
    const explicitTurn=message.turnNo==null?NaN:Number(message.turnNo);
    const turnNo=Number.isFinite(explicitTurn)&&explicitTurn>=0?Math.trunc(explicitTurn):userTurn;
    for(const sentence of sourceSentences(String(message.content||""))) {
      if(UNCERTAIN.test(sentence)||MENTAL_OR_REPORTED.test(sentence)) continue;
      const mentions=findMentions(sentence);
      for(const mention of mentions) {
        const tail=subjectTail(sentence,mention,mentions);
        if(!tail) continue;
        const correction=ownedEvent(tail,DENIAL);
        const corrected=correction&&CORRECTION_CONTEXT.test(sentence)
          && (CORRECTION_COMPLETED.test(sentence)||(role==="user"&&/(?:설정|정정|취소)/u.test(sentence)));
        const events:Array<{outcome:PregnancyEvent["outcome"];status:PregnancyEvent["status"];at:number}>=[];
        if(corrected)events.push({outcome:"correction",status:"corrected_not_pregnant",at:correction.index||0});
        for(const [pattern,outcome]of [[BIRTH,"birth"],[MISCARRIAGE,"miscarriage"],[TERMINATION,"termination"],[PREGNANT,"pregnancy"]] as const) {
          if(outcome==="pregnancy"&&DENIAL.test(tail))continue;
          for(const match of ownedEvents(tail,pattern))events.push({outcome,status:outcome==="pregnancy"?"pregnant":"ended",at:match.index||0});
        }
        events.sort((a,b)=>a.at-b.at);
        for(const {outcome,status,at} of events) {
        // A conditional/negative delivery is not a completed transition.
        if(/(?:출산|분만|유산|낙태|종료|종결|중단)(?:하(?:지|지는))?\s*(?:않|못|없|아니)/u.test(tail)&&outcome!=="pregnancy") continue;
        const prior=states.get(norm(mention.name));
        if(prior?.status===status&&prior.outcome===outcome) {
          states.set(norm(mention.name),{...prior,lastConfirmedTurn:turnNo,lastConfirmedMessageId:String(message.id||"")});
          continue;
        }
        // A same-turn generated contradiction cannot undo a user correction.
        if(role==="assistant"&&prior?.sourceRole==="user"&&prior.turnNo===turnNo&&prior.status==="corrected_not_pregnant") continue;
        const event:PregnancyEvent={name:mention.name,status,outcome,sourceRole:role,sourceMessageId:String(message.id||""),turnNo,evidence:excerpt(sentence,mention,mention.end+at)};
        states.set(norm(mention.name),{...event,history:[...(prior?.history||[]),event],knowledgeScope:"world_only",lastConfirmedTurn:turnNo,lastConfirmedMessageId:String(message.id||"")});
        }
      }
    }
  }
  return {pregnancies:[...states.values()]};
}

export function buildPersistentCharacterConditionsBlock(canon: PersistentCharacterConditions) {
  if(!canon.pregnancies.length) return "";
  const lines=[
    "# [원문에 확정된 지속 상태 — 임신·출산 경과]",
    "- 이 목록은 세계관 사실이며 NPC가 알고 있다는 뜻이 아니다. 인물별 목격·진찰·전달·고백 등 실제 지식 획득 근거를 별도로 따른다. 모르는 인물에게 이 사실을 자동 공유하지 않는다.",
    "- 최근 대화나 요약에 빠졌거나 다른 인물이 부정·불신·거짓말했다고 확정된 임신이 사라지지 않는다. 대사 속 부정과 서술자의 객관적 사실 판정은 구분한다.",
    "- 출산·유산·임신 종료·검사 정정이 실제 완료되기 전까지 임신 상태를 유지한다. 계획·예정·가능성은 완료가 아니다. 종료 이후에도 과거 임신과 종료 사건의 이력을 지우지 않는다.",
  ];
  const labels:Record<PregnancyEvent["outcome"],string>={pregnancy:"임신 확정·현재 유지",birth:"출산 완료",miscarriage:"유산 완료",termination:"임신 종료 완료",correction:"검사·명시적 설정 정정으로 임신 아님"};
  for(const state of canon.pregnancies) {
    const confirmed=state.lastConfirmedTurn!==state.turnNo?`, 마지막 확인 ${state.lastConfirmedTurn}턴`:"";
    lines.push(`- ${state.name}: ${labels[state.outcome]} (${state.turnNo}턴 확정, ${state.sourceRole}${confirmed}); 근거: ${state.evidence}`);
    const initial=state.history.find((event)=>event.outcome==="pregnancy");
    if(initial&&state.status==="ended") lines.push(`  - 과거 임신은 ${initial.turnNo}턴에 확정됐으며 종료 이후에도 그 사건은 유효하다: ${initial.evidence}`);
    if(state.status==="corrected_not_pregnant") lines.push("  - 이전 임신 판정은 정정됐다. 이전 판정을 현재 임신 또는 실제 과거 임신으로 다시 확정하지 않는다.");
  }
  return lines.join("\n");
}

function outputParts(line: string) {
  const parts:string[]=[];let start=0;let quote="";
  for(let i=0;i<line.length;i++) {
    const char=line[i];
    if(quote) {if(char===quote)quote="";continue;}
    if(char==='"'||char==="“"||char==="‘") {quote=char==="“"?"”":char==="‘"?"’":char;continue;}
    if(!/[.!?。！？]/u.test(char))continue;
    let end=i+1;while(line[end]==="*")end++;
    if(end<line.length&&!/\s/u.test(line[end]))continue;
    while(end<line.length&&/\s/u.test(line[end]))end++;
    parts.push(line.slice(start,end));start=end;i=end-1;
  }
  if(start<line.length)parts.push(line.slice(start));
  return parts.length?parts:[line];
}

/** Generated narrator prose only: dialogue can be a lie, denial or ignorance.
 * Do not run this against historical messages or grant characters new knowledge.
 */
export function guardGeneratedPersistentCharacterConditions(input: {
  text: unknown;
  canon: PersistentCharacterConditions;
  identities: DurableCharacterIdentity[];
}) {
  const text=String(input.text||"");
  const pregnant=new Set(input.canon.pregnancies.filter((state)=>state.status==="pregnant").map((state)=>norm(state.name)));
  if(!text||!pregnant.size)return {text,removed:0,violations:[] as string[]};
  const findMentions=makeMatcher(input.identities);
  const violations=new Set<string>();let removed=0;let inFence=false;
  const result=text.split(/\r?\n/u).map((line)=>{
    if(/^\s*```/u.test(line)){inFence=!inFence;return line;}
    if(inFence)return line;
    let changed=false;
    const kept=outputParts(line).filter((part)=>{
      const value=narration(part);
      if(UNCERTAIN.test(value)||MENTAL_OR_REPORTED.test(value))return true;
      const mentions=findMentions(value);
      for(const mention of mentions) {
        if(!pregnant.has(norm(mention.name)))continue;
        const tail=subjectTail(value,mention,mentions);
        if(CORRECTION_CONTEXT.test(value)&&CORRECTION_COMPLETED.test(value))continue;
        if(ownedEvent(tail,DENIAL)) {
          violations.add(`pregnancy_denial:${mention.name}`);removed++;changed=true;return false;
        }
      }
      return true;
    });
    if(!changed)return line;
    let value=kept.join("").trim();
    if(value&&line.trim().startsWith("*")&&!value.startsWith("*"))value=`*${value}`;
    if(value&&line.trim().endsWith("*")&&!value.endsWith("*"))value=`${value}*`;
    return value;
  }).join("\n");
  return {text:removed?result.replace(/\n{3,}/gu,"\n\n").trim():text,removed,violations:[...violations]};
}
