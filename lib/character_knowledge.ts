export type RelationshipKnowledgeInput = {
  subjectName: string;
  objectName: string;
  relation: string;
  details?: string;
  storedKnownByNames?: string[];
};

const SENSITIVE_RELATIONSHIP_PATTERN =
  /(?:가해|피해|범인|진범|원흉|범죄|범행|사건|용의|혐의|의심|배후|정체|비밀|은폐|숨겨|몰래|잠입|침입|스토킹|불법|살인|살해|독살|폭행|습격|공격|테러|납치|유괴|강간|성폭|협박|사기|기만|배신|내통|스파이|위장|변장|복면|조종|공모|누명|알리바이|도청|감시)/u;

const MUTUALLY_KNOWN_RELATIONSHIP_PATTERN =
  /(?:가족|부모|아버지|어머니|아빠|엄마|딸|아들|자녀|할아버지|할머니|조부모|손녀|손자|언니|누나|오빠|형|동생|자매|형제|남매|배우자|부부|연인|친구|소꿉친구|동급생|같은\s*반|같은\s*학교|선배|후배|동료|상사|부하|고용주|직원|비서|스승|제자|의사|환자|보호자|피보호자|주인|하인|담당자|이웃|지인|동맹|라이벌|원수)/u;

function cleanName(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function parseRelationshipKnownBy(value: unknown) {
  const source = String(value || "").trim();
  if (!source) return [] as string[];
  let values: unknown[] = [];
  try {
    const parsed = JSON.parse(source);
    values = Array.isArray(parsed) ? parsed : [];
  } catch {
    values = source.split(/[\n,;|/]+/u);
  }
  return [...new Set(values.map(cleanName).filter(Boolean))].slice(0, 40);
}

export function inferRelationshipKnownByNames(input: RelationshipKnowledgeInput) {
  const explicit = [...new Set((input.storedKnownByNames || []).map(cleanName).filter(Boolean))];
  if (explicit.length) return explicit.slice(0, 40);

  const relation = String(input.relation || "").trim();
  const details = String(input.details || "").trim();
  if (
    relation &&
    !SENSITIVE_RELATIONSHIP_PATTERN.test(`${relation} ${details}`) &&
    MUTUALLY_KNOWN_RELATIONSHIP_PATTERN.test(relation)
  ) {
    return [...new Set([cleanName(input.subjectName), cleanName(input.objectName)].filter(Boolean))];
  }
  return [] as string[];
}

export function relationshipKnowledgeScope(knownByNames: string[]) {
  return knownByNames.length > 0 ? "limited" : "world_only";
}
