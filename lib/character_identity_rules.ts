// One identity policy for generation, summaries and structured extraction.
// A name is durable; attendance and reply priority are separate scene facts.
export const CHARACTER_IDENTITY_CONTINUITY_RULES = [
  "- 이미 확인된 이름과 인물의 대응은 지속된다. 최근에 '한 처자/한 사람/그녀/세 사람'으로 표현됐거나 말을 하지 않았다는 이유로 이름 미정·새 인물로 바꾸지 않는다.",
  "- 같은 일행의 이름·역할·동행 근거가 확인되면 그 대응을 보존한다. 요약에서는 사건 참여자의 확인된 이름을 쓰고, 본문에서는 화자가 바뀌어 혼동될 때 이름을 밝힌다. 모든 문장에 이름을 반복할 필요는 없다.",
  "- 같은 호칭·별칭을 쓰는 서로 다른 사람을 합치지 않는다. 여러 후보 중 누구인지 확인되지 않는 '한 사람'에 가까운 이름을 임의 대입하지 않는다. 이름 미정 인물은 실제 미정인 경우에만 역할로 구분한다.",
  "- 인물의 이름을 안다는 사실, 현재 현장에 있다는 사실, 이번 대답의 우선 대상이라는 사실은 각각 별개다. 기억에 있는 이름을 모두 현장에 모으거나 대답을 한 사람에게 독점시키지 않는다.",
].join("\n");
