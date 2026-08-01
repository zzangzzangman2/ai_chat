export function formatTurns(messages: any[]) {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}
export function selectRecentByUserTurns(messages: any[], keepUserTurns: number) {
  if (keepUserTurns <= 0) return [];
  const totalUserTurns = messages.reduce((acc, m) => acc + (m.role === "user" ? 1 : 0), 0);
  const startTurn = Math.max(1, totalUserTurns - keepUserTurns + 1);

  const picked: any[] = [];
  let u = 0;
  for (const msg of messages) {
    if (msg.role === "user") u += 1;
    if (u >= startTurn) picked.push(msg);
  }
  return picked;
}

// lastN 메시지는 그대로 전달하고, 그 이전은 요약으로 대체하는 용도
export function formatStoryTurns(messages: any[], personaName: string, npcName: string) {
  return messages
    .map((m) => {
      const who = m.role === "user" ? personaName : npcName;
      // 컨텍스트에는 "이름 |"을 최대한 유지하되,
      // 첫 줄이 인물 이름으로 시작하는 서술(예: "서윤아는...")에는 접두를 붙이지 않는다.
      return ensurePrefix(m.content, who, [personaName, npcName]);
    })
    .join("\n\n");
}

export function ensurePrefix(text: string, who: string, noPrefixIfStartsWithNames?: string[]) {
  // (요구사항)
  // 지문은 이름 접두를 붙이지 않는다. ("서윤아 | *...*" 같은 출력이 UI에서 어색해짐)
  // 또한 모델이 이미 "이름 |" 형식을 썼다면 중복 접두를 붙이지 않는다.
  const raw = String(text || "");
  const lines = raw.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return raw.trim();

  const first = lines[firstIdx].trimStart();
  // 1) 첫 줄이 지문이면 접두 없음
  if (first.startsWith("*")) return raw.trim();
  // 1.5) fenced 블록은 접두를 붙이면 파싱/종료(fence close) 로직이 깨질 수 있어 그대로 둔다.
  if (first.startsWith("```") || first.startsWith("~~~")) return raw.trim();
  // 2) 이미 "이름 |" 형태면 그대로
  if (/^.+?\s*\|\s*/.test(first)) return raw.trim();
  // 3) 첫 줄이 특정 이름으로 시작하는 서술이면 접두 없음
  //    (예: "서윤아는..." 같은 서술에 "상대 |"가 붙는 문제 방지)
  const avoid = (noPrefixIfStartsWithNames || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (avoid.length) {
    for (const nm of avoid) {
      if (first.startsWith(nm) && !first.slice(nm.length).trimStart().startsWith("|")) {
        return raw.trim();
      }
    }
  }

  const prefix = `${who} | `;
  lines[firstIdx] = prefix + first;
  return lines.join("\n").trim();
}

export function stripEndMarker(text: string) {
  // No-op: keep server done text identical to streamed deltas (append-only).
  return String((text as any) ?? "");
}

export function normalizeAnyFenceOpen(text: string): string {
  const s0 = String(text || "");
  // Convert CRLF/CR to LF to simplify processing
  const s = s0.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // If a line starts with ```<label> and also has extra content, split it into two lines.
  return s.replace(/(^|\n)(\s*```[^\s`]+)\s+([^\n]+)/g, (_m, p1, fence, rest) => {
    return `${p1}${fence}\n${rest}`;
  });
}

export function repairUnclosedAnyFence(text: string): string {
  const s0 = String(text || "");
  const s = s0.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s.split("\n");

  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      open = !open;
    }
  }

  if (open) {
    // Close the fence at end (ensure newline before closing)
    const t = s.endsWith("\n") ? s : s + "\n";
    return t + "```";
  }
  return s;
}

export function wrapLooseMetaAsFence(text: string): { text: string; wrapped: boolean } {
  const s0 = String(text || "");
  const s = s0.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // If there's already any fence, don't try to wrap; just return.
  if (s.includes("```")) return { text: s, wrapped: false };

  const lines = s.split("\n");
  // Find a likely "meta header" line near the end.
  // This is conservative to avoid wrapping normal prose.
  const metaHeader = /^\s*(?:\[?(?:STATUS|INFO|SUMMARY|META|DEBUG)\]?\s*:|\[?(?:상태|요약|메모)\]?\s*:)\s*/i;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (metaHeader.test(lines[i])) startIdx = i;
  }
  if (startIdx < 0) return { text: s, wrapped: false };

  // Only wrap if the header appears in the last ~35% of the text (typical "end-of-response meta")
  const threshold = Math.floor(lines.length * 0.65);
  if (startIdx < threshold) return { text: s, wrapped: false };

  const before = lines.slice(0, startIdx).join("\n");
  const meta = lines.slice(startIdx).join("\n");

  const wrappedText = `${before}${before ? "\n" : ""}` + "```META\n" + meta + "\n```";
  return { text: wrappedText, wrapped: true };
}


// 가끔 지문 줄 앞에 `이름 | ...` 접두가 붙는 케이스 제거
// - RHS가 따옴표("/“/')로 시작하면 대사로 보고 유지
// - 그렇지 않으면 지문으로 보고 `이름 | ` 제거

// --- renderMode helpers (chat vs novel) ---
export function stripInfoBlock(text: string): string {
  const t = String(text || "");
  if (!t.trim()) return t;
  const lines = t.split(/\r?\n/);
  let cut = -1;

  // legacy: explicit INFO header
  const idxInfo = lines.findIndex((ln) => ln.trim() === "INFO");
  if (idxInfo >= 0) cut = idxInfo;

  // emoji style INFO block (📆📌💡❤️ ...)
  const idxEmoji = lines.findIndex((ln) => /^\s*[📆📌💡❤️]/.test(String(ln || "").trim()));
  if (idxEmoji >= 0) cut = cut >= 0 ? Math.min(cut, idxEmoji) : idxEmoji;

  if (cut >= 0) return lines.slice(0, cut).join("\n").trimEnd();
  return t;
}

export function stripSpeakerPrefixLine(line: string): string {
  const s = String(line || "");
  const m = s.match(/^\s*[^|]{1,40}\s*\|\s*(.+)$/);
  return m ? String(m[1] || "") : s;
}

export function ensureQuoted(text: string): string {
  let s = String(text || "").trim();
  if (!s) return '""';
  // if already quoted (straight/smart), keep
  if (s.startsWith("\"") || s.startsWith("“")) {
    if (!(s.endsWith("\"") || s.endsWith("”"))) s = s + "\"";
    return s;
  }
  return `"${s}"`;
}

export function normalizeNovelPlain(text: string): string {
  // novel 컨텍스트에서는 지문/대사 마킹(*...*, "..." 등)을 최대한 보존한다.
  // - END 마커만 제거
  // - `이름 | ...` 접두가 붙은 라인은 제거하되, RHS가 따옴표 대사면 유지
  // - fenced 메타 패널( ```ANY_LABEL ...``` )은 그대로 유지
  const t0 = stripEndMarker(String(text || ""));
  if (!t0.trim()) return t0.trim();

  const src = t0.split(/\r?\n/);
  const out: string[] = [];

  let inFence = false;
  for (const ln of src) {
    const raw = String(ln || "");

    // fence toggle (preserve fences verbatim)
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(raw.trimEnd());
      continue;
    }
    if (inFence) {
      out.push(raw.trimEnd());
      continue;
    }

    let s = stripSpeakerPrefixLine(raw);
    s = String(s || "").trimEnd();
    const trimmed = s.trimStart();

    // preserve narration marker
    if (trimmed.startsWith("*") && trimmed.endsWith("*")) {
      out.push(trimmed);
      continue;
    }

    // preserve dialogue quotes (straight/smart)
    if (/^["“]/.test(trimmed)) {
      out.push(ensureQuoted(trimmed));
      continue;
    }

    out.push(s);
  }

  let joined = out.join("\n");
  joined = joined.replace(/[ \t]+\n/g, "\n");
  joined = joined.replace(/\n{3,}/g, "\n\n");
  return joined.trim();
}

// Keep narration and dialogue as separate, unambiguous channels for line-based clients.
// Gemini occasionally emits `"dialogue" *narration*` on one line or nests markdown
// emphasis (`***sound***`) inside an outer `*narration*` block.
export function normalizeNovelChannelLayout(text: string): string {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (!source.trim()) return source.trim();

  const out: string[] = [];
  let inFence = false;

  const splitMixedLine = (line: string) => {
    const pending = [String(line || "").trimEnd()];
    const parts: string[] = [];

    while (pending.length > 0 && parts.length < 12) {
      const part = String(pending.shift() || "");
      const dialogueThenNarration = part.match(/^(\s*["“][\s\S]*["”])\s+(\*+[\s\S]+)$/);
      if (dialogueThenNarration) {
        pending.unshift(dialogueThenNarration[2]);
        pending.unshift(dialogueThenNarration[1]);
        continue;
      }

      const narrationThenDialogue = part.match(/^(\s*\*+[\s\S]*\*+)\s+(["“][\s\S]+)$/);
      if (narrationThenDialogue) {
        pending.unshift(narrationThenDialogue[2]);
        pending.unshift(narrationThenDialogue[1]);
        continue;
      }

      parts.push(part);
    }

    parts.push(...pending);
    return parts;
  };

  const normalizePart = (part: string) => {
    const trimmed = String(part || "").trim();
    if (!trimmed) return "";
    if (!trimmed.startsWith("*") || !trimmed.endsWith("*") || trimmed.length < 2) return trimmed;

    // The first/last star are the narration channel. Any additional stars inside are
    // markdown emphasis and must not become extra channel toggles in DOS/web renderers.
    const inner = trimmed.slice(1, -1).replace(/\*+/g, "").trim();
    return inner ? `*${inner}*` : "";
  };

  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line.trimEnd());
      continue;
    }
    if (inFence || !line.trim()) {
      out.push(line.trimEnd());
      continue;
    }

    const parts = splitMixedLine(line).map(normalizePart).filter(Boolean);
    out.push(parts.join("\n\n"));
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function enforceNoPreDialogueTokenLeakForMode(text: string, mode: "chat" | "novel"): string {
  if (mode === "chat") return enforceNoPreDialogueTokenLeak(text);
  const raw = String(text || "");
  if (!raw.trim()) return raw.trim();
  const lines = raw.split(/\r?\n/);

  const getDialogueContent = (line: string): string | null => {
    const s = String(line || "").trim();
    const m = s.match(/^["“]([\s\S]*?)["”]\s*$/);
    if (!m) return null;
    const inside = String(m[1] || "").trim();
    return inside ? inside : null;
  };

  const firstDialogueIdx = lines.findIndex((l) => !!getDialogueContent(l));
  if (firstDialogueIdx < 0) return raw.trim();

  const dialogueContents: string[] = [];
  for (let i = firstDialogueIdx; i < lines.length; i++) {
    const c = getDialogueContent(lines[i]);
    if (c) dialogueContents.push(c);
  }
  if (!dialogueContents.length) return raw.trim();

  const stop = new Set(
    [
      "그리고","하지만","그런데","그래서","그러나","그냥","그저","정말","진짜","일단","지금","오늘","내일","어제","너","나","우리","그","이","저","것","수","때","좀","더","잘","못","왜","뭐","뭔","뭐야","어떤","이런","그런","저런","여기","거기","저기","같이","아마","벌써","다시","계속","이제","또","너무","조금",
    ].map((s) => s.toLowerCase())
  );

  const tokensSet = new Set<string>();
  for (const t of dialogueContents) {
    const ko = t.match(/[가-힣]{2,}/g) || [];
    const en = t.match(/[A-Za-z]{3,}/g) || [];
    for (const w of [...ko, ...en]) {
      const ww = String(w || "").trim();
      if (!ww) continue;
      const key = ww.toLowerCase();
      if (stop.has(key)) continue;
      tokensSet.add(ww);
    }
  }
  const tokens = Array.from(tokensSet);
  if (!tokens.length) return raw.trim();

  const pre = lines.slice(0, firstDialogueIdx);
  const post = lines.slice(firstDialogueIdx);
  const moved: string[] = [];
  const kept: string[] = [];

  const containsAnyToken = (line: string) => {
    const s = String(line || "");
    if (!s.trim()) return false;
    if (getDialogueContent(s)) return false;
    for (const tok of tokens) {
      if (tok.length < 2) continue;
      if (s.includes(tok)) return true;
      const low = tok.toLowerCase();
      if (/[A-Za-z]/.test(tok) && s.toLowerCase().includes(low)) return true;
    }
    return false;
  };

  for (const line of pre) {
    if (containsAnyToken(line)) moved.push(line);
    else kept.push(line);
  }

  const merged = [...kept, ...post, ...moved].join("\n");
  return merged.replace(/\n{3,}/g, "\n\n").trim();
}

export function formatStoryTurnsForMode(msgs: any[], personaName: string, npcName: string, mode: "chat" | "novel"): string {
  if (mode === "chat") return formatStoryTurns(msgs, personaName, npcName);
  const parts: string[] = [];
  for (const m of msgs || []) {
    const c = String((m as any)?.content || "");
    const cleaned = normalizeNovelPlain(c);
    if (cleaned) parts.push(cleaned);
  }
  return parts.join("\n\n").trim();
}

export function isOocMetaInstruction(text: string): boolean {
  // 사이트 공통 OOC 표식: 대소문자를 구분하지 않고, 단독/대괄호/이중괄호 시작형을 모두 허용한다.
  // 일반 문장 중간의 "OOC라는 단어"까지 오탐하지 않도록 각 줄의 제어 표식 시작만 검사한다.
  return String(text || "")
    .split(/\r?\n/)
    .some((line) => /^\s*(?:\[\s*|\(\(\s*)?ooc\b(?:\s*[:：]|\s|\]|\)\)|$)/i.test(line));
}

export function hasExplicitNovelNarration(text: string): boolean {
  return /\*[^*\n]+\*/u.test(String(text || ""));
}

function splitNovelUserChannels(text: string): string {
  const source = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!source) return '""';

  const out: string[] = [];
  const pushDialogue = (value: string) => {
    const chunks = String(value || "")
      .split(/\n{2,}|\n/g)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    for (const chunk of chunks) out.push(ensureQuoted(chunk));
  };

  // 사용자는 한 입력 안에서 `*지문* 대사 *지문*`을 자연스럽게 섞어 쓴다.
  // 입력 전체의 첫/끝 문자만 검사하면 닫힌 지문 뒤의 대사까지 한 덩어리로
  // 따옴표 처리되므로, 닫힌 *...* 구간을 기준으로 채널을 분리한다.
  const narration = /\*[^*\n]+\*/gu;
  let cursor = 0;
  let matched = false;
  for (const match of source.matchAll(narration)) {
    const index = Number(match.index || 0);
    pushDialogue(source.slice(cursor, index));
    out.push(String(match[0] || "").trim());
    cursor = index + String(match[0] || "").length;
    matched = true;
  }
  pushDialogue(source.slice(cursor));

  return (matched ? out.join("\n\n") : ensureQuoted(source)).trim();
}

export function buildUserLineForMode(userText: string, personaName: string, mode: "chat" | "novel"): string {
  const rawUserText = String(userText || "").trim();
  // OOC는 캐릭터의 대사가 아니라 사이트 전역 메타 지시다.
  // 따옴표/화자 접두를 붙이지 않아 모델이 현재 서사 밖의 최신 지시로 읽게 한다.
  if (isOocMetaInstruction(rawUserText)) return rawUserText;

  if (mode === "chat") {
    // 기존 채팅모드 규칙 유지: 주인공 | "..."
    const userLineRaw = ensurePrefix(userText, personaName);
    const m = userLineRaw.match(/^(.+?)\s*\|\s*(.+)$/);
    if (!m) return userLineRaw;
    const speaker = m[1].trim();
    let content = m[2].trim();
    if (!(content.startsWith("\"") || content.startsWith("“"))) {
      content = `\"${content}\"`;
    }
    return `${speaker} | ${content}`;
  }
  // novel: 기본은 큰따옴표(대사)로 보내되, 사용자가 명시한 형식은 보존한다.
  // - 한 입력 안의 *지문* / 대사를 구간별로 분리해 그대로 전달
  // - ```ANY_LABEL ...``` 메타 패널은 그대로 전달
  // - 이미 따옴표로 감싼 대사는 유지(끝따옴표만 보정)
  const stripped = String(stripSpeakerPrefixLine(rawUserText) || "").trim();
  if (!stripped) return '""';

  // fenced meta block (any label) - preserve as-is
  if (/^```/.test(stripped)) return stripped;

  return splitNovelUserChannels(stripped);
}

export function stripNamePrefixFromNarration(line: string) {
  const s = String(line || "");
  const m = s.match(/^(.+?)\s*\|\s*(.+)$/);
  if (!m) return s;
  const rhs = String(m[2] || "").trimStart();
  if (!rhs) return rhs;
  const first = rhs[0];
  const isQuoted = first === '"' || first === "'" || first === "“" || first === "‘";
  return isQuoted ? s : rhs;
}

// 대사 포맷으로 감싸진 지문을 감지해 지문으로 되돌립니다.
// 예) 이름 | "지은이는 ..."  ->  *지은이는 ...*
export function stripDialogueWrappedNarration(raw: string): string {
  const lines = String(raw || "").split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([^|]{1,40})\s*\|\s*["“”]\s*([\s\S]*?)\s*["”]\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const inside = (m[2] || "").trim();
    // 명백한 대사 특징(물음/느낌, 인용, 직접호칭 등)이 없고 서술형 동사가 있으면 지문으로 간주
    const looksDialogue = /[?!！？]/.test(inside) || /"|“|”/.test(inside);
    const looksNarrationVerb = /(했다|있었다|없었다|이었다|였다|느꼈|생각했|바라봤|놀랐|붙잡|속삭|말했|되었|되어|흔들|굳어|달아올)/.test(inside);
    if (!looksDialogue && looksNarrationVerb) {
      out.push(`*${inside}*`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function removeEndMarker(s: string): string {
  return String(s || "")
    .replace(/\r?\n?\[END\]\s*$/i, "")
    .replace(/\[END\]\s*$/i, "")
    .replace(/\r?\n\s*\[END\]\s*\r?\n/g, "\n")
    .trimEnd();
}

// (강화) "대사가 나오기도 전에 지문에서 그 대사(단어/표현)에 반응"하는 미래침범을 최대한 억제한다.
// - 같은 답변 안에서 지문 → 대사 순서일 때,
//   지문(대사 이전 구간)에 곧이어 나올 대사 내용(단어/표현)을 먼저 쓰지 않도록
//   **대사에 등장하는 핵심 토큰이 포함된 지문 라인**을 대사 뒤로 이동한다.
// - 완벽한 의미적 차단은 아니지만, 실제로 자주 나오는 "'사장'이라는 단어에..." 류의
//   노골적인 선행 언급을 강하게 줄인다.
export function enforceNoPreDialogueTokenLeak(text: string): string {
  const raw = String(text || "");
  if (!raw.trim()) return raw.trim();

  const lines = raw.split(/\r?\n/);

  const getDialogueContent = (line: string): string | null => {
    // 이름 | "..." (큰따옴표/스마트따옴표 지원)
    const m = String(line || "").match(/^\s*[^|]{1,40}\s*\|\s*["“]([\s\S]*?)["”]\s*$/);
    if (!m) return null;
    const inside = String(m[1] || "").trim();
    return inside ? inside : null;
  };

  const firstDialogueIdx = lines.findIndex((l) => !!getDialogueContent(l));
  if (firstDialogueIdx < 0) return raw.trim();

  const dialogueContents: string[] = [];
  for (let i = firstDialogueIdx; i < lines.length; i++) {
    const c = getDialogueContent(lines[i]);
    if (c) dialogueContents.push(c);
  }
  if (!dialogueContents.length) return raw.trim();

  // 토큰 추출: 한글은 2자 이상, 영문은 3자 이상만.
  const stop = new Set(
    [
      // 아주 흔한 기능어/대명사/접속어(오탐 줄이기)
      "그리고",
      "하지만",
      "그런데",
      "그래서",
      "그러나",
      "그냥",
      "그저",
      "정말",
      "진짜",
      "일단",
      "지금",
      "오늘",
      "내일",
      "어제",
      "너",
      "나",
      "우리",
      "그",
      "이",
      "저",
      "것",
      "수",
      "때",
      "좀",
      "더",
      "잘",
      "못",
      "왜",
      "뭐",
      "뭔",
      "뭐야",
      "어떤",
      "이런",
      "그런",
      "저런",
      "여기",
      "거기",
      "저기",
      "같이",
      "아마",
      "벌써",
      "다시",
      "계속",
      "이제",
      "또",
      "너무",
      "조금",
    ].map((s) => s.toLowerCase())
  );

  const tokensSet = new Set<string>();
  for (const t of dialogueContents) {
    const ko = t.match(/[가-힣]{2,}/g) || [];
    const en = t.match(/[A-Za-z]{3,}/g) || [];
    for (const w of [...ko, ...en]) {
      const ww = String(w || "").trim();
      if (!ww) continue;
      const key = ww.toLowerCase();
      if (stop.has(key)) continue;
      tokensSet.add(ww);
    }
  }
  const tokens = Array.from(tokensSet);
  if (!tokens.length) return raw.trim();

  const pre = lines.slice(0, firstDialogueIdx);
  const post = lines.slice(firstDialogueIdx);

  const moved: string[] = [];
  const kept: string[] = [];

  const containsAnyToken = (line: string) => {
    const s = String(line || "");
    if (!s.trim()) return false;
    // 대사 라인은 건드리지 않는다.
    if (getDialogueContent(s)) return false;
    for (const tok of tokens) {
      if (tok.length < 2) continue;
      if (s.includes(tok)) return true;
      // 영문 토큰은 대소문자 흔들림이 있어 추가로 케이스 인센서티브 검사
      if (/[A-Za-z]/.test(tok) && s.toLowerCase().includes(tok.toLowerCase())) return true;
    }
    return false;
  };

  for (const line of pre) {
    if (containsAnyToken(line)) moved.push(line);
    else kept.push(line);
  }

  if (!moved.length) return raw.trim();

  // 첫 대사 줄 바로 뒤로 이동시켜 "대사 이전 지문"에서의 선행 언급을 제거한다.
  const out = [
    ...kept,
    ...(post.length ? [post[0], ...moved, ...post.slice(1)] : [...moved]),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return out;
}



// 모델 출력의 흔한 형태 오류를 최소한으로 정리한다.
// - 지문인데 "이름 | 서윤아는..." 같이 이름 접두가 붙는 케이스
// - 사용자의 최신 대사가 상대(NPC) 쪽으로 잘못 붙는 케이스
export function stripTrailingTextAfterFinalFence(text: string): string {
  const s = String(text || "");

  // We only treat trailing text after a final *meta* fence specially.
  // Meta fences we recognize: ```STATUS, ```INFO (case-insensitive).
  //
  // IMPORTANT:
  // Some models occasionally keep writing after they close the final STATUS/INFO block.
  // Deleting that tail makes the UI feel like the output got "cut off".
  // To keep "meta fence must be last" while preserving content, we MOVE the tail to BEFORE the meta fence.
  const lastClose = s.lastIndexOf("```");
  if (lastClose < 0) return s;

  const beforeClose = s.slice(0, lastClose);
  const lastOpen = beforeClose.lastIndexOf("```");
  if (lastOpen < 0) return s;

  // Determine the fence label from the opening line.
  const lineEnd = s.indexOf("\n", lastOpen + 3);
  const openLine = (lineEnd >= 0 ? s.slice(lastOpen, lineEnd) : s.slice(lastOpen)).trim();
  const label = openLine.slice(3).trim().toUpperCase();

  const isMetaFence = label.startsWith("STATUS") || label.startsWith("INFO");
  if (!isMetaFence) return s;

  const afterRaw = s.slice(lastClose + 3);
  if (afterRaw.trim().length === 0) return s;

  const head = s.slice(0, lastOpen).trimEnd();
  const fenceBlock = s.slice(lastOpen, lastClose + 3).trimEnd();
  const tail = afterRaw.trimStart();

  return (head ? head + "\n\n" : "") + tail + "\n\n" + fenceBlock;
}



export function stripStandaloneSeparatorLines(s: string): string {
  // Remove noisy standalone separator lines that sometimes appear around images or status blocks.
  // Keeps meaningful content intact.
  return s
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      // '=' or '＝'
      if (/^[=＝]+$/.test(t)) return false;
      // Long dashes/underscores
      if (/^-{3,}$/.test(t)) return false;
      if (/^_{3,}$/.test(t)) return false;
      // Em-dash like separators
      if (/^[—–‐‑‒―━]{3,}$/.test(t)) return false;
      return true;
    })
    .join("\n");
}

export function _charLen(s: string): number {
  return Array.from(String(s || "")).length;
}
export function _sliceChars(s: string, n: number): string {
  return Array.from(String(s || "")).slice(0, n).join("");
}

export function splitTrailingFenceBlockAtEnd(text: string): { body: string; meta: string } {
  const t = String(text || "").trimEnd();
  const re = /```[^\n]*\n[\s\S]*?\n```\s*$/;
  const m = t.match(re);
  if (!m) return { body: t.trim(), meta: "" };
  const meta = String(m[0] || "").trim();
  const body = t.slice(0, t.length - m[0].length).trim();
  return { body, meta };
}

export function isMetaFenceLikelyIncomplete(
  meta: string,
  opts?: { minChars?: number; minContentLines?: number }
): boolean {
  const repaired = repairUnclosedAnyFence(normalizeAnyFenceOpen(String(meta || ""))).trim();
  if (!repaired) return true;

  const m = repaired.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/);
  const body = (m ? String(m[1] || "") : repaired.replace(/^```[^\n]*(?:\n|$)/, "").replace(/\n?```\s*$/, "")).trim();
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const minChars = Math.max(80, Math.floor(Number(opts?.minChars ?? 180) || 180));
  const minContentLines = Math.max(3, Math.floor(Number(opts?.minContentLines ?? 4) || 4));

  if (lines.length <= 2) return true;
  if (_charLen(body) < minChars && lines.length < minContentLines) return true;

  // Common partial status shape: header + one or two stat rows, then a closing fence.
  const joined = lines.join("\n");
  const hasOnlyEarlyStats =
    lines.length <= 4 &&
    /체력|HP|마나|MP|상태/i.test(joined) &&
    !/위치|장소|목표|관계|소지품|시각|시간|요약|상황/i.test(joined);
  if (hasOnlyEarlyStats) return true;

  return false;
}

function splitTrailingOpenMetaFenceAtEnd(
  text: string,
  allowedLabels: readonly string[] = []
): { body: string; meta: string; labelUpper: string } | null {
  const t = String(text || "").replace(/\r\n/g, "\n").trimEnd();
  const allowAnyLabel = !allowedLabels || allowedLabels.length === 0;
  const last = t.lastIndexOf("```");
  if (last < 0) return null;

  // If there is a closed fence ending, the closed-case regex will handle it.
  // Here we only handle the "open fence at end" case (no closing ``` after the last open).
  const after = t.slice(last + 3);
  // If the tail already includes another fence marker, it's not a simple open-at-end case.
  if (after.includes("```")) return null;

  const lineEnd = t.indexOf("\n", last + 3);
  const openLine = (lineEnd >= 0 ? t.slice(last, lineEnd) : t.slice(last)).trim();
  const rawLabel = openLine.slice(3).trim().split(/\s+/)[0] ?? "";
  const labelUpper = rawLabel.toUpperCase();
  // Allow unlabeled fences (```), default to INFO.
  // If allowedLabels is empty, accept ANY label (label-agnostic mode).
  const resolvedLabelUpper = labelUpper || (allowAnyLabel ? "INFO" : allowedLabels[0] || "INFO");
  if (!allowAnyLabel && allowedLabels.length && !allowedLabels.some((al) => resolvedLabelUpper.startsWith(al))) return null;

  const body = t.slice(0, last).trimEnd();
  const meta = t.slice(last).trimEnd();
  return { body, meta, labelUpper: resolvedLabelUpper };
}


// If a trailing fenced block is too long for the output char budget, truncate its *inside*
// while keeping a valid opening/closing fence.
export function truncateFenceBlockToBudget(fenceBlock: string, budget: number): string {
  const fb = String(fenceBlock || "").trim();
  if (!fb.startsWith("```")) return fb;
  if (_charLen(fb) <= budget) return fb;

  const firstNl = fb.indexOf("\n");
  const lastFence = fb.lastIndexOf("```");
  if (firstNl < 0 || lastFence <= 0) return _sliceChars(fb, budget).trim();

  const open = fb.slice(0, firstNl + 1); // includes newline
  const close = "```";
  const inner = fb.slice(firstNl + 1, lastFence).replace(/\s+$/g, "");
  const reserve = _charLen(open) + _charLen("\n…(생략)\n") + _charLen(close);
  const availInner = Math.max(0, budget - reserve);
  const innerCut = _sliceChars(inner, availInner).trimEnd();
  return `${open}${innerCut}\n…(생략)\n${close}`.trim();
}

// Preserve a trailing fenced meta/status block within the char budget by trimming the body first.
// This prevents cases where the narrative consumes the whole budget and the status window gets dropped or cut.
export function preserveTrailingFenceBlockWithinBudget(text: string, budget: number): string {
  const t0 = String(text || "").trim();
  const { body, meta } = splitTrailingFenceBlockAtEnd(t0);
  if (!meta) return t0;

  // NOTE:
  // Previously we forced the narrative body to end with a placeholder narration line (`*...*`)
  // right before the trailing meta/status fence. That created unwanted trailing "*...*" lines
  // (especially when the scene already felt concluded).
  // Now we keep the body as-is and only trim it to fit the budget, preserving the fence block.
  let b = String(body || "").trimEnd();

  const metaLen = _charLen(meta);
  const total = _charLen(b) + 2 + metaLen;
  if (total <= budget) return `${b}

${meta}`.trim();

  const availBody = budget - metaLen - 2;
  if (availBody < 10) {
    // Body is too small to keep; prefer preserving the meta fence.
    return truncateFenceBlockToBudget(meta, Math.max(60, budget));
  }

  // Trim body to fit.
  // IMPORTANT: If we must cut, prefer a *complete* ending (sentence/quote/closing marker)
  // rather than leaving the user with a mid-word/mid-sentence fragment.
  let bt = b;
  if (_charLen(bt) > availBody) {
    const head = _sliceChars(bt, availBody).trimEnd();
    bt = trimToCompleteForBudget(head);
  }

  return `${bt}

${meta}`.trim();
}


// --- Meta fence blocks (STATUS/INFO) can be treated as "out of budget" ---
// Some UX rules require a trailing ```STATUS / ```INFO block. When we enforce a body character cap
// we still want to preserve these meta blocks even if they push total chars over the cap.
function getFenceLabelUpper(fenceBlock: string): string {
  const firstLineEnd = fenceBlock.indexOf("\n");
  const firstLine = (firstLineEnd >= 0 ? fenceBlock.slice(0, firstLineEnd) : fenceBlock).trim();
  // firstLine is like ```STATUS or ```INFO something
  return firstLine.replace(/^```/, "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
}

export function splitTrailingMetaFenceBlocksAtEnd(
  text: string,
  allowedLabels: readonly string[] = []
): { body: string; meta: string } {
  let cur = String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
  const allowAnyLabel = !allowedLabels || allowedLabels.length === 0;
  const metas: string[] = [];

  while (true) {
    const sp = splitTrailingFenceBlockAtEnd(cur);
    if (sp.meta) {
      const label = getFenceLabelUpper(sp.meta);
      if (!allowAnyLabel && allowedLabels.length && !allowedLabels.some((al) => label.startsWith(al))) break;

      metas.unshift(sp.meta.trimEnd());
      cur = sp.body.trimEnd();
      continue;
    }

    // Also accept an "open" meta fence at the very end (no closing fence yet),
    // so we can keep it outside the body budget and close it safely.
    const open = splitTrailingOpenMetaFenceAtEnd(cur, allowedLabels);
    if (!open) break;

    metas.unshift(open.meta.trimEnd());
    cur = open.body.trimEnd();
  }

  return { body: cur.trimEnd(), meta: metas.join("\n\n").trimEnd() };
}

export function preserveTrailingMetaFenceBlocksOutsideBudget(
  text: string,
  bodyBudgetChars: number,
  metaHardMaxChars: number = 2400
): string {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const bodyBudget = Math.max(0, Math.floor(bodyBudgetChars));

  const { body: body0, meta: meta0 } = splitTrailingMetaFenceBlocksAtEnd(raw);
  let body = body0;
  let meta = meta0;

  if (body.length > bodyBudget) {
    body = trimToCompleteForBudget(body.slice(0, bodyBudget));
  }

  if (meta) {
    // Safety cap for meta blocks (still keep fence shape as much as possible)
    if (meta.length > metaHardMaxChars) meta = meta.slice(0, metaHardMaxChars);
    meta = repairUnclosedAnyFence(meta).trimEnd();
  }

  if (!meta) return body.trimEnd();

  const bt = body.trimEnd();
  const joiner = bt ? "\n\n" : "";
  return `${bt}${joiner}${meta}`.trimEnd();
}





// --- One-shot finalization with meta out-of-budget ---
// Requirement: body budget applies ONLY to the story body. ```STATUS/```INFO blocks are preserved OUTSIDE budget.
// Also ensure the body ends cleanly (no mid-word cut) and close minimal markers (", *) when dangling.

function _strlen(s: string): number {
  return Array.from(String(s ?? "")).length;
}

function _normalizeStarVariants(s: string): string {
  return String(s ?? "").replace(/[＊∗﹡⁎٭✱✳✴✵✶✷✸✹✺✻✼✽✾✿❋]/g, "*");
}

function _countUnescapedChar(s: string, ch: string): number {
  const t = String(s ?? "");
  if (!ch) return 0;
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== ch) continue;
    if (i > 0 && t[i - 1] === "\\") continue;
    n += 1;
  }
  return n;
}

function _hasOddUnescaped(s: string, ch: string): boolean {
  return (_countUnescapedChar(s, ch) % 2) === 1;
}

function _endsWithGoodEndingChar(s: string): boolean {
  const t = String(s ?? "").trimEnd();
  if (!t) return true;
  if (_endsWithTrailingEllipsis(t)) return false;
  // Accept a broad set of "complete-looking" endings.
  return /([\.!\?]|[。！？]|["\*]|[\)\]\}〉》」』])\s*$/.test(t);
}

function _endsWithTrailingEllipsis(s: string): boolean {
  const t = String(s ?? "")
    .trimEnd()
    .replace(/["'”’\)\]\}\*〉》」』]+$/g, "")
    .trimEnd();
  return /(?:\.{2,}|…+|⋯+|。。。+)$/.test(t);
}

function _findLastSentenceBoundaryInTail(s: string, tailChars: number): number {
  const t = String(s ?? "");
  if (!t) return -1;
  const start = Math.max(0, t.length - Math.max(40, Math.floor(tailChars)));
  const tail = t.slice(start);
  // Prefer explicit sentence terminators or closing markers.
  const re = /([\.!\?]|[。！？]|["\*]|[\)\]\}〉》」』])(?=\s*$|\s)/g;
  let last = -1;
  for (const m of tail.matchAll(re)) {
    const idx = (m as any).index as number;
    if (typeof idx !== "number") continue;
    const end = start + idx + String(m[0]).length;
    if (_endsWithTrailingEllipsis(t.slice(0, end))) continue;
    last = end;
  }
  return last;
}

function _trimToWhitespaceBoundaryNearEnd(s: string, maxBacktrack: number): string {
  const t = String(s ?? "");
  const limit = Math.max(0, t.length - Math.max(0, maxBacktrack));
  for (let i = t.length - 1; i >= limit; i--) {
    const ch = t[i];
    if (ch === " " || ch === "\n" || ch === "\t") {
      return t.slice(0, i).trimEnd();
    }
  }
  return t.trimEnd();
}

function _looksLikeTrailingMetaFenceBlock(block: string): boolean {
  const s = String(block || "").trim();
  const m = s.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (!m) return false;
  const body = String(m[1] || "").trim();
  if (!body) return false;
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  const hay = body.replace(/\s+/g, " ");
  const statusKeywordHits = [
    /체력|HP\b/i,
    /마나|MP\b/i,
    /상태/,
    /위치|장소/,
    /소지품|인벤토리/,
    /관계도|호감도/,
    /현재\s*(시각|시간|목표|유저|사용자|신분)/,
    /목표|퀘스트|평가|소속/,
    /📍|🌐|📜|👤|⏲|🕒/,
  ].reduce((n, re) => n + (re.test(hay) ? 1 : 0), 0);

  if (statusKeywordHits >= 2) return true;
  if (/^\[[^\]]{1,80}\]$/m.test(body) && statusKeywordHits >= 1) return true;
  return false;
}

function _closeDanglingSquareBracketNearTail(s: string): { text: string; changed: boolean } {
  const raw = String(s ?? "");
  const trimmed = raw.trimEnd();
  if (!trimmed) return { text: raw, changed: false };

  const lastOpen = Math.max(trimmed.lastIndexOf("["), trimmed.lastIndexOf("［"));
  const lastClose = Math.max(trimmed.lastIndexOf("]"), trimmed.lastIndexOf("］"));
  if (lastOpen < 0 || lastOpen < lastClose) return { text: raw, changed: false };
  if (trimmed.length - lastOpen > 220) return { text: raw, changed: false };

  const lineStart = trimmed.lastIndexOf("\n", lastOpen) + 1;
  const linePrefix = trimmed.slice(lineStart, lastOpen);
  const lineTail = trimmed.slice(lastOpen);
  if (lineTail.includes("\n\n")) return { text: raw, changed: false };

  const prefixLooksLikeDialogue =
    /["'“‘]\s*$/.test(linePrefix) ||
    linePrefix.trim() === "" ||
    /[|:]\s*$/.test(linePrefix);
  if (!prefixLooksLikeDialogue) return { text: raw, changed: false };

  const trailingWhitespace = raw.slice(trimmed.length);
  const quote = trimmed.match(/(["”’])$/)?.[1] || "";
  if (quote) {
    return {
      text: `${trimmed.slice(0, -quote.length)}]${quote}${trailingWhitespace}`,
      changed: true,
    };
  }

  return { text: `${trimmed}]${trailingWhitespace}`, changed: true };
}

export function ensureCleanBodyEnd(
  input: string,
  opts?: { preferAppendOnly?: boolean; maxLen?: number }
): { body: string; didTrim: boolean; didAppend: boolean } {
  let body = String(input ?? "");
  let didTrim = false;
  let didAppend = false;

  // Normalize star variants first (to make open/close checks consistent).
  body = _normalizeStarVariants(body);

  const preferAppendOnly = Boolean(opts?.preferAppendOnly);
  const maxLen =
    typeof opts?.maxLen === "number" && Number.isFinite(opts.maxLen)
      ? Math.max(0, Math.floor(opts.maxLen))
      : null;

  if (maxLen !== null && body.length > maxLen) {
    body = body.slice(0, maxLen);
    didTrim = true;
  }

  // Trim tail to a clean boundary when we likely cut mid-sentence.
  // (Important) We do NOT add new story content here. Only trimming + minimal closing tokens are allowed.
  if (body.length > 24 && !_endsWithGoodEndingChar(body)) {
    // Prefer sentence boundary within the last ~300 chars.
    const boundary = _findLastSentenceBoundaryInTail(body, 300);
    const tailDrop = boundary >= 0 ? body.length - boundary : 999999;
    const minKeep = Math.floor(body.length * 0.7);

    if (boundary >= 0 && boundary >= minKeep && tailDrop > 0 && tailDrop <= 340) {
      body = body.slice(0, boundary).trimEnd();
      didTrim = true;
    } else if (!preferAppendOnly) {
      // Fall back: cut to whitespace boundary (avoid mid-word endings).
      const w = _trimToWhitespaceBoundaryNearEnd(body, 120);
      const drop = body.length - w.length;
      if (drop > 0 && w.length >= minKeep && drop <= 340) {
        body = w.trimEnd();
        didTrim = true;
      }
    }
  }

  // If we still end on an awkward character, make a last attempt to avoid mid-word endings.
  if (body.length > 24 && !_endsWithGoodEndingChar(body) && !preferAppendOnly) {
    const w2 = _trimToWhitespaceBoundaryNearEnd(body, 200);
    const drop2 = body.length - w2.length;
    if (drop2 > 0 && drop2 <= 340 && w2.length >= Math.floor(body.length * 0.7)) {
      body = w2.trimEnd();
      didTrim = true;
    }
  }

  const bracketClosed = _closeDanglingSquareBracketNearTail(body);
  if (bracketClosed.changed) {
    body = bracketClosed.text;
    didAppend = true;
  }

  // Close dangling markers WITHOUT adding new content.
  const quoteCount = _countUnescapedChar(body, '"');
  const needsQuoteClose = quoteCount % 2 === 1;

  const starCount = (body.match(/\*/g) || []).length;
  const needsStarClose = starCount % 2 === 1;

  // Defensive: if a code fence somehow leaked into body, ensure it is closed.
  const fenceCount = (body.match(/```/g) || []).length;
  const needsFenceClose = fenceCount % 2 === 1;

  const ensureRoom = (n: number) => {
    if (maxLen === null) return;
    const over = body.length + n - maxLen;
    if (over <= 0) return;
    const newLen = Math.max(0, maxLen - n);
    if (newLen < body.length) {
      body = body.slice(0, newLen).trimEnd();
      didTrim = true;
    }
  };

  if (needsQuoteClose) {
    ensureRoom(1);
    body = body.trimEnd() + '"';
    didAppend = true;
  }

  if (needsStarClose) {
    ensureRoom(1);
    body = body.trimEnd() + "*";
    didAppend = true;
  }

  if (needsFenceClose) {
    const close = body.endsWith("\n") ? "```" : "\n```";
    ensureRoom(close.length);
    body = body.trimEnd() + close;
    didAppend = true;
  }

  return { body: body.trimEnd(), didTrim, didAppend };
}

function _extractMetaFenceBlocksAnywhere(
  text: string,
  allowedLabels: readonly string[] = []
): { body: string; meta: string } {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const ranges: Array<{ start: number; end: number; block: string }> = [];

  // Build a dynamic label matcher (user/preset may choose arbitrary meta fence labels).
  // - Allow: INFO / STATUS / CUSTOM_LABEL (letters/numbers/_/-, incl. Korean if present in preset)
  // - We only treat fences as meta if their label is in allowedLabels.
  const normAllowed = Array.from(
    new Set((allowedLabels || []).map((x) => String(x || "").trim()).filter(Boolean).map((x) => x.toUpperCase()))
  );
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelAlt = normAllowed.length ? normAllowed.map(esc).join("|") : "STATUS|INFO";

	// Closed meta blocks
	// NOTE: Avoid template-literal escaping of backticks (Turbopack parser can choke on it).
	// Use plain string literals for the triple-backtick fence.
	const reClosed = new RegExp("```[ \t]*(" + labelAlt + ")(?=[^A-Za-z0-9_-]|$)[^\\n]*\\n[\\s\\S]*?\\n```", "gi");
  for (const m of src.matchAll(reClosed)) {
    const idx = (m as any).index as number;
    if (typeof idx !== "number") continue;
    const label = String(m[1] || "").toUpperCase();
    if (normAllowed.length && !normAllowed.includes(label)) continue;
    ranges.push({ start: idx, end: idx + String(m[0]).length, block: String(m[0]) });
  }

	// Open meta block at end (no closing fence)
	const reOpen = new RegExp("```[ \t]*(" + labelAlt + ")(?=[^A-Za-z0-9_-]|$)[^\\n]*(?:\\n|$)", "gi");
  let lastOpen: { start: number; label: string } | null = null;
  for (const m of src.matchAll(reOpen)) {
    const idx = (m as any).index as number;
    if (typeof idx !== "number") continue;
    const label = String(m[1] || "").toUpperCase();
    if (normAllowed.length && !normAllowed.includes(label)) continue;
    const inside = ranges.some((r) => idx >= r.start && idx < r.end);
    if (inside) continue;
    lastOpen = { start: idx, label };
  }
  if (lastOpen) {
    const after = src.slice(lastOpen.start);
    const openLineEnd = after.indexOf("\n");
    const searchFrom = lastOpen.start + (openLineEnd >= 0 ? openLineEnd + 1 : 3);
    const closeIdx = src.indexOf("```", searchFrom);
    if (closeIdx < 0) {
      ranges.push({ start: lastOpen.start, end: src.length, block: after });
    }
  }

  // Fallback: treat a bare opening fence ("```") at the end as meta.
  // This helps when the model prints the fence but omits the label (INFO/STATUS).
  // We only do this when no labeled meta fences were detected.
  if (ranges.length === 0) {
    const fenceCount = (src.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      const lastIdx = src.lastIndexOf("```");
      if (lastIdx >= 0) {
        const atLineStart = lastIdx === 0 || src[lastIdx - 1] === "\n";
        if (atLineStart) {
          ranges.push({ start: lastIdx, end: src.length, block: src.slice(lastIdx) });
        }
      }
    }
  }

  // Fallback: a creator may ask for a trailing status panel as a bare closed fence
  // (``` ... ```) instead of ```STATUS / ```INFO. Treat status-looking trailing
  // fences as META so body-length finalization never slices them as story text.
  if (ranges.length === 0) {
    const sp = splitTrailingFenceBlockAtEnd(src);
    if (sp.meta && _looksLikeTrailingMetaFenceBlock(sp.meta)) {
      const start = src.trimEnd().length - sp.meta.length;
      ranges.push({ start: Math.max(0, start), end: src.trimEnd().length, block: sp.meta });
    }
  }

  if (ranges.length === 0) return { body: src.trimEnd(), meta: "" };

  ranges.sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (!last || r.start > last.end) merged.push(r);
    else {
      last.end = Math.max(last.end, r.end);
      last.block = src.slice(last.start, last.end);
    }
  }

  const bodyParts: string[] = [];
  const metaParts: string[] = [];
  let cur = 0;
  for (const r of merged) {
    if (cur < r.start) bodyParts.push(src.slice(cur, r.start));
    metaParts.push(src.slice(r.start, r.end).trimEnd());
    cur = r.end;
  }
  if (cur < src.length) bodyParts.push(src.slice(cur));

  return {
    body: bodyParts.join("").trimEnd(),
    meta: metaParts.join("\n\n").trimEnd(),
  };
}

function _minimalStatusBlock(): string {
  return "```STATUS\n(상태창 정보 없음)\n```";
}


function _nowKstParts(): { month: number; day: number; hh: string; mm: string } {
  const now = new Date();
  // Convert current time to Asia/Seoul (KST) without relying on host timezone.
  const kst = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 9 * 3600000);
  const month = kst.getUTCMonth() + 1;
  const day = kst.getUTCDate();
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return { month, day, hh, mm };
}

function _extractFirstStatusContent(meta: string): string {
  const src = String(meta ?? "");
  const m = src.match(/```[ \t]*STATUS\b[^\n]*\n([\s\S]*?)\n```/i);
  if (m && typeof m[1] === "string") return String(m[1]).trim();
  // Open STATUS fence at end (no closing)
  const mo = src.match(/```[ \t]*STATUS\b[^\n]*(?:\n|$)([\s\S]*)$/i);
  if (mo && typeof mo[1] === "string") return String(mo[1]).trim();
  return "";
}

function _stripStatusBlocks(meta: string): string {
  let src = String(meta ?? "");
  // Remove closed STATUS blocks
  src = src.replace(/```[ \t]*STATUS\b[^\n]*\n[\s\S]*?\n```\s*/gi, "");
  // Remove open STATUS block at end (no closing)
  src = src.replace(/```[ \t]*STATUS\b[^\n]*(?:\n|$)[\s\S]*$/gi, "");
  return src.trimEnd();
}

function _summarizeForInfo(body: string, statusContent?: string): string {
  const prefer = String(statusContent ?? "").trim();
  let raw = prefer && !/상태창\s*정보\s*없음/.test(prefer) ? prefer : String(body ?? "");
  raw = raw.replace(/```/g, "").replace(/\s+/g, " ").trim();
  if (!raw) return "(상황 요약 없음)";
  if (raw.length > 120) raw = raw.slice(0, 120).trimEnd() + "…";
  return raw;
}

function _minimalInfoBlock(body: string, statusContent?: string): string {
  const { month, day, hh, mm } = _nowKstParts();
  const summary = _summarizeForInfo(body, statusContent);
  // Keep placeholders for fields not derivable safely at server-side.
  return [
    "```INFO",
    "",
    `[📆${month}월 ${day}일|⏲️${hh}:${mm}]`,
    "",
    "🌐장소",
    "",
    `📜: ${summary}`,
    "",
    "👤",
    "",
    "{{char}}: 감정 묘사|역할",
    "```",
  ].join("\n");
}

function _isDanglingMetaCueLine(line: string): boolean {
  const raw = String(line || "").trim();
  if (!raw || raw.length > 80) return false;

  let core = raw
    .replace(/^[\s"'“”‘’`]+/g, "")
    .replace(/[\s"'“”‘’`]+$/g, "")
    .trim();

  core = core
    .replace(/^\[+/, "")
    .replace(/\]+$/, "")
    .replace(/[:：]+$/, "")
    .trim();

  if (!core || core.length > 40) return false;

  const compact = core.replace(/\s+/g, "").toLowerCase();
  if (/^(?:status|info|meta)(?:dialogue|dialog|talk|message|panel|window|block|output)?$/.test(compact)) {
    return true;
  }

  return /^(?:상태|상태창|상태대화|상태정보|상태패널|상태출력|상태표시|상태창대화|상태창정보|상태창패널|상태창출력|상태창표시|메타|메타정보|메타패널|메타출력)$/.test(compact);
}

function _stripDanglingMetaCueTail(body: string): string {
  const src = String(body || "").replace(/\r\n/g, "\n").trimEnd();
  if (!src) return src;

  const lines = src.split("\n");
  let changed = false;

  while (lines.length > 0) {
    const last = String(lines[lines.length - 1] || "").trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (!_isDanglingMetaCueLine(last)) break;
    lines.pop();
    changed = true;
  }

  return changed ? lines.join("\n").trimEnd() : src;
}

export type LocalMetaFallbackContext = {
  /** The contents inside the first [...] line (without brackets), e.g. 05월 12일|14:30 */
  bracketLine?: string;
  /** A full line starting with 🌐 (place/location). */
  placeLine?: string;
  /** Short summary for the 📜 line (no newlines). */
  summaryLine?: string;
  /** Optional: character name to substitute for {{char}} / {char}. */
  charName?: string;
  /** Optional: user/persona name to substitute for {{user}} / {user}. */
  userName?: string;
};

function _sanitizeFenceLabel(labelHint?: string): string {
  const raw = String(labelHint || "INFO").trim().toUpperCase();
  const safe = raw.replace(/[^A-Z0-9_-]/g, "");
  return safe || "INFO";
}

function _firstFenceBlockOrEmpty(text?: string): string {
  const s = String(text || "");
  const m = s.match(/```[A-Za-z0-9_-]{1,32}[\s\S]*?```/);
  return m ? m[0] : "";
}

function _stripHeadingsInsideFence(fence: string): string {
  const lines = String(fence || "").split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

function _clampMetaFenceToBudget(fence: string, maxLines: number, maxChars: number): string {
  let s = repairUnclosedAnyFence(normalizeAnyFenceOpen(String(fence || "")));
  s = _stripHeadingsInsideFence(s);

  // Clamp line count first (keep closing fence).
  const lines = s.split(/\r?\n/);
  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.max(2, maxLines - 1));
    // ensure we end with a closing fence line
    if (!/```\s*$/.test(head[head.length - 1] || "")) head.push("```");
    s = head.join("\n");
  }

  // Clamp chars (keep closing fence).
  if (_charLen(s) > maxChars) {
    const close = "\n```";
    const budget = Math.max(0, maxChars - _charLen(close));
    const sliced = _sliceChars(s, budget);
    s = repairUnclosedAnyFence(sliced + close);
  }

  return s.trimEnd();
}

/**
 * Local (no extra LLM call) fallback meta fence builder.
 * - Uses templateHint if provided; otherwise emits a minimal block.
 * - Patches the first [..] / 🌐.. / 📜.. lines if context is supplied.
 * - Hard clamps to maxLines/maxChars and guarantees a closed fence.
 */
export function buildLocalFallbackMetaFence(args: {
  labelHint?: string;
  templateHint?: string;
  context?: LocalMetaFallbackContext;
  maxChars?: number;
  maxLines?: number;
}): string {
  const label = _sanitizeFenceLabel(args.labelHint);
  const maxChars = Number.isFinite(args.maxChars) ? Math.max(48, Math.floor(args.maxChars as number)) : 260;
  const maxLines = Number.isFinite(args.maxLines) ? Math.max(6, Math.floor(args.maxLines as number)) : 16;
  const ctx = args.context || {};

  // Pick a base fence.
  let base = _firstFenceBlockOrEmpty(args.templateHint);
  if (!base) {
    // Minimal block with a few high-signal fields.
    const bracket = (ctx.bracketLine || "📆미상|⏲️미상").trim();
    const place = (ctx.placeLine || "🌐장소: 미상").trim();
    let summary = (ctx.summaryLine || "").replace(/\s+/g, " ").trim();
    if (summary.length > 90) summary = summary.slice(0, 89) + "…";
    const sumLine = summary ? `📜:상황 요약: ${summary}` : "📜:상황 요약";
    base = `\`\`\`${label}\n\n[${bracket}]\n\n${place}\n\n${sumLine}\n\n\`\`\``;
  } else {
    // Ensure label matches hint if possible.
    base = normalizeAnyFenceOpen(base);
    base = base.replace(/^```\s*[A-Za-z0-9_-]{1,32}/, "```" + label);
  }

  // Patch bracket/place/summary lines (best-effort, keep structure).
  let s = base;
  if (ctx.bracketLine && /\[[^\]]+\]/.test(s)) {
    s = s.replace(/\[[^\]]+\]/, `[${ctx.bracketLine.trim()}]`);
  }
  if (ctx.placeLine) {
    const place = ctx.placeLine.trim().startsWith("🌐") ? ctx.placeLine.trim() : "🌐" + ctx.placeLine.trim();
    if (/^\s*🌐.*$/m.test(s)) s = s.replace(/^\s*🌐.*$/m, place);
    else s = s.replace(/\n\n/, `\n\n${place}\n\n`);
  }
  if (ctx.summaryLine) {
    let summary = ctx.summaryLine.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (summary.length > 90) summary = summary.slice(0, 89) + "…";
    const sumLine = summary ? `📜:상황 요약: ${summary}` : "📜:상황 요약";
    if (/^\s*📜.*$/m.test(s)) s = s.replace(/^\s*📜.*$/m, sumLine);
    else s = s.replace(/\n\n(👤|#|```)/, `\n\n${sumLine}\n\n$1`);
  }

  // Substitute common placeholders inside the fence template (best-effort).
  // - {{char}} / {char} -> ctx.charName
  // - {{user}} / {user} -> ctx.userName
  const _cn = String(ctx.charName || "").trim();
  const _un = String(ctx.userName || "").trim();
  if (_cn) s = s.replace(/\{\{\s*char\s*\}\}|\{\s*char\s*\}/gi, _cn);
  if (_un) s = s.replace(/\{\{\s*user\s*\}\}|\{\s*user\s*\}/gi, _un);


  return _clampMetaFenceToBudget(s, maxLines, maxChars);
}

function compactMetaFence(meta: string, maxLines = 26, softMaxChars = 900): string {
  const s = String(meta || "").trimEnd();
  if (!s) return "";
  const hasHeading = /\n\s*#{1,6}\s/.test(s);
  if (!hasHeading && s.length <= softMaxChars) return s;

  const m = s.match(/^```[ \t]*([^\s`]{1,32})[^\n]*\n([\s\S]*?)\n```/);
  if (!m) return s;

  const label = String(m[1] || "INFO").trim() || "INFO";
  const body = String(m[2] || "");
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*#{1,6}\s/.test(line)) break;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  const compactBody = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return (`\`\`\`${label}\n${compactBody}\n\`\`\``).trimEnd();
}

export function finalizeOneShotOutputWithMeta(
  text: string,
  bodyBudgetChars: number,
  opts?: {
    statusRequired?: boolean;
    preferAppendOnly?: boolean;
    allowedLabels?: readonly string[];
    metaHardMaxChars?: number;
    // Compatibility: some call sites pass these optional knobs inside opts.
    // - bodyBudgetChars duplicates the 2nd argument.
    // - metaSoftMaxChars is a "soft" cap used during compaction before a hard clip.
    bodyBudgetChars?: number;
    metaSoftMaxChars?: number;
  }
): {
  text: string;
  body: string;
  meta: string;
  bodyChars: number;
  metaChars: number;
  totalChars: number;
  injectedStatus: boolean;
} {
  const allowed = (opts?.allowedLabels ?? ["STATUS", "INFO"]) as readonly string[];
  // Allow small meta budgets (e.g. +300 chars tail reserve) so the model can always print the opening fence.
  const metaHardMax = Math.max(80, Math.floor(opts?.metaHardMaxChars ?? 2400));
  const metaSoftMax = Math.max(
    80,
    Math.floor(typeof opts?.metaSoftMaxChars === "number" ? opts.metaSoftMaxChars : metaHardMax)
  );
  const bodyBudget = Math.max(
    0,
    Math.floor(typeof opts?.bodyBudgetChars === "number" ? opts.bodyBudgetChars : bodyBudgetChars)
  );

  // Normalize and repair fences first (avoid open-fence UI breakage).
  let t = stripEndMarker(String(text ?? "")).replace(/\r\n/g, "\n");
  t = normalizeAnyFenceOpen(t);
  // wrapLooseMetaAsFence returns { text, wrapped }.
  {
    const w = wrapLooseMetaAsFence(t) as unknown as
      | string
      | {
          text?: string;
        };
    t = typeof w === "string" ? w : (w?.text ?? t);
  }
  t = repairUnclosedAnyFence(t).trimEnd();

  const ex = _extractMetaFenceBlocksAnywhere(t, allowed);
  let body = ex.body;
  let meta = ex.meta;
  if (meta) body = _stripDanglingMetaCueTail(body);

  // Apply BODY budget ONLY.
  if (body.length > bodyBudget) {
    body = body.slice(0, bodyBudget);
    body = ensureCleanBodyEnd(body, { preferAppendOnly: false, maxLen: bodyBudget }).body;
  } else {
    body = ensureCleanBodyEnd(body, { preferAppendOnly: !!opts?.preferAppendOnly, maxLen: bodyBudget }).body;
  }
  if (meta) body = _stripDanglingMetaCueTail(body);

  // Preserve/repair META outside budget.
  let injectedStatus = false;
  if (meta) {
    meta = compactMetaFence(meta, 26, metaSoftMax);
    if (meta.length > metaHardMax) {
      // Hard-cutting meta mid-line causes "open fence looks broken" UX (e.g., list item is cut as "[공포의 지배").
      // Prefer trimming to a natural boundary, then repair the fence shape.
      meta = trimToCompleteForBudget(meta.slice(0, metaHardMax));
    }
    meta = repairUnclosedAnyFence(meta).trimEnd();
  }

  // IMPORTANT:
  // - We do NOT inject meta blocks server-side.
  //   The creator/preset prompt must decide whether to include a status/info block.
  // - Server-side we only:
  //   (1) keep meta fences outside body budget, and
  //   (2) repair unclosed fences to prevent UI breakage.

  meta = meta ? repairUnclosedAnyFence(meta).trimEnd() : "";

  const bt = String(body ?? "").trimEnd();
  const mt = String(meta ?? "").trimEnd();
  const joiner = bt && mt ? "\n\n" : "";
  const out = `${bt}${joiner}${mt}`.trimEnd();

  const bodyChars = _strlen(bt);
  const metaChars = _strlen(mt);
  const totalChars = bodyChars + metaChars;

  return { text: out, body: bt, meta: mt, bodyChars, metaChars, totalChars, injectedStatus };
}

export function endsWithCompleteFence(text: string): boolean {
  const s = String(text || "").trimEnd();
  if (!s.endsWith("```")) return false;
  // Find the last two fences
  const last = s.lastIndexOf("```");
  const prev = s.lastIndexOf("```", last - 1);
  return prev >= 0;
}

export function findLastStatusFenceCloseEnd(text: string): number {
  const s = String(text || "");
  const re = /(^|\n)\s*```\s*STATUS\b/gi;
  let m: RegExpExecArray | null = null;
  let lastIdx = -1;
  while ((m = re.exec(s))) {
    // m.index points at start of match; find the first backticks in this match
    const mi = m.index;
    const bt = s.indexOf("```", mi);
    if (bt >= 0) lastIdx = bt;
  }
  if (lastIdx < 0) return -1;
  const closeIdx = s.indexOf("```", lastIdx + 3);
  if (closeIdx < 0) return -1;
  return closeIdx + 3;
}

export function normalizeNovelOutput(text: string, personaName: string, npcName: string, latestUserLine?: string) {
  const raw = String(text || "");
  const norm = (s: string) =>
    String(s || "")
      .replace(/[\s\u200b\u200c\u200d]+/g, "")
      .replace(/["'“”‘’\.,!?！？。…]/g, "")
      .trim();
  const latestNorm = latestUserLine ? norm(latestUserLine.replace(new RegExp(`^${personaName}\s*\|\s*`), "")) : "";

  const out: string[] = [];
  for (const line0 of raw.split("\n")) {
    // (1) 지문 앞에 이름 접두가 붙는 경우 제거
    const line = stripNamePrefixFromNarration(line0);
    const m = line.match(/^(.+?)\s*\|\s*(.+)$/);
    if (!m) {
      out.push(line);
      continue;
    }
	    let speaker = String(m[1] || "").trim();
    const rhs = String(m[2] || "").trim();

	    // 모델이 습관적으로 주인공 화자를 "주인공"으로 고정해서 출력하는 경우가 있어,
	    // 실제 설정된 페르소나명이 있으면 강제로 교정한다.
	    if (speaker === "주인공" && personaName && personaName !== "주인공") {
	      speaker = personaName;
	    }

    // 0) (요구사항)
    // 지문(서술) 앞에 "이름 |"가 붙는 형태를 제거한다.
    // - 대사는 반드시 큰따옴표로 감싸야 하므로(규칙), 따옴표가 없으면 지문으로 간주한다.
    // - 예: "서윤아 | 사무실의 공기는..." -> "*사무실의 공기는...*"
    const looksLikeDialogue = rhs.startsWith("\"") || rhs.startsWith("“");
    if (!looksLikeDialogue && !rhs.startsWith("*")) {
      out.push(`*${rhs}*`);
      continue;
    }

    // 1) 지문인데 "이름 | 서윤아는..." 형태로 온 경우: 접두를 제거하고 *...*로 감싼다.
    const looksLikeNarration =
      rhs.startsWith(personaName + "는") ||
      rhs.startsWith(personaName + "은") ||
      rhs.startsWith(personaName + "이") ||
      rhs.startsWith(personaName + "가") ||
      rhs.startsWith(npcName + "는") ||
      rhs.startsWith(npcName + "은") ||
      rhs.startsWith(npcName + "이") ||
      rhs.startsWith(npcName + "가");
    // 1) 지문인데 "이름 | 서윤아는..." 형태로 온 경우: 접두를 제거하고 *...*로 감싼다.
    if (looksLikeNarration && !rhs.startsWith("*") && !looksLikeDialogue) {
      out.push(`*${rhs}*`);
      continue;
    }

    // NOTE: 0)에서 이미 "따옴표 없는 speaker|"는 지문으로 정리되므로,
    // 여기서는 추가 휴리스틱이 필요 없다.

    // 2) 최신 유저 대사가 NPC에 붙는 경우: speaker를 주인공으로 교정
	    if (latestNorm && speaker === npcName && norm(rhs) === latestNorm) {
      out.push(`${personaName} | ${rhs}`);
      continue;
    }

    out.push(line);
  }
  return stripTrailingTextAfterFinalFence(out.join("\n").trim());
}

export function estTokens(text: string) {
  // 아주 러프한 추정(실제 토큰과 다를 수 있음)
  const t = String(text || "").trim();
  if (!t) return 0;
  return Math.ceil(t.length / 4);
}

// 가능한 한 '완결된 문장'에서 잘라 UI에 미완성 문장이 노출되지 않도록 한다.
export function trimToComplete(text: string) {
  const t = String(text || "").trim();
  if (!t) return t;

  // 마지막 종결 후보(. ! ? " ' ) ]) 중 가장 뒤를 기준으로 자른다.
  // 주의: '*'는 지문(*...*)에서 매우 자주 등장하므로 종결 후보에서 제외한다.
  // 또한 "너무 앞에서" 자르면 정상 문단까지 잘려서 오히려 답변이 극단적으로 짧아질 수 있으므로,
  // cut 지점 이후 남는 길이가 충분히 크면(=앞에서 잘리는 케이스) 아예 자르지 않는다.
  // 문자열 리터럴 안에서 따옴표는 반드시 이스케이프한다.
  const candidates = [".", "!", "?", "\"", "'", ")", "]"];
  let cut = -1;
  for (const c of candidates) {
    const idx = t.lastIndexOf(c);
    if (idx > cut) cut = idx;
  }
  if (cut <= 0) return t;

  // cut 이후에 남는 텍스트가 너무 많으면(앞부분만 남기게 되면) 자르지 않는다.
  const tailLen = t.length - (cut + 1);
  if (tailLen >= 120) return t;

  return t.slice(0, cut + 1).trim();
}

// (Budget safety) When we already truncated by a hard character limit,
// it's better UX to cut *earlier* on a natural boundary than to leave
// a dangling half-sentence at the end.
//
// NOTE: This is intentionally stricter than trimToComplete(): we do NOT
// keep a long unfinished tail.
export function trimToCompleteForBudget(text: string) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  let t = raw.trimEnd();
  if (!t) return t;

  // If it already ends cleanly, keep as-is.
  // NOTE: 소설 출력 규칙에서 지문은 *...*로 감싸는 경우가 있어, '*'도 "완결"로 간주합니다.
  if (!_endsWithTrailingEllipsis(t) && /[\.!\?\"'\)\]\*。！？]$/.test(t)) return t.trim();

  // Prefer cutting near the end (avoid collapsing to a very early punctuation).
  const minKeep = Math.max(120, Math.floor(t.length * 0.65));
  const lookback = Math.min(700, t.length);
  const start = Math.max(0, t.length - lookback);
  const seg = t.slice(start);

  // 1) Paragraph break
  let cut = -1;
  const para = seg.lastIndexOf("\n\n");
  if (para >= 0) cut = Math.max(cut, start + para + 2);

  // 2) Sentence endings (incl. JP punctuation used sometimes)
  {
    const re = /[\.!\?。！？]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg))) {
      const nextCut = start + m.index + 1;
      if (_endsWithTrailingEllipsis(t.slice(0, nextCut))) continue;
      cut = Math.max(cut, nextCut);
    }
  }

  // 3) Line break (fallback)
  const nl = seg.lastIndexOf("\n");
  if (nl >= 0) cut = Math.max(cut, start + nl + 1);

  // If our best cut is too early, try a softer fallback: last whitespace,
  // then append an ellipsis to avoid mid-word endings.
  if (cut < minKeep) {
    const ws = seg.lastIndexOf(" ");
    if (ws >= 0) {
      const idx = start + ws;
      if (idx >= minKeep) {
        return t.slice(0, idx).trim();
      }
    }
    // Absolute fallback: keep minKeep chars and add ellipsis.
    return t.slice(0, minKeep).trim();
  }

  t = t.slice(0, cut).trimEnd();
  // Ensure a clean final char.
  if (_endsWithTrailingEllipsis(t)) {
    t = t.replace(/(?:\.{2,}|…+|⋯+|。。。+)\s*$/g, "").trimEnd();
  }
  return t.trim();
}


// --- Prompt/Output sanitizers (Option A: novel-only) ---
// Avoid feeding markdown-y scaffolding into the model; it tends to leak into output during streaming.
export function sanitizePromptForModel(text: string): string {
  const s = String(text ?? "");
  if (!s) return s;

  const lines = s.split(/\r?\n/);
  const out: string[] = [];

  // (Fix) Creator prompts sometimes contain an "open fence" meant as a template placeholder
  // (e.g. ```INFO ... then later "# 배경" continues) without a closing ``` line.
  // If left as-is, everything after the fence is treated as code-fence text and can distort instruction following.
  // We auto-close ONLY when the fence looks like a status/meta template and a new section heading begins.
  const CODE_LABELS = new Set(
    [
      "JS",
      "TS",
      "TYPESCRIPT",
      "JAVASCRIPT",
      "JSON",
      "PY",
      "PYTHON",
      "BASH",
      "SH",
      "SHELL",
      "HTML",
      "CSS",
      "SQL",
      "YAML",
      "XML",
      "C",
      "CPP",
      "C++",
      "JAVA",
      "GO",
      "RUST",
      "PHP",
      "RUBY",
      "KOTLIN",
      "SWIFT",
      "DART",
      "C#",
      "CSHARP",
      "TEXT",
      "MD",
      "MARKDOWN",
    ].map((x) => String(x).toUpperCase())
  );

  let inFence = false;
  let fenceLikelyMeta = false;
  let metaSignals = 0;
  let metaScan = 0;

  const isHeadingLine = (ln: string) => /^\s{0,3}#{1,6}\s+/.test(ln);

  const isMetaLabel = (labelUpper: string) => {
    const u = String(labelUpper || "").toUpperCase().trim();
    if (!u) return false;
    return /^(INFO|STATUS|META|STATE|PANEL)$/.test(u);
  };

  for (let rawLine of lines) {
    const line0 = String(rawLine ?? "");

    // If we're inside a likely status/meta template fence and a new markdown heading starts,
    // close the fence BEFORE the heading to avoid swallowing the rest of the prompt.
    if (inFence && fenceLikelyMeta && isHeadingLine(line0)) {
      out.push("```");
      inFence = false;
      fenceLikelyMeta = false;
      metaSignals = 0;
      metaScan = 0;
    }

    const fm = line0.match(/^\s*```\s*([^\s`]{0,32})/);
    if (fm) {
      const labelRaw = String(fm[1] || "").trim();
      const labelUpper = labelRaw.toUpperCase();

      if (!inFence) {
        inFence = true;
        metaSignals = 0;
        metaScan = 0;

        // Decide if this fence is likely a status/meta template (not a normal code snippet).
        fenceLikelyMeta =
          isMetaLabel(labelUpper) ||
          (!labelUpper || !CODE_LABELS.has(labelUpper)) ||
          /상태\s*창|status\s*panel/i.test(s);
      } else {
        inFence = false;
        fenceLikelyMeta = false;
        metaSignals = 0;
        metaScan = 0;
      }
    } else if (inFence && fenceLikelyMeta && metaScan < 24) {
      metaScan++;
      if (/[📆🌐📜⏲️]/.test(line0) || /상황\s*요약|장소|시간|\{\{char\}\}|\{\{user\}\}/i.test(line0)) {
        metaSignals++;
      }
      // If we didn't see any meta signals after a few lines, don't treat it as meta.
      if (metaScan >= 8 && metaSignals === 0) {
        fenceLikelyMeta = false;
      }
    }

    let line = line0;

    // Strip leading markdown heading/bullet/quote markers that can "infect" generation.
    line = line.replace(/^\s{0,3}(#{1,6}\s+)+/g, "");
    line = line.replace(/^\s{0,3}[-*+]\s+/g, "");
    line = line.replace(/^\s{0,3}>\s+/g, "");

    // Collapse accidental table pipes
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.replace(/\|/g, " ");

    out.push(line);
  }

  // If a likely meta fence was opened but never closed, close it at the end.
  if (inFence && fenceLikelyMeta) out.push("```");

  return out.join("\n").trim();
}

// Enforce output rules softly without rewriting story content.
// - Remove markdown headings/bullets/links that break the client streaming parser.
// - Keep *...* and "..." as-is.
export function enforceNovelOnlyOutput(text: string): string {
  let s = String(text ?? "");
  if (!s) return s;

  // Remove markdown headings at line starts
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // Remove list bullets at line starts
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, "");

  // Strip markdown link syntax: [text](url) -> text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Strip bold/italic markers that can appear mid-stream
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");

  // (repair) INFO/STATUS 펜스가 앞따옴표로 감싸져 대사로 인식되는 경우가 있다: "```Info -> ```INFO
  s = s.replace(/^\s*["“”']+\s*```\s*(INFO|STATUS)\b/gi, "```$1");
  s = s.replace(/^\s*["“”']+\s*(INFO|STATUS)\b/gi, "```$1");

  // (repair) 이미지 다음에 말줄임표로 시작하는 라인에서 앞따옴표가 빠지고 끝따옴표만 남는 경우를 보정: ......린." -> "......린."
  {
    const lines = s.replace(/\r\n/g, "\n").split("\n").map((ln) => {
      const raw = String(ln || "");
      const t = raw.trimStart();
      if (!t) return raw;
      if (t.endsWith('"') && !t.startsWith('"') && !t.startsWith("*") && !t.startsWith("```")) {
        if (/^[.…\.]{2,}/.test(t)) return raw.replace(/^\s*/, (m0) => m0 + '"');
      }
      return raw;
    });
    s = lines.join("\n");
  }

    // (helper) 이미지 라인(plain URL/markdown)을 strict 채널 필터에서 예외로 처리
  const isImageLine = (line: string) => {
    const t = String(line || "").trim();
    if (!t) return false;
    if (/^!\[[^\]]*\]\([^\)]*\)/.test(t)) return true; // ![alt](url)
    if (/^\{\{img:/i.test(t)) return true;
    if (/^(?:https?:\/\/|\/\/)\S+/i.test(t) && /\.(?:png|jpe?g|webp|gif)(?:\?\S*)?$/i.test(t)) return true;
    return false;
  };

// (repair) 모델이 맨 위에 작품 제목 같은 한 줄을 찍는 경우 제거(토큰 절감은 프롬프트 단계에서 별도지만, 출력/저장 오염 방지)
  {
    const raw = s.replace(/\r\n/g, "\n");
    const lines = raw.split("\n");
    let firstIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (String(lines[i] || "").trim().length > 0) { firstIdx = i; break; }
    }
    if (firstIdx >= 0) {
      const first = String(lines[firstIdx] || "").trim();
      const startsBad = first.startsWith("*") || first.startsWith('"') || first.startsWith("```");
      const titley = first.length <= 45 && !startsBad && (first.includes(":") || first.includes("!") || first.includes("|")) && !isImageLine(first);
      if (titley) {
        let second = "";
        for (let j = firstIdx + 1; j < lines.length; j++) {
          const cand = String(lines[j] || "").trim();
          if (cand) { second = cand; break; }
        }
        if (second && second.length > 4) {
          lines.splice(firstIdx, 1);
          s = lines.join("\n").replace(/^\s*\n+/, "");
        }
      }
    }
  }

// Repair leading plain narration that violates strict output channels.
// Allowed starts (after whitespace): *...* narration, "..." dialogue, or fenced ```INFO/```STATUS blocks.
// Older logic dropped these lines, but Gemini sometimes starts with valid narration without *...*.
// In that case, preserve the text by wrapping the first plain paragraph as narration.
{
  const allowedStart = (t: string) => {
    const u = (t || "").trimStart();
    return (
      u.startsWith("*") ||
      u.startsWith('"') ||
      u.startsWith("```INFO") ||
      u.startsWith("```STATUS") ||
      u.startsWith("```") ||
      isImageLine(u)
    );
  };

  if (!allowedStart(s)) {
    const lines = s.split(/\r?\n/);
    let firstTextIdx = -1;
    let firstAllowedIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      if (firstTextIdx < 0) firstTextIdx = i;
      const rest = lines.slice(i).join("\n");
      if (allowedStart(rest)) {
        firstAllowedIdx = i;
        break;
      }
    }

    if (firstAllowedIdx > 0) {
      const prefix = lines.slice(0, firstAllowedIdx).join("\n").trim();
      const prefixFlat = prefix.replace(/\s+/g, " ").trim();
      const looksMeaningfulPrefix =
        prefixFlat.length >= 40 ||
        /\b(?:sorry|safety|policy|cannot|unable|decline)\b/i.test(prefixFlat) ||
        /죄송|안전|정책|지침|도와드릴|생성할 수 없|참여할 수 없|불가능/.test(prefixFlat);

      if (looksMeaningfulPrefix) {
        const fixedPrefix = prefix
          .split(/\n{2,}/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => (allowedStart(part) ? part : `*${part}*`))
          .join("\n\n");
        const rest = lines.slice(firstAllowedIdx).join("\n").replace(/^\s*\n+/, "");
        s = [fixedPrefix, rest].filter(Boolean).join("\n\n").trim();
      } else {
        s = lines.slice(firstAllowedIdx).join("\n").replace(/^\s*\n+/, "");
      }
    } else if (firstTextIdx >= 0) {
      const raw = String(lines[firstTextIdx] || "");
      const t = raw.trim();
      const looksLikePlainNarration =
        t.length > 0 &&
        !allowedStart(t) &&
        !isImageLine(t) &&
        !/^\s{0,3}#{1,6}\s/.test(t) &&
        !/^\s*[-*+]\s+/.test(t);
      if (looksLikePlainNarration) {
        const indent = raw.match(/^\s*/)?.[0] || "";
        lines[firstTextIdx] = `${indent}*${t}*`;
        s = lines.join("\n").replace(/^\s*\n+/, "");
      }
    }
  }
}

  return s;

}//test
