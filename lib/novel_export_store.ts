import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { chooseGeneratedNovelTitle, safeNovelFilename, type NovelChapter, type NovelSourceChunk } from "@/lib/novel_export";

export type NovelExportRecord = {
  version: 1;
  id: string;
  chatId: string;
  ownerEmail: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  lastDownloadedAt?: number;
  status: "running" | "paused" | "completed" | "failed";
  error?: string;
  chunks: NovelSourceChunk[];
  chapters: NovelChapter[];
  sourceMessages: number;
};

export type NovelExportHistoryItem = {
  id: string;
  title: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
  lastDownloadedAt?: number;
  status: NovelExportRecord["status"] | "pausing";
  completedChapters: number;
  totalChapters: number;
  error?: string;
};

export function novelExportScope(ownerEmail: string, chatId: string) {
  return createHash("sha256").update(JSON.stringify([ownerEmail, chatId])).digest("hex");
}

export function novelExportFilename(record: NovelExportRecord) {
  const filename = safeNovelFilename(chooseGeneratedNovelTitle(record.chapters));
  return record.chapters.length < record.chunks.length
    ? filename.replace(/\.pdf$/u, `-1-${record.chapters.length}장.pdf`)
    : filename;
}

function validateRecord(record: NovelExportRecord) {
  if (!record || record.version !== 1 || !Array.isArray(record.chunks) || !record.chunks.length ||
      !Array.isArray(record.chapters) || record.chapters.length > record.chunks.length ||
      !record.chunks.every((chunk, i) => chunk.index === i + 1 && typeof chunk.source === "string") ||
      !record.chapters.every((chapter, i) => chapter.index === i + 1 &&
        typeof chapter.title === "string" && typeof chapter.body === "string" &&
        chapter.startTurn === record.chunks[i].startTurn && chapter.endTurn === record.chunks[i].endTurn)) {
    throw new Error("소설 저장 기록이 손상되었습니다. 기존 파일은 보존했습니다.");
  }
  return record;
}

export function createNovelExportStore(
  root = path.join(process.cwd(), "data", "novel-exports"),
  codec = { encode: encryptIfPossible, decode: decryptIfPossible }
) {
  const directory = (ownerEmail: string, chatId: string) => path.join(root, novelExportScope(ownerEmail, chatId));
  const filename = (ownerEmail: string, chatId: string, id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error("올바르지 않은 소설 저장 기록 ID입니다.");
    }
    return path.join(directory(ownerEmail, chatId), `${id}.json`);
  };
  const load = (ownerEmail: string, chatId: string, id: string): NovelExportRecord | null => {
    const file = filename(ownerEmail, chatId, id);
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const record = validateRecord(JSON.parse(codec.decode(raw)));
    if (record.id !== id || record.chatId !== chatId || record.ownerEmail !== ownerEmail) {
      throw new Error("소설 저장 기록의 소유자가 일치하지 않습니다.");
    }
    return record;
  };
  const save = (record: NovelExportRecord) => {
    validateRecord(record);
    const file = filename(record.ownerEmail, record.chatId, record.id);
    const previous = load(record.ownerEmail, record.chatId, record.id);
    // A PDF download may finish while a chapter is being generated.
    record.lastDownloadedAt = Math.max(previous?.lastDownloadedAt || 0, record.lastDownloadedAt || 0) || undefined;
    record.updatedAt = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, codec.encode(JSON.stringify(record)), "utf8");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return record;
  };
  return {
    load,
    save,
    create(input: Pick<NovelExportRecord, "chatId" | "ownerEmail" | "author" | "chunks" | "sourceMessages">) {
      return save({ ...input, version: 1, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), status: "paused", chapters: [] });
    },
    list(ownerEmail: string, chatId: string) {
      const dir = directory(ownerEmail, chatId);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
        .map((name) => load(ownerEmail, chatId, name.slice(0, -5))!)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

export const novelExportStore = createNovelExportStore();
