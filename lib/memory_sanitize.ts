/**
 * Shared sanitizer / formatter for long-memory summaries.
 *
 * Goals:
 * - Prevent URL / media-markdown pollution from entering stored summaries.
 * - Post-process generated summaries to remove headings and obvious truncations.
 *
 * NOTE: long-memory is stored in "요약.txt" style with headings (## / ###).
 * UI may choose to render headings or flatten them, but storage should preserve them.
 */
export function stripUrlsAndMediaMarkdown(input: string, opts?: { keepHeadings?: boolean }): string {
  if (!input) return "";
  let s = String(input);
  const keepHeadings = Boolean(opts?.keepHeadings);


  // Join URLs split across newlines/spaces: "https://itimg.\nkr/.."
  s = s.replace(/https?:\/\/([^\s)\]]+)\s*\n\s*([^\s)\]]+)/g, "https://$1$2");

  // Drop image markdown entirely: ![alt](url)
  s = s.replace(/!\[[^\]]*?\]\((?:https?:\/\/)?[^)]*?\)/g, "");
  // If an image line was in plain form ("!!https://..."), it may leave a lone "!" after stripping
  s = s.replace(/^\s*!\s*$/gm, "");
  // Remove stray heading fragments only when the caller does NOT want headings.
  if (!keepHeadings) {
    s = s.replace(/^\s*#{2,}.*$/gm, "");
    s = s.replace(/^\s*#+\s*$/gm, "");
  } else {
    // Even when keeping headings, drop empty/hash-only lines.
    s = s.replace(/^\s*#+\s*$/gm, "");
  }
  // Remove path-like junk that sometimes survives stripping (e.g., "캐릭터코드/AA.")
  s = s.replace(/^\s*[^\s]{1,60}\/[^\s]{1,60}\.\s*$/gm, "");
  s = s.replace(/^\s*[^\s]{1,60}\/[^\s]{1,60}\s*$/gm, "");

  // Replace link markdown [text](url) -> text
  s = s.replace(/\[([^\]]+?)\]\((?:https?:\/\/)?[^)]*?\)/g, "$1");

  // Drop bare URLs
  s = s.replace(/https?:\/\/[^\s)\]]+/g, "");
  // Remove standalone "!!" image lines used by the client (url is already removed above)
  s = s.replace(/^\s*!!\s*$/gm, "");

  // Drop common leaked media path fragments
  s = s.replace(/\bitimg\.kr\b[^\s)\]]+/g, "");
  s = s.replace(/\b[a-z0-9_\-\/]+\.(?:webp|png|jpe?g|gif)\b/gi, "");

	// Drop internal sentinels (should never be fed back into the model)
	s = s.replace(/<<<END_OF_OUTPUT>>>/g, "");

    // Drop leaked CDN path-only fragments that appear without a scheme/host (e.g. "( kr/1764/ONE/IRS/0." or "kr/125/GM/51/AA.webp)")
  //  - We remove both parenthesized and bare forms.
  s = s.replace(/\(\s*kr\/[0-9]+\/[A-Za-z0-9_\-\/\.]+\s*\)?\.?/g, "");
  s = s.replace(/\bkr\/[0-9]+\/[A-Za-z0-9_\-\/\.]+\b\.?/g, "");

// Remove leftover empty tokens like []() or []
  s = s.replace(/\[\]\([^)]*\)/g, "");
  s = s.replace(/\[\]/g, "");

  // Cleanup whitespace noise
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{4,}/g, "\n\n\n");

  return s.trim();
}

/**
 * Adds lightweight formatting cleanup:
 * - Remove empty section headings (### ...) that have no body text under them.
 * - Remove dangling sentence fragments ending with '.' or '…' when the line is clearly incomplete.
 *   (We keep this conservative to avoid changing meaning.)
 */
export function postprocessLongMemorySummary(input: string): string {
  if (!input) return "";
  // 장기기억은 "자연스러운 평문"을 저장한다.
  // 과거 KSEP 라벨([핵심 사건]/[정보/설정]/...)이 섞이면 모두 제거.
  const cleanedInput = String(input)
    .replace(/^\s*\[(?:핵심\s*사건|정보\s*\/\s*설정|감정\s*\/\s*태도|합의\s*\/\s*약속)\]\s*.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = cleanedInput.split(/\r?\n/);

  const out: string[] = [];
  let i = 0;

  // Helper: determine if a line is a heading
  const isH2 = (l: string) => /^##(\s+|$)/.test(l.trim());
  const isH3 = (l: string) => /^###(\s+|$)/.test(l.trim());
  const isAnyHeading = (l: string) => isH2(l) || isH3(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isH3(line)) {
      // Peek forward until next heading or end; if only blanks, drop this H3.
      let j = i + 1;
      let hasBody = false;
      while (j < lines.length && !isAnyHeading(lines[j])) {
        if (lines[j].trim().length > 0) {
          hasBody = true;
          break;
        }
        j++;
      }
      if (!hasBody) {
        i += 1;
        continue; // drop empty H3
      }
    }

    out.push(line);
    i += 1;
  }

  // Conservative truncation fix:
  // If a non-heading line ends with a lone fragment like "…", or ends with '.' but has no verb-like spacing,
  // we avoid aggressive rewriting; we only remove a trailing line that is extremely short and clearly broken.
  const out2: string[] = [];
  for (let k = 0; k < out.length; k++) {
    const l = out[k];
    const t = l.trim();
    if (t && !isAnyHeading(t)) {
      // Drop very short dangling fragments that end with a period/ellipsis.
      // Example: "엘키는 그의 엄청난 식사."
      if ((/[.…]$/.test(t)) && t.length <= 18) {
        // (구형 형식) 라벨 라인은 제거되므로, 여기서 별도 예외 처리는 하지 않는다.
        // If the previous line exists and is also non-heading, append as a phrase instead of keeping a broken sentence.
        const prev = out2.length ? out2[out2.length - 1] : "";
        if (prev && !isAnyHeading(prev.trim())) {
          out2[out2.length - 1] = prev.replace(/\s*$/,"") + " " + t.replace(/[.…]$/,"").trim();
          continue;
        }
        // Otherwise drop it.
        continue;
      }
    }
    out2.push(l);
  }

  // Merge standalone time-stamp lines (e.g. "건륭 49년, 칠월 초하루.") into nearby narrative
  // to avoid awkward isolated date-only paragraphs in long memory.
  const isTimestampLine = (ln: string) => {
    const t = (ln || "").trim();
    if (!t) return false;
    // Heuristic: contains '년' and a day/month marker; keep conservative to avoid altering meaning.
    if (t.length > 48) return false;
    if (!/년/.test(t)) return false;
    if (!/(월|일|초하루|초이틀|그믐)/.test(t)) return false;
    return true;
  };
  const merged: string[] = [];
  for (let k = 0; k < out2.length; k++) {
    const ln = out2[k];
    const t = (ln || "").trim();
    if (isTimestampLine(t)) {
      const prev = merged.length ? merged[merged.length - 1] : "";
      if (prev && prev.trim() && !isAnyHeading(prev.trim())) {
        merged[merged.length - 1] = prev.replace(/\s*$/, "") + " " + t;
        continue;
      }
      const next = out2[k + 1];
      if (next && next.trim() && !isAnyHeading(next.trim())) {
        out2[k + 1] = t + " " + next.trimStart();
        continue;
      }
    }
    merged.push(ln);
  }

  // Final whitespace normalization
  let s = merged.join("\n");

  // Remove leaked model self-review/reasoning from otherwise valid one-line sections.
  // If the leak begins near the start, the whole body line is untrustworthy. If it
  // appears after a real summary paragraph, keep only the story prefix.
  const metaLeakMarker =
    /Detailed\s+Character\s*&\s*Constraint\s+Check|Character\s*&\s*Constraint\s+Check|(?:^|\s)Analysis\s*:|시스템\s*지침|개발자\s*프롬프트|요구사항\s*(?:검토|확인)/i;
  s = s
    .split(/\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^#{2,4}\s+/.test(trimmed)) return line;
      const markerIndex = line.search(metaLeakMarker);
      if (markerIndex < 0) return line;
      const prefix = line.slice(0, markerIndex).trimEnd();
      if (!prefix) return "";
      if (
        markerIndex < 120 &&
        (!/[가-힣]/u.test(prefix) || prefix.length < 12 || !/[.!?…。]\s*$/.test(prefix))
      ) {
        return "";
      }
      return /[.!?…。]\s*$/.test(prefix) ? prefix : `${prefix}.`;
    })
    .join("\n");

  // 1) META_LINE_DROP: remove model/meta boilerplate accidentally captured in memory summaries.
  s = s.split(/\n/).filter((ln) => {
    const t = ln.trim();
    if (!t) return true;
    if (/^(네\s*,\s*알겠습니다\.?)/.test(t)) return false;
    if (/요약\s*작가|장기\s*기억\s*요약|제공해\s*주실\s*\[대화\]|요구사항에\s*맞춰|작성해\s*드리겠/.test(t)) return false;
    return true;
  }).join("\n");

  // 2) Keep headings in storage (## / ###). Only drop obvious junk lines.
  s = s
    .split(/\n/)
    .filter((ln) => {
      const t = ln.trim();
      if (!t) return true;
      // Drop stray parentheses-only lines or leftover CDN fragments.
      if (t === "(" || t === ")" || t === "（" || t === "）") return false;
      if (/^\(?\s*kr\/[0-9]+\/[A-Za-z0-9_\-\/\.]+\s*\)?\.?$/.test(t)) return false;
      return true;
    })
    .join("\n");

  s = s.replace(/\n{4,}/g, "\n\n\n");

  // 3) Safety: mask common sensitive identifiers before storage/UI.
  // This is intentionally conservative and focuses on high-risk patterns.
  s = maskSensitive(s);
  s = normalizeLongMemoryToneBanmal(s);

  return s.trim();
}

function normalizeLongMemoryToneBanmal(input: string): string {
  let s = String(input || "");
  if (!s) return "";

  // Keep this conservative: only rewrite common sentence-final polite endings.
  // Goal is consistency ("반말 해체"), not a full morphological conversion.
  s = s.replace(/([가-힣]+?)했습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1했다");
  s = s.replace(/([가-힣]+?)였(?:었)?습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1였다");
  s = s.replace(/([가-힣]+?)입니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1이다");

  s = s.replace(/있습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "있다");
  s = s.replace(/없습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "없다");
  s = s.replace(/됩니다(?=(?:\s*[.!?…。]|\s*$))/gm, "된다");
  s = s.replace(/합니다(?=(?:\s*[.!?…。]|\s*$))/gm, "한다");

  // Fallback for remaining '-습니다' endings.
  s = s.replace(/([가-힣]+?)습니다(?=(?:\s*[.!?…。]|\s*$))/gm, "$1다");
  return s;
}

function maskSensitive(input: string): string {
  if (!input) return "";
  let s = String(input);

  // Emails
  s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]");

  // Phone numbers (KR + generic)
  // Examples: 010-1234-5678, +82 10 1234 5678, 02-123-4567
  s = s.replace(/\b(?:\+?82\s*)?(?:0\d{1,2})[-\s]?(?:\d{3,4})[-\s]?(?:\d{4})\b/g, "[PHONE]");

  // AWS access key id
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[AWS_ACCESS_KEY_ID]");
  // AWS secret-like tokens (very rough; avoids overly broad matching)
  s = s.replace(/\b(?:aws)?secret(?:_?access)?_?key\s*[:=]\s*[^\s'"]{16,}\b/gi, "secret_access_key=[REDACTED]");

  // Generic API keys/tokens/password assignments
  s = s.replace(/\b(?:api[-_ ]?key|token|password|passwd|pwd)\s*[:=]\s*[^\s'"]{6,}\b/gi, (m) => {
    const k = m.split(/[:=]/)[0].trim();
    return `${k}=[REDACTED]`;
  });

  // Private key blocks
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_REDACTED]");

  return s;
}

/**
 * Rules prepended to summarization input to discourage empty headings / truncation.
 * (We keep it short to avoid token bloat.)
 */
export const LONG_MEMORY_SUMMARY_RULES = [
  "요약.txt 섹션 작성 규칙(중요):",
  "- 출력은 '### 제목 (a-b턴)' 헤더 1줄 + 자연스러운 요약 문단 1개(1~3문장)만.",
  "- 말투는 항상 반말(해체, '~다')로 통일. '~요/~습니다' 같은 존댓말 종결 금지.",
  "- 라벨(예: 장소/시점:, 등장인물/세력:)로 줄을 나누지 말고, 한 문단 안에서 자연스럽게 이어서 쓸 것.",
  "- 가능한 한: (1)장소/시점(확실할 때만) (2)주요 인물/세력 (3)발단→핵심 행동→결과 (4)다음 목표/미해결을 포함.",
  "- 인물/관계/설정/목표/약속/미해결/상태 변화 중 원문에서 새로 생기거나 바뀐 핵심만 포함할 것.",
  "- 없는 항목을 분량에 맞추려고 만들거나, 앞에서 이미 확정된 사실을 변화 없이 반복하지 말 것.",
  "- 순간적인 표정·눈빛·몸짓·말투·욕설·비명·울음은 관계·부상·결정·위치 등 지속 상태를 바꾸지 않으면 생략할 것.",
  "- 장기 보존할 새 사실이 적으면 목표 글자수를 억지로 채우지 말고 한 문장으로 짧게 끝낼 것.",
  "- [사용자]가 직접 확정·정정하거나 '기억해'라고 지정한 설정은 최우선 보존 사실이다. 해당 구간 요약에서 생략하지 말 것.",
  "- 확정 설정에 포함된 인물 고유명사, 별칭, 가족관계의 대상과 세대, 나이·날짜·횟수·수치는 원문 그대로 함께 보존할 것.",
  "- 관계 변화는 양쪽 고유명사(예: A와 B)를 함께 명시할 것.",
  "- 관계/호칭은 발화한 캐릭터에게만 귀속하고, 한 캐릭터의 호칭을 다른 캐릭터에게 옮기지 말 것.",
  "- 같은 '아빠/엄마/딸/아들' 호칭도 대상 인물이나 세대가 다르면 별개의 관계이며, 이름 없는 역할 인물을 다른 이름 있는 인물과 합치지 말 것.",
  "- [사용자]가 관계나 호칭을 부정·정정하면 그 최신 정정을 [어시스턴트]의 이전 서술보다 우선할 것.",
  "- 부정된 관계 단어를 긍정 관계로 뒤집어 요약하지 말 것. 부정/철회/정정 여부를 그대로 보존할 것.",
  "- 숫자 정보(나이/횟수/수치/날짜)는 원문 값을 유지할 것.",
  "- 기존 사실과 충돌하는 새 정보가 있으면 '변경됨'을 짧게 명시할 것.",
  "- 사망/사살/생존/부활/실종/귀환처럼 인물의 등장 가능성을 바꾸는 사건은 해당 인물의 고유명사와 확정 여부를 반드시 함께 보존할 것.",
  "- 사망 보도/소문/추정과 실제 사망을 구분하고, 이후 생존 확인이나 오보 정정이 있으면 더 최신 상태를 명시할 것.",
  "- 죽거나 실종된 인물을 후속 장면에서 근거 없이 살아 돌아온 것으로 요약하지 말 것.",
  "- 직접 대사 인용(\"...\") 금지. 요지만 서술.",
  "- 링크/URL/이미지 경로/코드블록/불릿/번호/표 금지.",
  "- 문장은 중간에서 끊지 말고 완결된 문장으로 마무리해.",
].join("\n");
