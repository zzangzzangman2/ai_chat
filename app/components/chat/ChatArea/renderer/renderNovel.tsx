import React from "react";

export type ChatTheme = {
  text: string;
  narration: string;
  name: string;
  thought: string;
  speech: string;
};

export type RenderInline = (t: string) => React.ReactNode;

export function renderNovelNode(
  text: string,
  ctx: { theme: ChatTheme; renderInline: RenderInline }
): React.ReactNode {
  const CHAT_THEME = ctx.theme;
  const renderInline = ctx.renderInline;

  // 모델 출력이 종종 아래처럼 깨질 때가 있음:
  //   **"**리리안 |** ...망했어..."**
  //   "..."*
  // - bold 마커(**) 제거
  // - 따옴표 내부의 '이름 |' 접두 제거
  // - 따옴표 직후 공백 제거
  // - 닫는 따옴표가 2개 이상 붙는 경우 1개로 축약
  // - 따옴표 뒤에 남는 '*' / '"' 같은 잔상 제거
  const stripBold = (s: string) => String(s ?? "").replace(/\*\*/g, "");
  // Remove markdown-ish star markers. In novel mode we treat '*' as formatting noise.
  // Includes ASCII '*' + fullwidth '＊' + a few common asterisk variants.
  // Strip narration wrapper asterisks.
  // Note: LLM output sometimes uses different asterisk variants; remove broadly.
  const stripStars = (s: string) => String(s ?? "").replace(/[\*＊∗﹡⁎✱✳✶]/g, "");

  // Remove asterisk wrappers from the whole text outside triple-backtick fences.
  // This prevents stray leading "*" (e.g. "*나비의") leaking into UI after code fences.
  const stripStarsOutsideFences = (raw: string) => {
    const lines = String(raw ?? "").split("\n");
    let inFence = false;
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trimStart();
      if (t.startsWith("```")) {
        inFence = !inFence;
        out.push(line);
        continue;
      }
      out.push(inFence ? line : stripStars(line));
    }
    return out.join("\n");
  };

  // Some logs/DB rows can end up storing assistant text in a JSON-escaped form
  // (literal '\n', '\"', '\uXXXX'). If we render it as-is, the whole message
  // becomes a single line and our novel parser (line-based) breaks.
  const normalizeEscapedText = (input: string) => {
    let out = String(input ?? "");
    const looksEscaped = (out.includes("\\n") && !out.includes("\n")) || out.includes("\\\"") || out.includes("\\u");
    if (!looksEscaped) return out;

    // Newlines
    out = out.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
    // Quotes
    out = out.replace(/\\\"/g, '"');
    // Unicode escapes
    out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return out;
  };

  function normalizeQuoted(quotedRaw: string) {
    let quoted = stripStars(stripBold(quotedRaw));
    quoted = stripStars(quoted);

    // 따옴표 내부 "이름 |" 접두 제거
    // 예: "리리안 | ..." => "..."
    quoted = quoted.replace(/^(\"|“)\s*([^|\"“”]{1,40})\s*\|\s*/, "$1");

    // 따옴표 직후/직전 공백 제거
    quoted = quoted.replace(/^(\"|“)\s+/, "$1");
    quoted = quoted.replace(/\s+(\"|”)$/, "$1");

    // 닫는 따옴표가 2개 이상 붙는 경우 1개로
    quoted = quoted.replace(/(\"|”)\1+$/, "$1");

    // 서로 다른 따옴표가 연속으로 붙는 경우(예: "" 또는 ”")도 1개로
    quoted = quoted.replace(/[\"”]{2,}$/, (m) => m[m.length - 1]);

    return quoted;
  }

  function isStrayTail(tail: string) {
    const s = stripBold(tail).trim();
    if (!s) return true;

    // 따옴표 뒤에 남는 '*' / '**' 같은 잔상
    if (/^[*＊]+$/.test(s)) return true;
    if (/^[*＊]+[\.,!?…]+$/.test(s)) return true;

    // 닫는 따옴표가 꼬리로 남는 경우
    if (/^[\"”]+$/.test(s)) return true;
    if (/^[\"”]+[\.,!?…]+$/.test(s)) return true;

    return false;
  }

  function findCloseQuote(rest: string, openCh: string, from: number) {
    const closeCh = openCh === "“" ? "”" : '"';
    let idx = rest.indexOf(closeCh, from);
    // fallback: 쌍이 뒤섞여 나온 경우
    if (idx < 0) idx = rest.indexOf(openCh === "“" ? '"' : "”", from);
    return idx;
  }

  // *지문* 내부에 있는 "..." 도 '대사 색상'으로 표시되도록 분리 렌더
  // (요청사항 #1) "끄으윽..." 같은 대사가 지문에 섞여 있어도 대사 처리
  function renderNarrationWithQuotes(inner: string, italic: boolean) {
    const s = stripStars(String(inner ?? ""));
    const nodes: React.ReactNode[] = [];

    let i = 0;
    while (i < s.length) {
      const open = s.slice(i).search(/[\"“]/);
      if (open < 0) {
        const tail = s.slice(i);
        if (tail) nodes.push(<span key={nodes.length}>{renderInline(tail)}</span>);
        break;
      }
      const openIdx = i + open;
      const before = s.slice(i, openIdx);
      if (before) nodes.push(<span key={nodes.length}>{renderInline(before)}</span>);

      const openCh = s[openIdx];
      const closeIdx = findCloseQuote(s, openCh, openIdx + 1);
      if (closeIdx < 0) {
        // 닫는 따옴표가 없으면 나머지는 지문으로
        nodes.push(<span key={nodes.length}>{renderInline(s.slice(openIdx))}</span>);
        break;
      }

      const quotedRaw = s.slice(openIdx, closeIdx + 1);
      const quoted = normalizeQuoted(quotedRaw);
      nodes.push(
        <span key={nodes.length} style={{ color: CHAT_THEME.speech, fontStyle: "normal" }}>
          {renderInline(quoted)}
        </span>
      );

      // 따옴표 바로 뒤에 붙는 '*' 같은 잔상을 제거
      let next = closeIdx + 1;
      while (next < s.length && (s[next] === "*" || s[next] === "＊")) next += 1;
      i = next;
    }

    return (
      <span style={{ color: CHAT_THEME.narration, fontStyle: italic ? "italic" : "normal" }}>
        {nodes}
      </span>
    );
  }

  const renderOneLine = (raw: string, key: React.Key) => {
    const line = String(raw ?? "").trimEnd();
    if (!line) return <div key={key} style={{ height: 4 }} />;

    // (UX) 모델이 가끔 "=" / "＝" 같은 노이즈 라인을 섞어 출력하는 경우가 있어 제거
    if (/^[=＝]+$/.test(line.trim())) {
      return <div key={key} style={{ height: 4 }} />;
    }

    const trimmed = line.trim();
    const detectTrimmed = stripBold(trimmed);

    // (중요) 따옴표로 시작하는 라인은 name|line 로직보다 먼저 처리해야
    // **"**리리안 |** ..."** 같은 케이스가 깨지지 않는다.
    {
      const speakerM = detectTrimmed.match(/^(\[[^\]]+\])\s*(.*)$/);
      const speaker = speakerM ? speakerM[1] : "";
      const rest0 = speakerM ? String(speakerM[2] || "") : detectTrimmed;
      const rest = rest0.trimStart();

      if (rest.startsWith('"') || rest.startsWith("“")) {
        const openCh = rest[0];
        const closeIdx = findCloseQuote(rest, openCh, 1);
        if (closeIdx > 0) {
          // closeIdx 뒤에 닫는 따옴표가 더 붙어 있으면 꼬리로 분리되어 처리된다.
          const quoted = normalizeQuoted(rest.slice(0, closeIdx + 1));
          const tail = stripBold(rest.slice(closeIdx + 1));

          return (
            <div key={key} style={{ lineHeight: 1.6 }}>
              {speaker ? <span style={{ color: CHAT_THEME.narration }}>{speaker}</span> : null}
              {speaker ? " " : null}
              <span style={{ color: CHAT_THEME.speech }}>{renderInline(quoted)}</span>
              {!isStrayTail(tail) ? (
                <span style={{ color: CHAT_THEME.narration }}>{renderInline(stripStars(tail))}</span>
              ) : null}
            </div>
          );
        }
      }
    }

    // 전체가 *...* 이면 서술
    if (/^[*＊]/.test(trimmed) && /[*＊]$/.test(trimmed) && trimmed.length >= 2) {
      const inner = trimmed.slice(1, -1);
      return (
        <div key={key} style={{ lineHeight: 1.6 }}>
          {renderNarrationWithQuotes(stripStars(inner), false)}
        </div>
      );
    }

    // name | content 형태
    const m = trimmed.match(/^(.+?)\s*\|\s*(.+)$/);
    if (m) {
      // (요구사항 #2) 지문(서술)은 이름 접두를 표시하지 않는다.
      const rhs = (m[2] || "").trim();
      if (/^[*＊]/.test(rhs)) {
        const inner = /[*＊]$/.test(rhs) && rhs.length >= 2 ? rhs.slice(1, -1) : rhs.slice(1);
        return (
          <div key={key} style={{ lineHeight: 1.6 }}>
            {renderNarrationWithQuotes(stripStars(inner), false)}
          </div>
        );
      }

      return (
        <div key={key} style={{ lineHeight: 1.6 }}>
          <span style={{ fontWeight: 800, color: CHAT_THEME.name }}>{stripStars(stripBold(m[1]))}</span>
          {" | "}
          {(() => {
            const rhs2 = String(m[2] ?? "");
            const t = rhs2.trim();
            const isThought =
              t.startsWith("(") ||
              t.startsWith("（") ||
              t.startsWith("…") ||
              t.startsWith("...") ||
              /^\[(속마음|생각|내적)\]/.test(t) ||
              /^(속마음|생각|내적)[:：]/.test(t);
            const contentStyle = isThought
              ? ({ color: CHAT_THEME.thought, fontStyle: "italic" } as const)
              : ({ color: CHAT_THEME.speech } as const);
            return <span style={contentStyle}>{renderInline(stripStars(stripBold(rhs2)))}</span>;
          })()}
        </div>
      );
    }

    // 그 외: 지문/속마음
    return (
      <div key={key} style={{ lineHeight: 1.6 }}>
        {(() => {
          const t = trimmed;

          // *지문* 대사 형태 지원: 닫는 * 이후 텍스트는 별도 렌더
          if (/^[*＊]/.test(t)) {
            const close = (() => {
              const a = t.indexOf("*", 1);
              const b = t.indexOf("＊", 1);
              if (a < 0) return b;
              if (b < 0) return a;
              return Math.min(a, b);
            })();
            if (close > 1) {
              const narr = t.slice(1, close).trim();
              const rest = t.slice(close + 1).trimStart();
              return (
                <>
                  {renderNarrationWithQuotes(narr, true)}
                  {rest ? (
                    <span style={{ color: CHAT_THEME.speech, fontStyle: "normal" }}>
                      {" "}
                      {renderInline(stripStars(rest))}
                    </span>
                  ) : null}
                </>
              );
            }
            const inner = (/[*＊]$/.test(t) && t.length >= 2) ? t.slice(1, -1).trim() : t.slice(1).trimStart();
            return renderNarrationWithQuotes(inner, true);
          }

          const isThought =
            t.startsWith("(") ||
            t.startsWith("（") ||
            t.startsWith("…") ||
            t.startsWith("...") ||
            /^\[(속마음|생각|내적)\]/.test(t) ||
            /^(속마음|생각|내적)[:：]/.test(t);

          const style = isThought
            ? ({ color: CHAT_THEME.narration, fontStyle: "normal" } as const)
            : ({ color: CHAT_THEME.narration } as const);

          return <span style={style}>{renderInline(stripStars(t))}</span>;
        })()}
      </div>
    );
  };

  // Some streamed payloads or stored messages may be JSON-escaped (contain literal "\\n").
  // Normalize them here so the novel parser sees real line breaks and quotes.
  let normalizedText = normalizeEscapedText(text);
  normalizedText = stripStarsOutsideFences(normalizedText);
  const lines = normalizedText.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let k = 0;
  let inStarBlock = false;

  const pushSpacer = () => {
    out.push(<div key={`sp-${k++}`} style={{ height: 4 }} />);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i] ?? "");
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!inStarBlock) {
      if (!trimmed) {
        pushSpacer();
        continue;
      }
      if (/^[=＝]+$/.test(trimmed)) {
        pushSpacer();
        continue;
      }

      const detectTrimmed = stripBold(trimmed);

      // (FIX) 여러 줄 *...* 지문: 시작 *는 있는데 닫는 *가 같은 줄에 없다면
      // 다음 줄들까지 지문으로 처리하고, 표시용 "*"는 제거한다.
      {
        const mPipe = detectTrimmed.match(/^(.+?)\s*\|\s*(.+)$/);
        if (mPipe) {
          const rhs = String(mPipe[2] || "").trim();
          const rhsDetect = stripBold(rhs);
          if (/^[*＊]/.test(rhsDetect) && !(/[*＊]$/.test(rhsDetect) && rhsDetect.length >= 2)) {
            const inner = rhsDetect.slice(1).trimStart();
            if (inner) {
              out.push(
                <div key={`l-${k++}`} style={{ lineHeight: 1.6 }}>
                  {renderNarrationWithQuotes(stripStars(inner), false)}
                </div>
              );
            } else {
              pushSpacer();
            }
            inStarBlock = true;
            continue;
          }
        }
      }

      if (/^[*＊]/.test(detectTrimmed) && !(/[*＊]$/.test(detectTrimmed) && detectTrimmed.length >= 2)) {
        const inner = detectTrimmed.slice(1).trimStart();
        if (inner) {
          out.push(
            <div key={`l-${k++}`} style={{ lineHeight: 1.6 }}>
              {renderNarrationWithQuotes(stripStars(inner), false)}
            </div>
          );
        } else {
          pushSpacer();
        }
        inStarBlock = true;
        continue;
      }

      out.push(renderOneLine(raw, `l-${k++}`));
      continue;
    }

    // inStarBlock === true
    if (!trimmed) {
      pushSpacer();
      continue;
    }
    if (/^[=＝]+$/.test(trimmed)) {
      pushSpacer();
      continue;
    }

    const t = stripBold(trimmed);
    if (/^[*＊]$/.test(t)) {
      inStarBlock = false;
      continue;
    }

    const ends = /[*＊]$/.test(t) && t.length >= 1;
    const innerRaw = ends ? t.slice(0, -1) : t;
    const inner = innerRaw.trim();
    if (inner) {
      out.push(
        <div key={`l-${k++}`} style={{ lineHeight: 1.6 }}>
          {renderNarrationWithQuotes(stripStars(inner), false)}
        </div>
      );
    } else {
      pushSpacer();
    }

    if (ends) inStarBlock = false;
  }

  return <div style={{ display: "flex", flexDirection: "column", gap: 6, color: CHAT_THEME.text }}>{out}</div>;
}
