function cleanText(value: unknown, max = 1200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const OCCUPATION_RULES: Array<[label: string, pattern: RegExp]> = [
  ["소속사 경비원", /(?:소속사|연예\s*기획사).{0,24}(?:경비원|경비\s*근무|보안\s*요원)/iu],
  ["아파트 경비원", /아파트.{0,24}(?:경비원|경비\s*근무|보안\s*요원)/iu],
  ["학교 경비원", /학교.{0,24}(?:경비원|경비\s*근무|보안\s*요원)/iu],
  ["병원 경비원", /병원.{0,24}(?:경비원|경비\s*근무|보안\s*요원)/iu],
  ["보안팀장", /보안\s*팀장/iu],
  ["경호원", /(?:전담\s*)?경호원/iu],
  ["경비원", /(?:야간\s*)?(?:경비원|경비\s*근무|보안\s*요원)/iu],
  ["아이돌", /(?:아이돌|걸그룹|보이그룹|에스파|aespa|연예계\s*스타)/iu],
  ["배우", /(?:영화|드라마|뮤지컬)?\s*배우/iu],
  ["가수", /(?:솔로\s*)?(?:여가수|남가수|가수)/iu],
  ["연예인", /연예인/iu],
  ["형사", /형사/iu],
  ["경찰관", /(?:경찰관|순경|경찰\s*공무원)/iu],
  ["검사", /(?:검찰\s*)?검사/iu],
  ["변호사", /변호사/iu],
  ["의사", /(?:전문의|의사|의료진)/iu],
  ["간호사", /간호사/iu],
  ["교수", /교수/iu],
  ["교사", /(?:교사|선생님)/iu],
  ["학생", /(?:대학생|고등학생|중학생|초등학생|학생)/iu],
  ["회사 대표", /(?:회사|기업|소속사).{0,16}(?:대표|사장)|(?:대표이사|CEO)/iu],
  ["비서", /(?:전담\s*)?비서/iu],
  ["매니저", /(?:연예인\s*)?매니저/iu],
  ["기자", /기자/iu],
  ["작가", /작가/iu],
  ["요리사", /(?:셰프|요리사)/iu],
  ["회사원", /(?:회사원|직장인|사무직)/iu],
  ["자영업자", /(?:자영업자|가게\s*주인|점주)/iu],
];

function occupationCandidates(source: string) {
  return OCCUPATION_RULES.flatMap(([label, pattern], priority) => {
    const match = pattern.exec(source);
    return match
      ? [{ label, index: match.index, length: match[0].length, priority }]
      : [];
  });
}

export function inferCharacterOccupation(...values: unknown[]) {
  const source = values.map((value) => cleanText(value)).filter(Boolean).join(" ");
  if (!source) return "";
  const nearestSelfDescription = occupationCandidates(source).sort(
    (a, b) => a.index - b.index || a.priority - b.priority
  )[0];
  if (nearestSelfDescription) return nearestSelfDescription.label;
  const explicit = source.match(
    /(?:직업|직책|근무|소속)\s*[:：]\s*([가-힣A-Za-z][가-힣A-Za-z0-9·\s-]{1,24})/u
  )?.[1];
  return cleanText(explicit, 28).replace(/[,.!?;].*$/u, "");
}

export function inferPersonaOccupationFromScenario(...values: unknown[]) {
  const sources = values.map((value) => cleanText(value)).filter(Boolean);
  for (const source of sources) {
    const cues = [...source.matchAll(/(?:빙의|직업|역할|근무)/gu)];
    for (const cue of cues) {
      const cueIndex = Math.max(0, Number(cue.index || 0));
      const beforeCue = source.slice(Math.max(0, cueIndex - 100), cueIndex);
      const closest = occupationCandidates(beforeCue).sort(
        (a, b) =>
          b.index + b.length - (a.index + a.length) ||
          a.priority - b.priority
      )[0];
      if (closest) return closest.label;
    }
  }
  return "";
}

function hasBatchim(value: string) {
  const last = cleanText(value, 80).slice(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

function withAndParticle(value: string) {
  const text = cleanText(value, 40);
  return `${text}${hasBatchim(text) ? "과" : "와"}`;
}

const INCIDENT_CONTEXT_PATTERN =
  /(?:사건|사고|갈등|대치|위협|폭행|공격|납치|감금|침입|추적|도주|구조|피해|가해|범행|살해|위험|분쟁|충돌)/u;

export function contextualRelationshipLabel(params: {
  characterJob?: unknown;
  personaJob?: unknown;
  role?: unknown;
  profile?: unknown;
  relationshipNote?: unknown;
  recentMemory?: unknown;
  reason?: unknown;
  evidence?: unknown;
  lastTurnNo?: unknown;
  memoryCount?: unknown;
}) {
  const characterJob = cleanText(params.characterJob, 40);
  const personaJob = cleanText(params.personaJob, 40);
  if (characterJob && personaJob) {
    if (characterJob === personaJob) return `같은 ${characterJob} 동료`;
    return `${withAndParticle(characterJob)} ${personaJob}`;
  }

  const context = [
    params.role,
    params.profile,
    params.relationshipNote,
    params.recentMemory,
    params.reason,
    params.evidence,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
  if (INCIDENT_CONTEXT_PATTERN.test(context)) return "현재 사건으로 얽힌 당사자";
  if (characterJob) return `${withAndParticle(characterJob)} 대화를 나누며 알아가는 사이`;
  if (personaJob) return `${withAndParticle(personaJob)} 대화를 나누며 알아가는 사이`;

  const interacted =
    Math.max(0, Number(params.lastTurnNo || 0)) > 0 ||
    Math.max(0, Number(params.memoryCount || 0)) > 0;
  return interacted ? "대화를 나누며 알아가는 사이" : "이제 막 서로를 알게 된 초면";
}

const UNRESOLVED_RELATION_PATTERN =
  /(?:관계\s*(?:미정|미확인)|미확인|확인\s*불가|알\s*수\s*없음|불명|모름|unknown|중립)/iu;
const EMOTION_AS_RELATION_PATTERN =
  /^(?:공포|호감|분노|경계|친밀|냉담|적대|불쾌|혐오|불안|두려움)$/u;
const RELATION_SHAPE_PATTERN =
  /(?:과|와|사이|관계|당사자|초면|가족|친구|동료|연인|배우자|부모|자녀|형제|자매|남매|선배|후배|상사|부하|직원|고용주|비서|스승|제자|의사|환자|보호자|이웃|지인|동맹|라이벌|원수|가해자|피해자|경비원|경호원|아이돌|가수|배우|학생|교사|교수|매니저)/u;

const EMOTION_RELATION_TOKENS = [
  "공포", "호감", "분노", "경계", "친밀", "냉담", "적대", "불쾌", "혐오", "불안", "두려움",
];

export function isUnresolvedRelationship(value: unknown) {
  const text = cleanText(value, 80);
  return !text || UNRESOLVED_RELATION_PATTERN.test(text);
}

export function isInvalidRelationshipLabel(value: unknown) {
  const text = cleanText(value, 80);
  return (
    isUnresolvedRelationship(text) ||
    EMOTION_AS_RELATION_PATTERN.test(text) ||
    EMOTION_RELATION_TOKENS.some((token) => text.includes(token))
  );
}

export function isValidDescriptiveRelationship(value: unknown) {
  const text = cleanText(value, 80);
  return (
    text.length >= 2 &&
    text.length <= 60 &&
    !isInvalidRelationshipLabel(text) &&
    RELATION_SHAPE_PATTERN.test(text)
  );
}

export function isContextualSymmetricRelationship(value: unknown) {
  const text = cleanText(value, 80);
  return (
    /(?:사이|초면|당사자|동료)$/u.test(text) ||
    /^.+(?:과|와)\s+.+/u.test(text)
  );
}
