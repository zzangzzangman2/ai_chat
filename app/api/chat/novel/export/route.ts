import { db } from "@/lib/db";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { decryptIfPossible } from "@/lib/crypto";
import { generateText, isRefusalText } from "@/lib/ai";
import { GEMINI_4_ARGON_MODEL } from "@/lib/models";
import {
  buildNovelSourceChunks,
  buildNovelChapterPrompt,
  buildNovelSystemPrompt,
  chooseGeneratedNovelTitle,
  collectNovelCharacters,
  NOVEL_CHAPTER_RESPONSE_SCHEMA,
  parseGeneratedNovelChapter,
  type NovelSourceMessage,
} from "@/lib/novel_export";
import { buildNovelPdf } from "@/lib/novel_pdf";
import { novelExportStore, novelExportScope, novelExportFilename, type NovelExportRecord, type NovelExportHistoryItem } from "@/lib/novel_export_store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

type ActiveExport = { id: string; abort: AbortController; pauseRequested: boolean };
// Keep controls connected to an in-flight request across development hot reloads.
const runtimeState = globalThis as typeof globalThis & { __arcaNovelExports?: Map<string, ActiveExport> };
const activeExports = runtimeState.__arcaNovelExports ??= new Map<string, ActiveExport>();

type NovelChatRow = {
  id: string;
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

async function authorize(req: Request, chatId: string): Promise<{ user: SessionUser; response?: never } | { response: Response; user?: never }> {
  if (!isLocalRequest(req)) {
    return { response: Response.json({ error: "소설 PDF 만들기는 로컬에서만 사용할 수 있습니다." }, { status: 403 }) };
  }
  const user = await getSessionUser();
  if (!user) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  if (!chatId) return { response: Response.json({ error: "chatId가 필요합니다." }, { status: 400 }) };
  const chat = db
    .prepare(
      `SELECT c.id
         FROM chats c
        WHERE c.id=? AND c.userEmail=?`
    )
    .get(chatId, user.email) as NovelChatRow | undefined;
  if (!chat) return { response: Response.json({ error: "채팅을 찾지 못했습니다." }, { status: 404 }) };
  return { user };
}

function historyItem(record: NovelExportRecord): NovelExportHistoryItem {
  const active = activeExports.get(novelExportScope(record.ownerEmail, record.chatId));
  const running = active?.id === record.id;
  return {
    id: record.id,
    title: record.chapters.length ? chooseGeneratedNovelTitle(record.chapters) : "작성 중인 소설",
    filename: novelExportFilename(record),
    createdAt: record.createdAt, updatedAt: record.updatedAt, lastDownloadedAt: record.lastDownloadedAt,
    status: running ? (active.pauseRequested ? "pausing" : "running")
      : record.chapters.length === record.chunks.length ? "completed"
      : record.status === "running" ? "paused" : record.status,
    completedChapters: record.chapters.length, totalChapters: record.chunks.length,
    error: record.error,
  };
}

function renderSavedPdf(record: NovelExportRecord) {
  return buildNovelPdf({
    title: chooseGeneratedNovelTitle(record.chapters), author: record.author,
    chapters: record.chapters, introduction: record.chapters[0]?.introduction,
    characters: collectNovelCharacters(record.chapters), generatedAt: new Date(record.createdAt),
  });
}

function markDownloaded(record: NovelExportRecord) {
  const latest = novelExportStore.load(record.ownerEmail, record.chatId, record.id)!;
  novelExportStore.save({ ...latest, lastDownloadedAt: Date.now() });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chatId = String(url.searchParams.get("chatId") || "").trim();
  const auth = await authorize(req, chatId);
  if (auth.response) return auth.response;
  try {
    if (url.searchParams.get("download") === "1") {
      const record = novelExportStore.load(auth.user.email, chatId, url.searchParams.get("exportId") || "");
      if (!record) return Response.json({ error: "저장 기록을 찾지 못했습니다." }, { status: 404 });
      if (!record.chapters.length) return Response.json({ error: "아직 완성된 장이 없습니다." }, { status: 409 });
      const pdf = await renderSavedPdf(record);
      markDownloaded(record);
      return new Response(new Uint8Array(pdf), { headers: {
        "Content-Type": "application/pdf", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(novelExportFilename(record))}`,
      } });
    }
    return Response.json({ exports: novelExportStore.list(auth.user.email, chatId).map(historyItem) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "소설 기록을 읽지 못했습니다." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const chatId = String(body?.chatId || "").trim();
  const auth = await authorize(req, chatId);
  if (auth.response) return auth.response;
  const user = auth.user;
  const scope = novelExportScope(user.email, chatId);
  const action = String(body?.action || "start");
  if (!["start", "resume", "pause"].includes(action)) return Response.json({ error: "알 수 없는 작업입니다." }, { status: 400 });
  let record: NovelExportRecord;
  try {
    if (action === "pause") {
      const saved = novelExportStore.load(user.email, chatId, String(body?.exportId || ""));
      if (!saved) return Response.json({ error: "저장 기록을 찾지 못했습니다." }, { status: 404 });
      const active = activeExports.get(scope);
      if (active && active.id !== saved.id) return Response.json({ error: "다른 소설을 작성 중입니다." }, { status: 409 });
      if (saved.chapters.length < saved.chunks.length) {
        saved.status = "paused";
        novelExportStore.save(saved);
        if (active) {
          active.pauseRequested = true;
          active.abort.abort("novel-export-paused");
        }
      }
      return Response.json({ export: historyItem(saved) });
    }
    if (activeExports.has(scope)) return Response.json({ error: "이 채팅의 소설 PDF를 이미 만들고 있습니다." }, { status: 409 });
    if (action === "resume") {
      const saved = novelExportStore.load(user.email, chatId, String(body?.exportId || ""));
      if (!saved) return Response.json({ error: "저장 기록을 찾지 못했습니다." }, { status: 404 });
      if (saved.chapters.length === saved.chunks.length) return Response.json({ error: "이미 완성된 소설입니다. PDF 다운로드를 이용해 주세요." }, { status: 409 });
      record = saved;
    } else {
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
      if (!chunks.length) return Response.json({ error: "소설로 만들 대화가 없습니다." }, { status: 400 });
      record = novelExportStore.create({ chatId, ownerEmail: user.email,
        author: String(user.nickname || user.name || "로컬 사용자"), chunks, sourceMessages: messages.length });
    }
    record.status = "running";
    delete record.error;
    novelExportStore.save(record);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "소설 진행 기록 저장 실패" }, { status: 500 });
  }

  const chunks = record.chunks;
  const encoder = new TextEncoder();
  const jobAbort = new AbortController();
  const job: ActiveExport = { id: record.id, abort: jobAbort, pauseRequested: false };
  let clientGone = false;
  let streamOpen = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const abortFromRequest = () => {
    clientGone = true;
    jobAbort.abort("novel-export-client-left");
    stopHeartbeat();
  };
  req.signal.addEventListener("abort", abortFromRequest, { once: true });
  if (req.signal.aborted) abortFromRequest();
  activeExports.set(scope, job);

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        if (clientGone || !streamOpen) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); }
        catch { abortFromRequest(); }
      };
      let progress = {
        type: "progress", percent: 5 + Math.floor(record.chapters.length / chunks.length * 86),
        current: record.chapters.length, total: chunks.length,
        message: record.chapters.length ? `${record.chapters.length}장 불러오기 완료 · 다음 장부터 이어서 작성`
          : `전체 대화 정리 완료 · ${chunks.length}개 장 · Argon`,
      };
      let progressStartedAt = Date.now();
      const reportProgress = (next: typeof progress) => {
        progress = next;
        progressStartedAt = Date.now();
        send({ ...next, exportId: record.id, completedChapters: record.chapters.length });
      };
      // Non-streaming generation can take minutes. Keep the download connection
      // and UI alive without advancing the completed-chapter percentage.
      if (!jobAbort.signal.aborted) {
        heartbeat = setInterval(() => {
          const elapsedSeconds = Math.floor((Date.now() - progressStartedAt) / 1000);
          send({ ...progress, exportId: record.id, completedChapters: record.chapters.length,
            message: `${progress.message} · ${elapsedSeconds}초 경과` });
        }, 15000);
      }

      (async () => {
        try {
          reportProgress(progress);
          let previousTail = record.chapters.at(-1)?.body.slice(-1800) || "";
          for (const chunk of chunks.slice(record.chapters.length)) {
            if (jobAbort.signal.aborted) throw new Error("소설 만들기가 취소되었습니다.");
            const beforePercent = 5 + Math.floor(((chunk.index - 1) / chunks.length) * 86);
            reportProgress({
              type: "progress",
              percent: beforePercent,
              current: chunk.index,
              total: chunks.length,
              message: `Argon · ${chunk.index}/${chunks.length}장 원고 작성 중`,
            });
            const generated = await generateText({
              system: buildNovelSystemPrompt(),
              user: buildNovelChapterPrompt({
                chunkIndex: chunk.index,
                chunkCount: chunks.length,
                previousTail,
                source: chunk.source,
                knownCharacters: collectNovelCharacters(record.chapters).map((character) => character.name),
              }),
              opts: {
                model: GEMINI_4_ARGON_MODEL,
                maxOutputTokens: 6500,
                maxOutputTokensRequested: 6500,
                maxReasoningTokens: 128,
                temperature: 0.55,
                topP: 0.88,
                topK: 36,
                // Argon already has a provider deadline; do not cut a chapter
                // off at three minutes. User cancellation still aborts the call.
                timeoutMs: 0,
                signal: jobAbort.signal,
                responseMimeType: "application/json",
                responseJsonSchema: NOVEL_CHAPTER_RESPONSE_SCHEMA,
                disableMaxTokensFallback: true,
                disableRefusalFallback: true,
              },
            });
            if (jobAbort.signal.aborted) throw new Error("소설 만들기가 취소되었습니다.");
            const raw = String(generated?.text || "").trim();
            if (!raw) {
              throw new Error(`${chunk.index}장 원고 생성에 실패했습니다.`);
            }
            if (generated.usage?.finishReason === "MAX_TOKENS") {
              throw new Error(`${chunk.index}장 원고가 출력 한도에서 잘려 PDF 생성을 중단했습니다.`);
            }
            const chapter = parseGeneratedNovelChapter(raw, chunk);
            if (isRefusalText(chapter.body)) {
              throw new Error(`${chunk.index}장 원고 생성에 실패했습니다.`);
            }
            if (chapter.body.length < 200) {
              throw new Error(`${chunk.index}장 원고가 너무 짧아 PDF 생성을 중단했습니다.`);
            }
            record.chapters.push(chapter);
            novelExportStore.save(record);
            previousTail = chapter.body.slice(-1800);
            reportProgress({
              type: "progress",
              percent: 5 + Math.floor((chunk.index / chunks.length) * 86),
              current: chunk.index,
              total: chunks.length,
              message: `${chunk.index}/${chunks.length}장 원고 완료`,
            });
          }

          reportProgress({ type: "progress", percent: 94, current: chunks.length, total: chunks.length, message: "목차·등장인물 소개와 PDF 편집 중" });
          record.status = "completed";
          novelExportStore.save(record);
          const pdf = await renderSavedPdf(record);
          markDownloaded(record);
          send({
            type: "done",
            percent: 100,
            exportId: record.id,
            filename: novelExportFilename(record),
            pdfBase64: pdf.toString("base64"),
            chapters: record.chapters.length,
            sourceMessages: record.sourceMessages,
          });
        } catch (error) {
          const paused = job.pauseRequested || clientGone;
          let message = error instanceof Error ? error.message : String(error || "소설 PDF 생성 실패");
          record.status = record.chapters.length === chunks.length ? "completed" : paused ? "paused" : "failed";
          record.error = paused ? undefined : message;
          let saved = true;
          try { novelExportStore.save(record); }
          catch (saveError) { saved = false; message = `진행 기록 저장 실패: ${saveError instanceof Error ? saveError.message : String(saveError)}`; }
          if (paused && saved) {
            send({ type: "paused", exportId: record.id, completedChapters: record.chapters.length, total: chunks.length });
          } else {
            send({ type: "error", error: message, exportId: record.id, completedChapters: record.chapters.length });
          }
        } finally {
          stopHeartbeat();
          if (activeExports.get(scope) === job) activeExports.delete(scope);
          req.signal.removeEventListener("abort", abortFromRequest);
          if (streamOpen) { streamOpen = false; try { controller.close(); } catch {} }
        }
      })();
    },
    cancel() {
      streamOpen = false;
      clientGone = true;
      jobAbort.abort("novel-export-stream-cancelled");
      stopHeartbeat();
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
