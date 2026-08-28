export type AuthorityClaimGuardResult = {
  text: string;
  removed: number;
  claimTypes: string[];
};

type ClaimDefinition = {
  id: string;
  claim: RegExp;
  evidence: RegExp;
  exactToken?: RegExp;
};

export type AuthorityClaimIdentity = {
  name: string;
  aliases?: string[];
  isPersona?: boolean;
};

const AUTHORITY_CONTEXT =
  /(?:경찰|형사|수사관|수사팀|강력팀|검사|검찰|경찰서|경위|경감|판사|재판장|재판부|법원|법정|공판|판결(?:문)?|선고|주문|공소장|기소|수사\s*기록|사건\s*기록|범죄\s*기록|혐의|죄명|전과|체포영장|수배)/u;

// A correction that merely names a hallucinated fact is not evidence for it.
const CORRECTION_OR_DENIAL =
  /(?:하지도\s*않|한\s*적(?:이|도)?\s*없|아닌데|아니라고|사실이\s*아니|근거\s*없|지어내|왜\s+.*(?:말|쓰|만들)|잘못(?:된|했|됐)|오류|헛소리|날조)/u;
const REQUEST_ONLY =
  /(?:설명(?:해|하라|하라고|해줘)|말(?:해|하라|하라고|해줘)|알려(?:줘|달라)|들려(?:줘|달라)|얘기(?:해|하라)|나열(?:해|하라)|브리핑(?:해|하라)|전부\s*(?:말|설명)|모든\s*(?:죄|범죄|혐의)|상세히|자세히)/u;
const EXCULPATORY_OR_UNCERTAIN =
  /(?:무혐의|혐의(?:가|는|도)?\s*(?:없|확인되지\s*않|입증되지\s*않)|범죄\s*기록(?:이|은)?\s*없|아직[^.!?。！？\n]{0,30}(?:확인|입증|단정)[^.!?。！？\n]{0,12}(?:되지\s*않|할\s*수\s*없))/u;

const CLAIMS: ClaimDefinition[] = [
  {
    id: "victim_count",
    claim:
      /(?:피해자|희생자)[^.!?。！？\n]{0,30}(?:두\s*자릿수|수십|수백|\d+\s*명)|(?:두\s*자릿수|수십|수백|\d+\s*명)[^.!?。！？\n]{0,30}(?:피해자|희생자)/u,
    evidence: /(?:피해자|희생자)/u,
    exactToken: /(?:두\s*자릿수|수십|수백|\d+\s*명)/gu,
  },
  {
    id: "confinement_duration",
    claim:
      /(?:감금|가둬|가두|붙잡)[^.!?。！？\n]{0,40}(?:며칠|몇\s*주|수일|수주|수개월|수년|장기간|오랫동안)|(?:며칠|몇\s*주|수일|수주|수개월|수년|장기간|오랫동안)[^.!?。！？\n]{0,40}(?:감금|가둬|가두|붙잡)/u,
    evidence: /(?:감금|가둬|가두|붙잡)/u,
    exactToken: /(?:며칠|몇\s*주|수일|수주|수개월|수년|장기간|오랫동안)/gu,
  },
  {
    id: "medical_paralysis",
    claim: /(?:하반신|전신|사지)\s*마비/u,
    evidence: /(?:하반신|전신|사지)\s*마비/u,
  },
  {
    id: "catastrophic_injury",
    claim: /(?:장기\s*파열|척추\s*골절|영구(?:적)?\s*(?:장애|손상)|불구가\s*되|평생\s*장애)/u,
    evidence: /(?:장기\s*파열|척추\s*골절|영구(?:적)?\s*(?:장애|손상)|불구가\s*되|평생\s*장애)/u,
  },
  {
    id: "habitual_marking",
    claim:
      /(?:(?:항상|매번|피해자마다|피해자들|희생자마다|희생자들|모두|대부분)[^.!?。！？\n]{0,50}(?:낙인|문신|표식)|(?:낙인|문신|표식)[^.!?。！？\n]{0,50}(?:항상|매번|피해자마다|피해자들|희생자마다|희생자들|모두|대부분))/u,
    evidence: /(?:낙인|문신|표식)/u,
    exactToken: /(?:항상|매번|피해자마다|피해자들|희생자마다|희생자들|모두|대부분)/gu,
  },
  {
    id: "serial_crime",
    claim: /(?:연쇄|상습)\s*(?:살인|성폭행|강간|범죄|폭행|납치|범)|(?:연쇄범|상습범)/u,
    evidence: /(?:연쇄|상습)\s*(?:살인|성폭행|강간|범죄|폭행|납치|범)|(?:연쇄범|상습범)/u,
  },
  {
    id: "official_charge",
    claim: /(?:혐의(?:입니다|다|로|가|는|를\s*받|라는)|죄명(?:은|이|으로)|전과(?:가|는|만)|범죄\s*기록(?:은|이|에는))/u,
    evidence: /(?:혐의(?:입니다|다|로|가|는|를\s*받|라는)|죄명(?:은|이|으로)|전과(?:가|는|만)|범죄\s*기록(?:은|이|에는))/u,
  },
  {
    id: "prior_conviction_count",
    claim: /(?:전과\s*\d+\s*범|\d+\s*범의\s*전과)/u,
    evidence: /(?:전과\s*\d+\s*범|\d+\s*범의\s*전과)/u,
    exactToken: /(?:전과\s*\d+\s*범|\d+\s*범의\s*전과)/gu,
  },
  {
    id: "homicide",
    claim: /(?:살인|살해|죽인\s*혐의|목숨을\s*빼앗)/u,
    evidence: /(?:살인|살해|죽였|죽인|목숨을\s*빼앗)/u,
  },
  {
    id: "sexual_crime",
    claim: /(?:성폭행|성폭력|강간|강제추행|유린)/u,
    evidence: /(?:성폭행|성폭력|강간|강제추행|유린)/u,
  },
  {
    id: "confinement",
    claim: /(?:감금|가둔\s*혐의|가둬\s*두)/u,
    evidence: /(?:감금|가둬|가두|가뒀|가둔)/u,
  },
  {
    id: "abduction",
    claim: /(?:납치|약취|유괴)/u,
    evidence: /(?:납치|약취|유괴|강제로\s*(?:끌고|데려))/u,
  },
  {
    id: "escape",
    claim: /(?:탈옥|탈주|교도소\s*탈출)/u,
    evidence: /(?:탈옥|탈주|교도소\s*탈출)/u,
  },
  {
    id: "hostage_or_threat",
    claim: /(?:인질|협박\s*혐의)/u,
    evidence: /(?:인질|협박|볼모)/u,
  },
  {
    id: "torture_or_assault",
    claim: /(?:고문|폭행\s*혐의|상습\s*폭행|구타)/u,
    evidence: /(?:고문|폭행|구타|때렸|때린|두들겨|걷어찼|주먹으로\s*쳤)/u,
  },
  {
    id: "arson",
    claim: /(?:방화|불을\s*질렀|불을\s*지른)/u,
    evidence: /(?:방화|불을\s*질렀|불을\s*지른)/u,
  },
  {
    id: "property_or_financial_crime",
    claim: /(?:강도|절도|횡령|사기|갈취)/u,
    evidence: /(?:강도|절도|훔쳤|훔친|횡령|사기|갈취|빼앗았|빼앗은)/u,
  },
  {
    id: "drug_or_weapon_crime",
    claim: /(?:마약|필로폰|불법\s*무기|총기\s*밀매)/u,
    evidence: /(?:마약|필로폰|불법\s*무기|총기\s*밀매)/u,
  },
  {
    id: "stalking",
    claim: /(?:스토킹|불법\s*촬영)/u,
    evidence: /(?:스토킹|미행했|미행한|불법\s*촬영|몰래\s*촬영)/u,
  },
  {
    // A private in-scene request to "commentate" and a later blog/photo
    // upload are not evidence that the crime itself was publicly broadcast
    // live. This method-of-crime detail must be user-authored explicitly.
    id: "live_public_broadcast",
    claim: /(?:생중계|실시간\s*(?:송출|방송|중계))/u,
    evidence: /(?:생중계|실시간\s*(?:송출|방송|중계))/u,
  },
  {
    // Keep still-photo/blog publication distinct from invented camera footage.
    // Otherwise an assistant-authored "video" can be promoted into an
    // indictment, witness statement, and verdict on every later turn.
    id: "crime_video_distribution",
    claim:
      /(?:(?:불법\s*)?(?:촬영|영상|동영상|카메라)[^.!?。！？\n]{0,50}(?:송출|유포|배포|공개|전송)|(?:송출|유포|배포|공개|전송)[^.!?。！？\n]{0,50}(?:불법\s*)?(?:촬영|영상|동영상))/u,
    evidence:
      /(?:(?:불법\s*)?(?:촬영|영상|동영상|카메라)[^.!?。！？\n]{0,50}(?:송출|유포|배포|공개|전송)|(?:송출|유포|배포|공개|전송)[^.!?。！？\n]{0,50}(?:불법\s*)?(?:촬영|영상|동영상))/u,
  },
];

function splitLineSentences(line: string) {
  const marked = String(line || "").replace(
    /([.!?。！？](?:["”']|\*+)?)(\s+)/gu,
    "$1\u0000$2"
  );
  return marked.split("\u0000").filter(Boolean);
}

function normalizedTokens(value: string, pattern: RegExp) {
  return [...String(value || "").matchAll(pattern)].map((match) =>
    String(match[0] || "").replace(/\s+/gu, "")
  );
}

function identityNames(identity: AuthorityClaimIdentity) {
  return [...new Set([identity.name, ...(identity.aliases || [])])]
    .map((value) => String(value || "").replace(/\s+/gu, " ").trim())
    .filter((value) => value.length >= 2);
}

function mentionsIdentity(text: string, identity: AuthorityClaimIdentity) {
  return identityNames(identity).some((name) => text.includes(name));
}

function relevantClaimIdentities(
  sentence: string,
  identities: AuthorityClaimIdentity[]
) {
  const named = identities.filter((identity) => mentionsIdentity(sentence, identity));
  if (named.length > 0) return named;
  const personas = identities.filter((identity) => identity.isPersona);
  return personas.length === 1 ? personas : [];
}

function sourceMatchesClaimIdentity(
  source: string,
  targets: AuthorityClaimIdentity[],
  identities: AuthorityClaimIdentity[]
) {
  if (targets.length === 0) return true;
  return targets.some((target) => {
    if (mentionsIdentity(source, target)) return true;
    if (!target.isPersona) return false;
    // User turns normally describe the persona implicitly. Do not borrow a fact
    // from a turn that explicitly names a different character instead.
    return !identities.some(
      (identity) => identity !== target && mentionsIdentity(source, identity)
    );
  });
}

function hasGrounding(
  definition: ClaimDefinition,
  sentence: string,
  trustedTexts: string[],
  identities: AuthorityClaimIdentity[]
) {
  const targets = relevantClaimIdentities(sentence, identities);
  const candidates = trustedTexts.filter(
    (text) =>
      !CORRECTION_OR_DENIAL.test(text) &&
      !REQUEST_ONLY.test(text) &&
      definition.evidence.test(text) &&
      sourceMatchesClaimIdentity(text, targets, identities)
  );
  if (candidates.length === 0) return false;
  if (!definition.exactToken) return true;

  const claimedTokens = normalizedTokens(sentence, definition.exactToken);
  if (claimedTokens.length === 0) return false;
  return claimedTokens.every((token) =>
    candidates.some((text) =>
      normalizedTokens(text, definition.exactToken as RegExp).includes(token)
    )
  );
}

export function isAuthorityClaimContext(value: unknown) {
  return AUTHORITY_CONTEXT.test(String(value || ""));
}

/**
 * Prevents an authority/official explanation from turning prior assistant prose
 * into new criminal history. Only user-authored, non-corrective text can ground
 * high-impact charges, counts, durations, repeated patterns, or medical outcomes.
 */
export function removeUnsupportedAuthorityClaims(input: {
  text: unknown;
  trustedUserTexts: string[];
  identities?: AuthorityClaimIdentity[];
  authorityContext?: boolean;
}): AuthorityClaimGuardResult {
  const source = String(input.text || "");
  if (!source.trim()) return { text: source, removed: 0, claimTypes: [] };

  const active = Boolean(input.authorityContext || isAuthorityClaimContext(source));
  if (!active) return { text: source, removed: 0, claimTypes: [] };

  const trustedTexts = (input.trustedUserTexts || [])
    .map((value) => String(value || ""))
    .filter((value) => value.trim());
  const identities = (input.identities || []).filter((identity) =>
    String(identity?.name || "").trim()
  );
  const removedTypes = new Set<string>();
  let removed = 0;

  const lines = source.split(/(?<=\n)/u).map((line) => {
    if (/^\s*```/u.test(line)) {
      return line;
    }
    if (!line.trim()) return line;

    return splitLineSentences(line)
      .filter((sentence) => {
        if (EXCULPATORY_OR_UNCERTAIN.test(sentence)) return true;
        const unsupported = CLAIMS.filter((definition) => definition.claim.test(sentence))
          .filter(
            (definition) =>
              !hasGrounding(definition, sentence, trustedTexts, identities)
          );
        if (unsupported.length === 0) return true;
        removed += 1;
        for (const definition of unsupported) removedTypes.add(definition.id);
        return false;
      })
      .join("");
  });

  if (removed === 0) return { text: source, removed: 0, claimTypes: [] };
  return {
    text: lines.join("").replace(/\n{3,}/gu, "\n\n"),
    removed,
    claimTypes: [...removedTypes],
  };
}
