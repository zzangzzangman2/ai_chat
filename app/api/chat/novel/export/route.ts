import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { decryptIfPossible } from "@/lib/crypto";
import { generateText, isRefusalText } from "@/lib/ai";
import {
  buildNovelSourceChunks,
  buildNovelChapterPrompt,
  buildNovelSystemPrompt,
  parseGeneratedNovelChapter,
  safeNovelFilename,
  type NovelChapter,
  type NovelSourceMessage,
} from "@/lib/novel_export";
import { buildNovelPdf } from "@/lib/novel_pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

const activeExports = new Set<string>();

type NovelChatRow = {
  id: string;
  title?: string | null;
  presetId?: string | null;
  presetName?: string | null;
};

type NovelMessageRow = {
  id: string;
  role: string;
  content: string;
  createdAt?: number | null;
};

function isLoopback(value: string) {
  const host = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const normalized = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLocalRequest(req: Request) {
  const url = new URL(req.url);
  if (!isLoopback(url.hostname)) return false;
  const forwarded = String(req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.length === 0 || forwarded.every(isLoopback);
}

export async function POST(req: Request) {
  if (!isLocalRequest(req)) {
    return Response.json({ error: "소설 PDF 만들기는 로컬에서만 사용할 수 있습니다." }, { status: 403 });
  }
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const chatId = String(body?.chatId || "").trim();
  const requestedTitle = String(body?.title || "").trim();
  if (!chatId) return Response.json({ error: "chatId가 필요합니다." }, { status: 400 });
  if (activeExports.has(chatId)) {
    return Response.json({ error: "이 채팅의 소설 PDF를 이미 만들고 있습니다." }, { status: 409 });
  }

  const chat = db
    .prepare(
      `SELECT c.id, c.title, c.presetId, p.name AS presetName
         FROM chats c
         LEFT JOIN presets p ON p.id=c.presetId
        WHERE c.id=? AND c.userEmail=?`
    )
    .get(chatId, user.email) as NovelChatRow | undefined;
  if (!chat) return Response.json({ error: "채팅을 찾지 못했습니다." }, { status: 404 });

  const rows = db
    .prepare(`SELECT id, role, content, createdAt FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC`)
    .all(chatId) as NovelMessageRow[];
  const messages: NovelSourceMessage[] = rows.map((row) => ({
    id: String(row.id || ""),
    role: String(row.role || ""),
    content: decryptIfPossible(String(row.content || "")),
    createdAt: Number(row.createdAt || 0),
  }));
  const chunks = buildNovelSourceChunks(messages);
  if (!chunks.length) {
    return Response.json({ error: "소설로 만들 대화가 없습니다." }, { status: 400 });
  }

  const title = requestedTitle || String(chat.title || chat.presetName || "소설").trim() || "소설";
  const encoder = new TextEncoder();
  const jobAbort = new AbortController();
  const abortFromRequest = () => jobAbort.abort("novel-export-client-left");
  req.signal.addEventListener("abort", abortFromRequest, { once: true });
  activeExports.add(chatId);

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        if (jobAbort.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      (async () => {
        try {
          send({
            type: "progress",
            percent: 2,
            current: 0,
            total: chunks.length,
            message: `전체 대화 정리 완료 · ${chunks.length}개 장`,
          });
          const chapters: NovelChapter[] = [];
          let previousTail = "";
          for (const chunk of chunks) {
            if (jobAbort.signal.aborted) throw new Error("소설 만들기가 취소되었습니다.");
            const beforePercent = 5 + Math.floor(((chunk.index - 1) / chunks.length) * 86);
            send({
              type: "progress",
              percent: beforePercent,
              current: chunk.index,
              total: chunks.length,
              message: `${chunk.index}/${chunks.length}장 원고 작성 중`,
            });
            const generated = await generateText({
              system: buildNovelSystemPrompt(),
              user: buildNovelChapterPrompt({
                chunkIndex: chunk.index,
                chunkCount: chunks.length,
                previousTail,
                source: chunk.source,
              }),
              opts: {
                model: "gemini-3.7-flash",
                maxOutputTokens: 6500,
                maxOutputTokensRequested: 6500,
                maxReasoningTokens: 128,
                temperature: 0.55,
                topP: 0.88,
                topK: 36,
                timeoutMs: 180000,
                signal: jobAbort.signal,
                disableMaxTokensFallback: true,
                disableRefusalFallback: true,
              },
            });
            const raw = String(generated?.text || "").trim();
            if (!raw || isRefusalText(raw)) {
              throw new Error(`${chunk.index}장 원고 생성에 실패했습니다.`);
            }
            const chapter = parseGeneratedNovelChapter(raw, chunk);
            if (chapter.body.length < 200) {
              throw new Error(`${chunk.index}장 원고가 너무 짧아 PDF 생성을 중단했습니다.`);
            }
            chapters.push(chapter);
            previousTail = chapter.body.slice(-1800);
            send({
              type: "progress",
              percent: 5 + Math.floor((chunk.index / chunks.length) * 86),
              current: chunk.index,
              total: chunks.length,
              message: `${chunk.index}/${chunks.length}장 원고 완료`,
            });
          }

          send({ type: "progress", percent: 94, current: chunks.length, total: chunks.length, message: "PDF 편집 중" });
          const pdf = await buildNovelPdf({
            title,
            subtitle: `전체 채팅 ${messages.length}개 메시지를 바탕으로 재구성`,
            author: String(user.nickname || user.name || "로컬 사용자"),
            chapters,
          });
          send({
            type: "done",
            percent: 100,
            filename: safeNovelFilename(title),
            pdfBase64: pdf.toString("base64"),
            chapters: chapters.length,
            sourceMessages: messages.length,
          });
          controller.close();
        } catch (error) {
          if (!jobAbort.signal.aborted) {
            const message = error instanceof Error ? error.message : String(error || "소설 PDF 생성 실패");
            send({ type: "error", error: message });
            controller.close();
          } else {
            try {
              controller.close();
            } catch {}
          }
        } finally {
          activeExports.delete(chatId);
          req.signal.removeEventListener("abort", abortFromRequest);
        }
      })();
    },
    cancel() {
      jobAbort.abort("novel-export-stream-cancelled");
      activeExports.delete(chatId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
