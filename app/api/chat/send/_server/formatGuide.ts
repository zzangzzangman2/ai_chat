// NOTE: 이 모듈은 route.ts의 "formatGuide" 문자열 조립 블록을 그대로 분리한 것이다.
// 규칙/문구는 동일해야 하므로, 가능한 한 내용 변경 없이 캐싱만 추가한다.

type FormatGuideArgs = {
  statusRequired: string; // "YES" | "NO"
  targetChars: number;
  promptMinChars: number;
  promptMaxChars: number;
  bodyMaxChars?: number;
  metaMaxChars?: number;
  // If the creator/preset suggests a specific meta fence label (e.g. ```INFO), hint it here.
  // This avoids hardcoding STATUS and lets the prompt drive the exact format.
  metaLabelHint?: string;
  metaRequired?: string;
  metaTemplateFence?: string;
};

const CACHE_MAX = 64;
const cache = new Map<string, string>();

export function buildFormatGuide(args: FormatGuideArgs): string {
  const statusRequired = String(args.statusRequired || "NO");
  const targetChars = Number(args.targetChars || 0);
  const promptMinChars = Number(args.promptMinChars || 0);
  const promptMaxChars = Number(args.promptMaxChars || 0);
  const metaLabelHint = String((args as any).metaLabelHint || "").trim();

  const metaRequired = String(args?.metaRequired || "NO");

  const bodyMaxChars =
    typeof args.bodyMaxChars === "number" && Number.isFinite(args.bodyMaxChars)
      ? Math.max(64, Math.floor(args.bodyMaxChars))
      : promptMaxChars;

  const metaMaxChars =
    typeof args.metaMaxChars === "number" && Number.isFinite(args.metaMaxChars)
      ? Math.max(64, Math.floor(args.metaMaxChars))
      : 0;

  const softCapChars = metaRequired === "YES" ? bodyMaxChars : promptMaxChars;
  const bodyTargetChars = Math.max(200, Math.min(bodyMaxChars, targetChars || bodyMaxChars));
  const bodyFloorChars =
    metaRequired === "YES"
      ? Math.max(200, Math.floor(bodyTargetChars * 0.72))
      : Math.max(200, Math.floor((targetChars || promptMinChars) * 0.9));
  const beatBasisChars = metaRequired === "YES" ? bodyFloorChars : bodyTargetChars;
  const beatCount =
    beatBasisChars >= 2400 ? 7 :
    beatBasisChars >= 1700 ? 5 :
    beatBasisChars >= 1200 ? 4 :
    3;
  const paragraphHint =
    beatBasisChars >= 2400 ? "4~6" :
    beatBasisChars >= 1700 ? "3~5" :
    beatBasisChars >= 1200 ? "3~4" :
    "2~3";
const metaTemplateFence = String(args?.metaTemplateFence || "").trim();
const metaTemplateSig = metaTemplateFence ? `${metaTemplateFence.length}:${metaTemplateFence.slice(0, 24)}` : "";
const key = `${statusRequired}|${targetChars}|${promptMinChars}|${promptMaxChars}|${bodyMaxChars}|${metaMaxChars}|${metaLabelHint}|${metaRequired}|${metaTemplateSig}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const FENCE = "```";
  const formatGuide =
[
`출력 규칙:`,
`- 제작자 상태창 요구: ${statusRequired} (YES면 2단계 메타/상태 코드블록을 1회 포함)`,
`1) 지문은 *...*, 대사는 "..." 로 감싼다. 마크다운(헤딩/목록/강조/링크/표 등)은 출력 금지 — 코드블록 밖에서는 *지문* 또는 "대사"만.`,
`1.1) 지문은 항상 NPC/장면의 3인칭 관찰 시점. "나는/내가" 등 주인공 1인칭 서술 금지. 한 답변 안에서 시점을 도중에 바꾸지 않는다.`,
`1.2) NPC 대사를 "..."(말줄임표)만으로 끝내는 회피 금지. 감정·반응·구체적 단어가 한 마디라도 들어가야 한다.`,
`1.3) 지문과 대사는 반드시 빈 줄로 분리된 별도 문단에 쓴다. 한 줄에 "대사" *지문* 또는 *지문* "대사"를 섞지 않는다. 지문 안에 **강조**나 ***강조***를 중첩하지 않는다.`,
`2) 상대(NPC) 대사는 "..." 형태로만 출력. 주인공 대사는 출력하지 않는다 — 사용자가 직접 입력하는 영역. 사용자의 최신 입력은 이미 끝난 사건이므로 직접 인용, 간접 인용, 요약, 재서술하지 않는다.`,
`3) 턴/행동 선점 금지: 사용자가 아직 입력하지 않은 주인공의 발화/생각/의도/결정/행동을 NPC가 미리 알고 말하거나 확정 서술 금지.`,
`   - "네가 ~라고 했지" 식 선제 인용/요약 금지`,
`   - 의도/생각 단정(분명/틀림없이/당연히 등) 금지`,
`   - 행동 선점(이미 ~했다) 금지`,
`   - 필요하면 NPC는 추측형으로만 말한다.`,
`3.5) 사용자 최신 입력을 "~라는 말/명령/요구"처럼 설명하거나, 그 말을 내뱉는 목소리·태도·행위를 다시 묘사하며 시작하지 않는다. 입력이 이미 끝난 직후의 NPC 반응·행동·장면 변화부터 시작한다. 입력의 오타·비속어는 의미 해석에만 반영하고 출력으로 재현하지 않는다.`,
`3.6) NPC는 주인공의 내면(감정·심리·욕구·취향·합의·표정·심박·호흡)을 단정하지 않는다. 외부 관찰 가능한 행동만 묘사 대상. 동의/거절은 사용자가 직접 표현한 것만 사실로 본다.`,
	(
	  statusRequired === "YES"
	    ? `4) (필수) 서사 본문(지문/대사)을 자연스럽게 끝낸 뒤, 2단계 메타/상태를 fenced 코드블록으로 정확히 1회 출력한다.`
	    : `4) (선택) 메타/상태/능력치/시간/장소 등은 필요할 때 fenced 코드블록으로 쓸 수 있다. 라벨은 제작 프리셋에 맞춘다.`
	),
		(
		  metaRequired === "YES" && metaLabelHint
		    ? `   라벨은 제작 프리셋이 제시한 것 그대로: ${FENCE}${metaLabelHint}`
		    : `   제작 프리셋이 메타 템플릿을 제시했다면 그 라벨/형식을 따른다. (예: ${FENCE}INFO 또는 ${FENCE}STATUS 등)`
		),
	(
	  metaRequired === "YES" && metaTemplateFence
	    ? `   (메타 템플릿 원본) 아래 블록의 라벨/줄 구성/기호를 최대한 그대로 유지해서, 답변 맨 끝에 1회 출력한다:\n${metaTemplateFence}`
	    : null
	),
`   메타/상태 fenced 코드블록은 서사 본문이 끝난 뒤 답변의 맨 마지막에 1회. 서사 중간 삽입 금지. 닫는 ${FENCE} 이후엔 어떤 텍스트도 출력하지 않는다.`,
`   - "[상태창 대화]" 같은 메타 라벨만 대사처럼 출력 금지. 상태창/시스템이 말한다면 실제 대사 문장까지 완성하고, 라벨은 메타 fenced 코드블록에만 쓴다.`,
(metaRequired === "YES"
  ? `   (최우선) 메타 fenced 코드블록은 절대 생략 금지. 공간이 부족하면 본문을 줄여서라도 메타를 완성한다.
   - 본문 + 메타 합쳐 약 ${promptMaxChars}자 이내. 본문은 약 ${bodyMaxChars}자 이내에서 완결된 문장/지문/대사로 마무리한 뒤 ${FENCE}로 메타 시작.
   - 지문은 *로, 대사는 "로 닫고 문장/조사 중간에서 끊지 않는다. 대사 안에서 [ 로 시작한 통신/방송/속말 표기는 반드시 ] 로 닫는다. 본문 끝이 종결 기호(. ! ? … " * ] )로 닫히지 않으면 짧은 완결 문장을 더 붙여 마침표로 닫고 메타 시작.
   - 메타 블록은 약 ${metaMaxChars}자 이내로 간결하게. 라벨 자유(없어도 됨). 내부 빈칸 금지(모르는 값은 "미상", 템플릿 "|" 컬럼은 끝까지 채움). 시작했으면 반드시 닫는 ${FENCE}까지.`
  : `   메타/상태 코드는 분량 목표 계산에서 제외된다.`),
`   - 이미지 출력은 한 줄에 완전한 URL만(예: !!https://example.com/x.png). 따옴표/문장부호/공백/괄호를 앞뒤에 붙이지 않는다.`,
		// (주의) 예시 fenced 블록은 모델이 그대로 복사해 '빈 상태창'을 만들 수 있어 의도적으로 넣지 않는다.
`5) 한국어로만 쓴다. 답변 안에 모델 자기참조/계획/해설/(OOC) 라인 금지. 예: "이제 ~할 차례다", "(이 답변에서는...)", "다음에는 ~를 묘사하겠다" 모두 금지.`,
`6) 이번 턴 서사 본문 분량 목표는 약 ${targetChars}자. (메타는 답변 맨 끝 별도 예산)`,
(metaRequired === "YES"
      ? `   - 본문 약 ${Math.min(bodyMaxChars, targetChars)}자 내외(권장 ${Math.max(200, Math.floor(Math.min(bodyMaxChars, targetChars) * 0.80))}~${Math.min(bodyMaxChars, targetChars)}자)로 마무리하고 즉시 메타로. 전체(본문+메타) 최소 ${promptMinChars}자, 최대 ${promptMaxChars}자.`
      : `   - 최소 ${promptMinChars}자 이상을 채워 길고 풍성하게. 짧으면 묘사/심리/배경을 대폭 보강해 분량을 늘려라.`),
`   - 너무 길어지면 ${softCapChars}자 근처에서 자연스럽게 마무리하고 메타로 넘어간다. 본문 상한을 맞추려고 문장/지문/따옴표를 중간에 끊지 않는다.`,
`6.1) 단일 호출 분량 계약: 서버는 짧은 답변을 재호출로 늘리지 않는다. 첫 답변 안에서 직접 분량을 채운다.`,
`   - 본문이 약 ${bodyFloorChars}자보다 짧은 상태에서는 종료하지 않는다. 글자수를 정확히 셀 수 없으면 최소 ${beatCount}개 장면 비트를 채운 뒤 끝낸다.`,
`   - 장면 비트는 관찰 가능한 반응, 표정/몸짓, 주변 상황 변화, NPC의 판단 변화, 다음 선택지를 압박하는 대사 중 서로 다른 요소로 구성한다.`,
`   - 목표 문단 수는 ${paragraphHint}문단이다. 한 문단짜리 요약이나 즉답만으로 끝내지 않는다.`,
`   - 메타/상태창이 필수이면 본문을 더 늘리는 것보다 완성된 fenced 메타를 우선한다. 메타를 시작했다면 항목 일부만 쓰고 닫지 말고, 짧더라도 의미 있는 전체 상태창을 완성한다.`,
`6.5) statusRequired=YES 또는 metaRequired=YES면 메타/STATUS fenced 블록을 답변 맨 끝에 반드시 1회 포함한다. 본문보다 우선이고 닫는 ${FENCE} 필수.`,
`7) 2단계 종료 구조: 1단계(본문, *지문*/"대사")로 장면 전개 → 2단계(필요할 때만 메타 fenced 1회). 2단계가 필요하면 출력 전 종료 금지. 서사 본문이 대사로 끝났다면 짧은 지문 1~2문장으로 마무리 권장(단, '*...*' 단독 자리표시자 금지).`,
`8) 장면은 사용자의 다음 입력이 필요한 지점(상대 반응/질문/긴장)에서 멈춘다. 한 답변 안에 며칠/몇 주 건너뛰기 및 자가 결말 금지. 주인공의 다음 발화/행동을 대신 쓰지 않는다.`,
`9) 매 답변의 첫 문장(지문/대사)을 직전 1~2턴과 같은 단어/구조로 시작하지 않는다. 도입 표현을 매번 다르게.`,
].join("\n");
  cache.set(key, formatGuide);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value as string | undefined;
    if (first) cache.delete(first);
  }
  return formatGuide;
}
