import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { decryptIfPossible } from "@/lib/crypto";
import { generateText } from "@/lib/ai";
import { GEMINI_3_FLASH_MODEL } from "@/lib/models";

type Role = "user" | "assistant";

function safeStr(v: any): string {
  return String(v ?? "");
}

function clampStr(s: string, max: number): string {
  const t = safeStr(s);
  if (t.length <= max) return t;
  return t.slice(0, max);
}



const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

function stripZeroWidth(s: string): string {
  return safeStr(s).replace(ZERO_WIDTH_RE, "");
}

function stripOuterQuotesAny(s: string): string {
  let t = stripZeroWidth(s).trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["“", "”"],
    ["”", "”"],
    ["“", "“"],
    ["「", "」"],
    ["『", "』"],
  ];
  for (const [open, close] of pairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length >= open.length + close.length + 1) {
      t = t.slice(open.length, t.length - close.length).trim();
      break;
    }
  }
  return t;
}

function extractDialogueFromAssistant(content: string): string[] {
  const out: string[] = [];
  const text = stripZeroWidth(content);
  for (const rawLine of text.split(/\r?\n/)) {
    const l = rawLine.trim();
    if (!l) continue;
    if (l.startsWith("```")) continue;
    if (l.startsWith("*")) continue;

    // Whole-line quoted dialogue
    if (/^[\"“”「『]/.test(l)) {
      const inner = stripOuterQuotesAny(l);
      const cleaned = inner
        .replace(/^[\"“”「『]\s*/, "")
        .replace(/[\"”」』]\s*$/, "")
        .trim();
      if (cleaned) out.push(cleaned);
      continue;
    }

    // Inline quoted fragments
    const re = /[\"“”「『]([^\"“”」』]{1,280})[\"”」』]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l))) {
      const frag = safeStr(m[1]).trim();
      if (frag) out.push(frag);
    }
  }
  return out;
}

function extractDialogueFromUser(content: string): string[] {
  const out: string[] = [];
  const text = stripZeroWidth(content);
  for (const rawLine of text.split(/\r?\n/)) {
    const l0 = rawLine.trim();
    if (!l0) continue;
    if (l0.startsWith("```")) continue;
    if (l0.startsWith("*")) continue;
    const inner = stripOuterQuotesAny(l0);
    const cleaned = inner.replace(/^[\"“”「『]\s*/, "").replace(/[\"”」』]\s*$/, "").trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function inferPolitenessFromUser(lines: string[]): "polite" | "casual" | "unknown" {
  const tail = lines.slice(-4).join(" ");
  const t = stripZeroWidth(tail);
  // rough heuristics (Korean)
  if (/(습니다|세요|해요|해요\?|까요|죠\?|입니다|였어요|했어요)/.test(t)) return "polite";
  if (/(했어|왔어|아냐|거야|맞아|야|지|해)/.test(t)) return "casual";
  return "unknown";
}

function buildDialogueTranscript(recent: { role: Role; content: string }[]): { transcript: string; userLines: string[] } {
  const lines: string[] = [];
  const userLines: string[] = [];
  for (const m of recent) {
    if (m.role === "user") {
      const ds = extractDialogueFromUser(m.content);
      for (const d of ds) {
        userLines.push(d);
        lines.push(`주인공: ${d}`);
      }
    } else {
      const ds = extractDialogueFromAssistant(m.content);
      for (const d of ds) lines.push(`상대: ${d}`);
    }
  }
  // Keep the last part; this is only for suggestions
  const transcript = lines.join("\n").slice(-5200);
  return { transcript, userLines };
}


function personaOverrideToText(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return safeStr(v);
  if (typeof v === "object") {
    const name = safeStr((v as any).personaName || (v as any).name || "").trim();
    const ageRaw = Number((v as any).personaAge || (v as any).age || 0);
    const age = Number.isFinite(ageRaw) && ageRaw > 0 ? String(Math.floor(ageRaw)) : "";
    const gender = safeStr((v as any).personaGender || (v as any).gender || "").trim();
    const info = safeStr((v as any).personaInfo || (v as any).info || "").trim();

    const parts: string[] = [];
    if (name) parts.push(`이름: ${name}`);
    if (age) parts.push(`나이: ${age}`);
    if (gender) parts.push(`성별: ${gender}`);
    if (info) parts.push(`설명: ${info}`);

    const alt = safeStr((v as any).personaOverrideText || (v as any).text || "").trim();
    const out = parts.join("\n").trim();
    return out || alt || "";
  }
  return safeStr(v);
}

function normalizeLine(s: string): string {
  // suggestions must be dialogue only: no leading list markers, no role tags, no quotes wrapping, no markdown
  let t = safeStr(s).trim();
  if (!t) return "";
  if (t.startsWith("{") && /"suggestions"\s*:/.test(t)) return "";
  t = t.replace(/^[-*\d\)\.]+\s+/g, "");
  t = t.replace(/^(주인공|나|당신|상대|NPC|\[.*?\])\s*[:|]\s*/i, "");
  // Strip surrounding quotes (but keep inner quotes)
  // NOTE: Avoid the /s (dotAll) flag for older TS targets by using [\s\S].
  t = t.replace(/^"([\s\S]+)"$/, "$1");
  t = t.replace(/^“([\s\S]+)”$/, "$1");
  // Remove markdown images/links
  t = t.replace(/!\[[^\]]*\]\([^\)]+\)/g, "").trim();
  t = t.replace(/\[[^\]]*\]\([^\)]+\)/g, "").trim();
  // Remove stray code fences
  t = t.replace(/```[\s\S]*?```/g, "").trim();
  // Collapse spaces
  t = t.replace(/\s+/g, " ").trim();
  // Hard clamp
  if (t.length > 120) t = t.slice(0, 120).trim();
  return t;
}

function pickTwoFallback(lastNpcOrAssistant: string): [string, string] {
  // Context-aware-ish, always dialogue. Used when the model output is malformed/truncated.
  const hint = normalizeLine(lastNpcOrAssistant);
  const mk = (a: string, b: string): [string, string] => [normalizeLine(a), normalizeLine(b)];

  // Light heuristics for common intro/first-contact scenes
  if (/(길을\s*잃|길\s*잃|길\s*찾|처음\s*뵙|처음\s*보|처음\s*만나|길\s*을\s*잃)/.test(hint)) {
    return mk("아니요, 잠깐 물어볼 게 있어요. 여긴 어디죠?", "길은 안 잃었어요. 당신은 여기서 뭘 하고 있었죠?");
  }
  if (/(안녕하세요|반가워요|처음)/.test(hint)) {
    return mk("안녕하세요. 잠깐만요, 여기서 무슨 일이 있었나요?", "…당신, 나를 알고 있나요? 왜 그렇게 태연하죠?");
  }


  if (/(천사|유령|영혼|죽었|죽어|사후|저승)/.test(hint)) {
    return mk("…천사라니, 왜 그렇게 생각했어? 무슨 일이 있었던 거야?", "난 천사가 아니야. 그런데 너, 방금 ‘죽었다’고 했지? 처음부터 설명해.");
  }
  if (/(누구|누구세|정체|아저씨|당신\s*은\s*누구)/.test(hint)) {
    return mk("나? 우선 진정해. 네가 먼저 누구인지, 왜 여기 있는지 말해줄래?", "…내가 누군지보다, 네가 왜 떨고 있는지가 더 궁금해. 방금 무슨 일을 겪었어?");
  }

  if (hint) {
    return mk("잠깐만요. 방금 한 말, 더 자세히 설명해줄래요?", "좋아. 그럼 당신이 뭘 원하는지부터 말해요.");
  }

  return mk("…잠깐만요. 지금 무슨 상황이죠?", "저기, 당신은 누구예요?");
}

function parseSuggestionsJson(raw: string): string[] {
  const t = safeStr(raw).trim();

  const tryParse = (s: string): string[] | null => {
    try {
      const obj = JSON.parse(s);
      const v: any = obj && (obj.suggestions ?? obj.Suggestions);
      if (Array.isArray(v)) return v.map((x) => safeStr(x));
      if (typeof v === "string") {
        const lines = v
          .split(/\r?\n|\s*\|\s*|\s*\/\s*/)
          .map((l) => l.trim())
          .filter(Boolean);
        return lines.length ? lines : null;
      }
    } catch {
      // ignore
    }
    return null;
  };

  // direct JSON
  const direct = tryParse(t);
  if (direct) return direct;

  // try to extract JSON substring
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    const extracted = tryParse(m[0]);
    if (extracted) return extracted;
  }

  // fallback: take first 2 non-empty lines
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, 2);
}


export async function POST(req: Request) {
  try {
    const u = await getSessionUser();
    if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({} as any));

    const chatId = safeStr(body?.chatId || "").trim();
    if (!chatId) {
      return NextResponse.json({ ok: false, error: "Missing chatId" }, { status: 400 });
    }

    const personaOverride = personaOverrideToText(body?.personaOverride);
    const assistantContent = safeStr(body?.assistantContent || "").trim();
    const assistantSummary = safeStr(body?.assistantSummary || "").trim();
    const lastNpcLine = safeStr(body?.lastNpcLine || "").trim();
    const userContent = safeStr(body?.userContent || "").trim();
    const previousSuggestions: string[] = Array.isArray(body?.previousSuggestions) ? body.previousSuggestions.map((x: any) => safeStr(x)) : [];

    // Prefer client-provided recentMessages to avoid stale DB reads right after streaming.
    const recentMessagesRaw = Array.isArray(body?.recentMessages) ? body.recentMessages : null;
    let recent: { role: Role; content: string }[] = [];

    if (recentMessagesRaw) {
      recent = recentMessagesRaw
        .map((m: any) => {
          const role: Role = m?.role === "user" ? "user" : "assistant";
          return { role, content: safeStr(m?.content || "") };
        })
        .filter((m: any) => (m.role === "user" || m.role === "assistant") && safeStr(m.content).trim().length > 0)
        .slice(-24)
        .map((m: any) => ({ role: m.role as Role, content: clampStr(m.content, 4000) }));
    } else {
      // DB fallback
      const rows = db
        .prepare(`SELECT role, content FROM messages WHERE chatId = ? ORDER BY createdAt DESC LIMIT 24`)
        .all(chatId)
        .reverse() as any[];
      recent = rows
        .map((r) => {
          const role: Role = r.role === "user" ? "user" : "assistant";
          return {
            role,
            content: safeStr(decryptIfPossible(safeStr(r.content || ""))),
          };
        })
        .filter((m) => (m.role === "user" || m.role === "assistant") && safeStr(m.content).trim().length > 0)
        .slice(-24)
        .map((m) => ({ role: m.role as Role, content: clampStr(m.content, 4000) }));
    }

    // Target text to ground on: assistantContent override > last assistant in recent
    let targetAssistant = (assistantSummary || assistantContent).trim();
    if (!targetAssistant) {
      const lastA = [...recent].reverse().find((m) => m.role === "assistant");
      targetAssistant = safeStr(lastA?.content || "").trim();
    }

    // Build a dialogue-only transcript so the model can infer tone (존댓말/반말) reliably.
    const { transcript: dialogueTranscript, userLines: recentUserLines } = buildDialogueTranscript(recent);
    const style = inferPolitenessFromUser(recentUserLines);
    const styleHint =
      style === "polite"
        ? "주인공은 최근 존댓말을 사용했다. 추천 대사도 존댓말을 유지해라."
        : style === "casual"
          ? "주인공은 최근 반말을 사용했다. 추천 대사도 반말을 유지해라."
          : "주인공의 말투가 불명확하면 가장 최근 주인공 대사의 말투를 따라라.";

    const contextLines = dialogueTranscript || "(대화 대사 없음)";

    const lastLineHint = (userContent || targetAssistant || "").slice(-400);

    const system = [
      "너는 소설형 AI 채팅의 '추천 대사' 생성기다.",
      "반드시 한국어.",
      "반드시 '대사만' 만든다. 지문(*...*), 해설, 분석, 목록, 번호, 역할 태그(주인공|상대|NPC|:) 금지.",
      "반드시 2개를 만든다.",
      "두 개는 의도를 다르게 만든다: (1) 부드럽게 확인 (2) 조심스럽게 되묻기.",
      "최근 주인공 말투(존댓말/반말)를 반드시 유지한다.",
      "대사 텍스트 자체를 따옴표로 감싸지 마라(예: \"안녕\" 금지).",
      "마크다운(이미지/링크/코드) 금지.",
      "출력은 정확히 두 줄. 1줄=대사 1개. 다른 문장/공백 줄 추가 금지.",
    ].join("\n");


    const user = [
      personaOverride ? `[주인공 설정]\n${clampStr(personaOverride, 1400)}` : "",
      `[말투 힌트]\n${styleHint}`,
      "[최근 대화(대사만 발췌, 가장 중요)]",
      contextLines || "(없음)",
      targetAssistant ? "\n[장면 요약/핵심(특히 중요)]\n" + clampStr(targetAssistant, 900) : "",
      lastNpcLine ? "\n[상대의 마지막 대사(최우선)]\n" + clampStr(lastNpcLine, 240) : "",
      userContent ? "\n[방금 주인공 입력(참고)]\n" + clampStr(userContent, 600) : "",
      previousSuggestions.length ? "\n[이전 추천(중복 금지)]\n" + previousSuggestions.map((s) => `- ${s}`).join("\n") : "",
      "\n[지시]",
      "- 위 맥락을 빠르게 요약해서, 지금 당장 이어질 주인공의 대사를 2개 제시해라.",
      "- 반드시 상대 NPC에게 바로 던질 대사만(한 줄 대사씩).",
      "- 반드시 지금 상황에 붙어 있어야 한다(일반론/뜬금포 금지).",
      "- 마지막에 끊기지 않게 완결된 문장으로 끝내라.",
      lastLineHint ? "\n[마지막 힌트]\n" + clampStr(lastLineHint, 240) : "",
    ].filter(Boolean).join("\n");

    const out = await generateText({
      system,
      user,
      opts: {
        // Fast + cheap, but keep enough quality
        model: GEMINI_3_FLASH_MODEL,
        maxOutputTokens: 220,
      } as any,
    });

    const raw = safeStr(out?.text || "").trim();
    const parsed = parseSuggestionsJson(raw);

    const cleaned = parsed.map(normalizeLine).filter(Boolean);
    let s1 = cleaned[0] || "";
    let s2 = cleaned[1] || "";

    if (!s1 || !s2 || s1 === s2) {
      const [f1, f2] = pickTwoFallback(targetAssistant || userContent);
      if (!s1) s1 = f1;
      if (!s2 || s1 === s2) s2 = f2;
    }

    // Ensure exactly 2
    const suggestions = [normalizeLine(s1), normalizeLine(s2)].filter(Boolean);
    while (suggestions.length < 2) suggestions.push(normalizeLine("…좋아. 계속해."));

    return NextResponse.json({ ok: true, suggestions: suggestions.slice(0, 2) });
  } catch (e: any) {
    // Never 500 the UI: return safe fallbacks
    const [a, b] = pickTwoFallback("");
    return NextResponse.json({ ok: true, suggestions: [a, b], warn: safeStr(e?.message || e) });
  }
}
