import type { ChatTheme, RenderInline } from "./renderNovel";
import { useState } from "react";

type QuestWidget = {
  widget: "quest";
  id: string;
  category?: string;
  title: string;
  desc?: string;
  objectives?: Array<{ text: string; done?: boolean; progress?: [number, number] }>;
  rewards?: Array<{ label: string }>;
  actions?: Array<{ key: "accept" | "reject"; label: string }>;
};

type SimCardParsed = { title: string; descHtml: string; recHtml: string };

type SafeTableParsed = { rows: string[][]; headerRows: number };

function tryParseQuestWidget(lang: string, value: string): QuestWidget | null {
  const l = String(lang || "").trim().toLowerCase();
  if (l !== "info" && l !== "quest") return null;

  const s = String(value || "").trim();
  if (!s || s[0] !== "{") return null;

  try {
    const obj: any = JSON.parse(s);
    if (!obj || obj.widget !== "quest") return null;
    if (typeof obj.id !== "string" || typeof obj.title !== "string") return null;

    const out: QuestWidget = {
      widget: "quest",
      id: obj.id,
      category: typeof obj.category === "string" ? obj.category : undefined,
      title: obj.title,
      desc: typeof obj.desc === "string" ? obj.desc : undefined,
      objectives: Array.isArray(obj.objectives)
        ? obj.objectives
            .map((o: any) => {
              if (!o || typeof o.text !== "string") return null;
              const p =
                Array.isArray(o.progress) &&
                o.progress.length === 2 &&
                Number.isFinite(Number(o.progress[0])) &&
                Number.isFinite(Number(o.progress[1]))
                  ? ([Number(o.progress[0]), Number(o.progress[1])] as [number, number])
                  : undefined;
              return {
                text: o.text,
                done: !!o.done,
                progress: p,
              };
            })
            .filter(Boolean)
        : undefined,
      rewards: Array.isArray(obj.rewards)
        ? obj.rewards
            .map((r: any) => (r && typeof r.label === "string" ? { label: r.label } : null))
            .filter(Boolean)
        : undefined,
      actions: Array.isArray(obj.actions)
        ? obj.actions
            .map((a: any) =>
              a && (a.key === "accept" || a.key === "reject") && typeof a.label === "string"
                ? { key: a.key, label: a.label }
                : null
            )
            .filter(Boolean)
        : undefined,
    };

    return out;
  } catch {
    return null;
  }
}

function QuestCard({
  data,
  theme,
  onQuickUserText,
}: {
  data: QuestWidget;
  theme: { text: string };
  onQuickUserText?: (text: string) => void;
}) {
  const [decided, setDecided] = useState<"accept" | "reject" | null>(null);

  const actions =
    data.actions && data.actions.length
      ? data.actions
      : [
          { key: "accept" as const, label: "수락" },
          { key: "reject" as const, label: "거절" },
        ];

  const act = (key: "accept" | "reject") => {
    if (decided) return;
    setDecided(key);
    const label = key === "accept" ? "퀘스트 수락" : "퀘스트 거절";
    const idPart = data.id ? ` [${data.id}]` : "";
    onQuickUserText?.(`${label}: ${data.title}${idPart}`);
  };

  return (
    <div
      style={{
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(5,10,18,0.70)",
      }}
    >
      <div
        style={{
          padding: "14px 18px",
          background: "linear-gradient(90deg, rgba(245,158,11,0.95), rgba(217,119,6,0.95))",
          color: "#0b1020",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>{data.category || "퀘스트"}</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{data.title}</div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          {decided ? (decided === "accept" ? "[수락됨]" : "[거절됨]") : ""}
        </div>
      </div>

      <div style={{ padding: 16, color: theme.text, display: "flex", flexDirection: "column", gap: 14 }}>
        {data.desc ? <div style={{ fontSize: 14, lineHeight: 1.65, opacity: 0.92 }}>{data.desc}</div> : null}

        {data.objectives?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontWeight: 700, opacity: 0.9 }}>{"{목표}"}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {data.objectives.map((o, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      marginTop: 3,
                      borderRadius: 4,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: o.done ? "rgba(34,197,94,0.75)" : "rgba(255,255,255,0.02)",
                      flex: "0 0 auto",
                    }}
                  />
                  <div style={{ flex: 1, fontSize: 14, lineHeight: 1.55, opacity: o.done ? 0.75 : 0.95 }}>
                    {o.text}
                    {o.progress ? ` (${o.progress[0]}/${o.progress[1]})` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data.rewards?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontWeight: 700, opacity: 0.9 }}>{"{보상}"}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {data.rewards.map((r, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "1px solid rgba(245,158,11,0.25)",
                    background: "rgba(245,158,11,0.12)",
                    color: "rgba(253,230,138,0.95)",
                  }}
                >
                  {r.label}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 10, paddingTop: 2 }}>
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={!!decided}
              onClick={() => act(a.key)}
              style={{
                flex: 1,
                padding: "12px 14px",
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.10)",
                background:
                  a.key === "accept"
                    ? "linear-gradient(90deg, rgba(59,130,246,0.95), rgba(37,99,235,0.95))"
                    : "rgba(255,255,255,0.05)",
                color: a.key === "accept" ? "#081225" : theme.text,
                fontWeight: 700,
                opacity: decided ? 0.6 : 1,
                cursor: decided ? "not-allowed" : "pointer",
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// NOTE: renderMarkdownLiteNode()는 "문자열"을 아주 가볍게 렌더링하기 위한 경량 렌더러다.
// - 임의 HTML/JS 실행은 절대 허용하지 않는다.
export function renderMarkdownLiteNode(
  text: string,
  ctx: {
    theme: ChatTheme;
    renderInline: RenderInline;
    showImages: boolean;
    onQuickUserText?: (text: string) => void;
  }
): React.ReactNode {
  const CHAT_THEME = ctx.theme;
  const renderInline = ctx.renderInline;
  const showImages = !!ctx.showImages;
  const onQuickUserText = ctx.onQuickUserText;

  const t = String(text || "");
  if (!t) return null;

  const sanitizeInlineHtml = (s: string) => {
    // 1) 위험 태그 블록 제거
    let x = String(s || "");
    x = x.replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\/\s*\1\s*>/gi, "");
    // 2) 허용 태그 외 제거 (b/strong/br만)
    x = x.replace(/<(?!\/?(?:b|strong|br)\b)[^>]*>/gi, "");
    // 3) 허용 태그의 속성 제거
    x = x.replace(/<\s*(b|strong)(?:\s+[^>]*)?>/gi, "<$1>");
    x = x.replace(/<\s*br(?:\s+[^>]*)?\s*\/?>/gi, "<br>");
    return x.trim();
  };

  const stripToText = (s: string) =>
    String(s || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+$/g, "")
      .trim();

  // (HTML) 아주 제한적으로 "sim-card" 안내 박스를 지원한다.
  const tryExtractSimCard = (html: string): SimCardParsed | null => {
    const raw = String(html || "");
    if (!/(<table[\s>][\s\S]*?<\/table>)/i.test(raw)) return null;
    if (!/class\s*=\s*["'“”][^"'“”]*\bsim-card\b/i.test(raw)) return null;

    const th = raw.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const tds = [...raw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => String(m[1] || ""));
    if (!th || tds.length < 2) return null;

    const title = stripToText(th[1]);
    const descHtml = sanitizeInlineHtml(tds[0]);
    const recHtml = sanitizeInlineHtml(tds[1]);

    if (!title || !descHtml || !recHtml) return null;
    return { title, descHtml, recHtml };
  };

  // (HTML) 일반 <table>을 안전하게 "표"로 렌더한다 (속성/위험태그 제거)
  const tryExtractSafeTable = (html: string): SafeTableParsed | null => {
    const raw = String(html || "");
    const mTable = raw.match(/<table[\s\S]*?<\/table>/i);
    if (!mTable) return null;

    // sim-card는 별도 카드 변환이 우선
    if (/class\s*=\s*["'“”][^"'“”]*\bsim-card\b/i.test(mTable[0])) return null;

    const table = mTable[0];

    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows: string[][] = [];
    let headerRows = 0;

    let mm: RegExpExecArray | null = null;
    let rowCount = 0;

    while ((mm = trRe.exec(table)) && rowCount < 60) {
      const rowHtml = String(mm[1] || "");
      const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
      const cells: string[] = [];
      let hasTh = false;

      let cm: RegExpExecArray | null = null;
      let colCount = 0;

      while ((cm = cellRe.exec(rowHtml)) && colCount < 30) {
        const tag = String(cm[1] || "").toLowerCase();
        if (tag === "th") hasTh = true;
        cells.push(sanitizeInlineHtml(cm[2] || ""));
        colCount++;
      }

      if (cells.length) {
        rows.push(cells);
        // 연속된 th 행만 헤더로 취급
        if (hasTh && headerRows === rows.length - 1) headerRows += 1;
        rowCount++;
      }
    }

    if (!rows.length) return null;
    return { rows, headerRows };
  };

  type Block =
    | { type: "text"; value: string }
    | { type: "code"; lang: string; value: string }
    | { type: "img"; url: string; alt: string };

  type SimCardBlock = { type: "simcard" } & SimCardParsed;
  type TableBlock = { type: "table" } & SafeTableParsed;

  const blocks: Block[] = [];

  // 1) 코드블록 분리 (```lang ... ```)
  const codeRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(t))) {
    const start = m.index;
    const end = codeRe.lastIndex;
    if (start > last) blocks.push({ type: "text", value: t.slice(last, start) });

    const lang = String(m[1] || "").trim().toLowerCase();
    const value = String(m[2] || "").replace(/\r\n/g, "\n").trimEnd();

    // NOTE: 워크스페이스 등에서 표/카드를 코드펜스로 감싸서 붙여넣는 경우가 있어,
    //       sim-card/table HTML이면 코드블록으로 취급하지 않고 텍스트로 내려서 변환되게 한다.
    const parsedSim = tryExtractSimCard(value);
    const parsedTbl = tryExtractSafeTable(value);
    if (parsedSim || parsedTbl) blocks.push({ type: "text", value });
    else blocks.push({ type: "code", lang, value });

    last = end;
  }
  if (last < t.length) blocks.push({ type: "text", value: t.slice(last) });

  // 1.5) 텍스트 블록 내부에서 <table ...>...</table> 를 별도 블록으로 분리
  const blocks2: Array<Block | SimCardBlock | TableBlock> = [];
  const tableRe = /(<table[\s\S]*?<\/table>)/gi;

  for (const b of blocks) {
    if (b.type !== "text") {
      blocks2.push(b);
      continue;
    }

    const s = String(b.value || "");
    let p = 0;
    let m2: RegExpExecArray | null;

    while ((m2 = tableRe.exec(s))) {
      const a = m2.index;
      const z = tableRe.lastIndex;
      if (a > p) blocks2.push({ type: "text", value: s.slice(p, a) });

      const html = String(m2[1] || "");
      const sim = tryExtractSimCard(html);
      if (sim) {
        blocks2.push({ type: "simcard", ...sim });
      } else {
        const tbl = tryExtractSafeTable(html);
        if (tbl) blocks2.push({ type: "table", ...tbl });
        else blocks2.push({ type: "text", value: html });
      }

      p = z;
    }

    if (p < s.length) blocks2.push({ type: "text", value: s.slice(p) });
  }

  // 2) 텍스트 블록 내부에서 마크다운 이미지(![](...))만 추가 분리
  const out: Array<Block | SimCardBlock | TableBlock> = [];
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  for (const b of blocks2) {
    if ((b as any).type !== "text") {
      out.push(b as any);
      continue;
    }

    const s = (b as any).value as string;
    let p = 0;
    let im: RegExpExecArray | null;

    while ((im = imgRe.exec(s))) {
      const a = im.index;
      const z = imgRe.lastIndex;
      if (a > p) out.push({ type: "text", value: s.slice(p, a) });

      const alt = String(im[1] || "");
      const url = String(im[2] || "");
      out.push({ type: "img", url, alt });
      p = z;
    }

    if (p < s.length) out.push({ type: "text", value: s.slice(p) });
  }

  const renderTextBlock = (value: string, key: string) => {
    let lines = String(value || "").replace(/\r\n/g, "\n").split("\n");

    if (!showImages) {
      const imgLineRe = /^\s*"?(?:https?:\/\/|\/\/)[^\s"]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"]*)?"?\s*$/i;
      lines = lines.filter((ln) => !imgLineRe.test(String(ln || "")));
    }

    return (
      <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6, whiteSpace: "pre-wrap" }}>
        {lines.map((line, idx) => {
          const raw = String(line || "");
          const trimmed = raw.trim();
          if (!trimmed) return <div key={idx} style={{ height: 4 }} />;
          // Hide stray standalone separator lines (often appears right before an image)
          if (/^[=＝]+$/.test(trimmed)) return <div key={idx} style={{ height: 4 }} />;

          const t2 = raw.trimEnd();
          return (
            <div key={idx} style={{ lineHeight: 1.6 }}>
              <span style={{ color: CHAT_THEME.speech }}>{renderInline(t2)}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderCodeBlock = (lang: string, value: string, key: string) => {
    const quest = tryParseQuestWidget(lang, value);
    if (quest) return <QuestCard key={key} data={quest} theme={CHAT_THEME} onQuickUserText={onQuickUserText} />;

    // (요구) 가로 스크롤(옆으로 밀림) 대신 줄바꿈으로 보이게
    return (
      <pre
        key={key}
        style={{
          margin: 0,
          padding: 14,
          borderRadius: 12,
          background: "rgba(255,255,255,0.06)",
          border: "none",
          color: CHAT_THEME.text,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowX: "hidden",
        }}
      >
        {value}
      </pre>
    );
  };

  const renderImageBlock = (url: string, alt: string, key: string) => {
    if (!showImages) return null;
    const safeUrl = String(url || "");
    return (
      <div key={key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={safeUrl}
          alt={alt || ""}
          style={{
            maxWidth: "100%",
            height: "auto",
            borderRadius: 14,
            border: "none",
            background: "rgba(255,255,255,0.02)",
          }}
        />
      </div>
    );
  };

  const renderSimCardBlock = (b: SimCardBlock, key: string) => {
    return (
      <div
        key={key}
        style={{
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 12,
          overflow: "hidden",
          background: "rgba(255,255,255,0.04)",
        }}
      >
        <div
          style={{
            padding: "12px 14px",
            textAlign: "center",
            fontWeight: 800,
            borderBottom: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(0,0,0,0.18)",
            color: CHAT_THEME.text,
          }}
        >
          {b.title}
        </div>
        <div
          style={{
            padding: "14px 16px",
            textAlign: "center",
            lineHeight: 1.65,
            color: CHAT_THEME.text,
            whiteSpace: "normal",
          }}
          dangerouslySetInnerHTML={{ __html: b.descHtml }}
        />
        <div
          style={{
            padding: "12px 16px",
            textAlign: "center",
            fontWeight: 800,
            borderTop: "1px solid rgba(255,255,255,0.14)",
            color: CHAT_THEME.text,
            whiteSpace: "normal",
          }}
          dangerouslySetInnerHTML={{ __html: b.recHtml }}
        />
      </div>
    );
  };

  const renderTableBlock = (b: TableBlock, key: string) => {
    const rows = b.rows || [];
    const headerRows = Math.max(0, Math.min(rows.length, Number(b.headerRows || 0)));

    return (
      <div
        key={key}
        style={{
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
        >
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} style={{ borderTop: ri === 0 ? "none" : "1px solid rgba(255,255,255,0.08)" }}>
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      padding: "10px 12px",
                      verticalAlign: "top",
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: CHAT_THEME.text,
                      borderLeft: ci === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
                      background: ri < headerRows ? "rgba(255,255,255,0.06)" : "transparent",
                      wordBreak: "break-word",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <span dangerouslySetInnerHTML={{ __html: String(cell || "") }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {out.map((b, i) => {
        if ((b as any).type === "code") return renderCodeBlock((b as any).lang, (b as any).value, `md-code-${i}`);
        if ((b as any).type === "img") return renderImageBlock((b as any).url, (b as any).alt, `md-img-${i}`);
        if ((b as any).type === "simcard") return renderSimCardBlock(b as any, `md-sim-${i}`);
        if ((b as any).type === "table") return renderTableBlock(b as any, `md-tbl-${i}`);
        return renderTextBlock((b as any).value, `md-txt-${i}`);
      })}
    </div>
  );
}
