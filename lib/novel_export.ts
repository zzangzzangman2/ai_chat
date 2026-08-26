export type NovelSourceMessage = {
  id?: string;
  role: string;
  content: string;
  createdAt?: number;
};

export type NovelSourceChunk = {
  index: number;
  startTurn: number;
  endTurn: number;
  source: string;
};

export type NovelChapter = {
  index: number;
  title: string;
  body: string;
  startTurn: number;
  endTurn: number;
};

function plain(value: unknown) {
  return String(value || "").replace(/\r\n?/g, "\n");
}

export function cleanNovelSourceText(value: unknown) {
  return plain(value)
    .replace(/```[^\n]*\n[\s\S]*?```/g, "")
    .replace(/```[\s\S]*$/g, "")
    .replace(/\{\{img:[^}]+\}\}/g, "")
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, "")
    .replace(/<table[\s\S]*?<\/table>/gi, "")
    .replace(/<<<END_OF_OUTPUT>>>/g, "")
    .replace(/^\s*(?:상태|STATUS|INFO)\s*[:：].*$/gimu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function roleLabel(role: string) {
  return String(role || "").toLowerCase() === "user" ? "주인공 원문" : "서사 원문";
}

export function buildNovelSourceChunks(
  messages: NovelSourceMessage[],
  options: { maxChars?: number; maxUserTurns?: number } = {}
) {
  const maxChars = Math.max(6000, Math.floor(Number(options.maxChars || 28000)));
  const maxUserTurns = Math.max(4, Math.floor(Number(options.maxUserTurns || 24)));
  const turnGroups: Array<{ turn: number; hasUser: boolean; pieces: string[] }> = [];
  let completedTurns = 0;

  for (const message of messages || []) {
    const role = String(message?.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant" && role !== "model") continue;
    const content = cleanNovelSourceText(message?.content);
    if (!content) continue;
    if (role === "user") {
      completedTurns += 1;
      turnGroups.push({
        turn: completedTurns,
        hasUser: true,
        pieces: [`[${roleLabel(role)} · ${completedTurns}턴]\n${content}`],
      });
      continue;
    }
    const turn = Math.max(1, completedTurns);
    const piece = `[${roleLabel(role)} · ${turn}턴]\n${content}`;
    const current = turnGroups[turnGroups.length - 1];
    if (current && current.turn === turn) current.pieces.push(piece);
    else turnGroups.push({ turn, hasUser: false, pieces: [piece] });
  }

  const chunks: NovelSourceChunk[] = [];
  let groups: Array<{ turn: number; hasUser: boolean; source: string }> = [];
  let chars = 0;
  let userTurns = 0;

  const flush = () => {
    const source = groups.map((group) => group.source).join("\n\n").trim();
    if (!source) return;
    chunks.push({
      index: chunks.length + 1,
      startTurn: groups[0]?.turn || 1,
      endTurn: groups[groups.length - 1]?.turn || 1,
      source,
    });
    groups = [];
    chars = 0;
    userTurns = 0;
  };

  for (const group of turnGroups) {
    const source = group.pieces.join("\n\n");
    const wouldOverflow =
      groups.length > 0 &&
      (chars + source.length + 2 > maxChars || (group.hasUser && userTurns >= maxUserTurns));
    if (wouldOverflow) flush();
    groups.push({ turn: group.turn, hasUser: group.hasUser, source });
    chars += source.length + 2;
    if (group.hasUser) userTurns += 1;
  }
  flush();

  // Avoid a tiny epilogue call when it comfortably fits in the preceding part.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const previous = chunks[chunks.length - 2];
    if (last.source.length < 3500 && previous.source.length + last.source.length < maxChars * 1.15) {
      previous.source = `${previous.source}\n\n${last.source}`;
      previous.endTurn = last.endTurn;
      chunks.pop();
    }
  }

  return chunks.map((chunk, index) => ({ ...chunk, index: index + 1 }));
}

function stripGeneratedDecorations(value: unknown) {
  return plain(value)
    .replace(/^```(?:text|markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/<<<END_OF_OUTPUT>>>/g, "")
    .trim();
}

export function parseGeneratedNovelChapter(
  value: unknown,
  source: Pick<NovelSourceChunk, "index" | "startTurn" | "endTurn">
): NovelChapter {
  const text = stripGeneratedDecorations(value);
  const lines = text.split(/\r?\n/);
  const firstNonBlank = lines.findIndex((line) => line.trim());
  let title = `제 ${source.index}화`;
  if (firstNonBlank >= 0) {
    const candidate = lines[firstNonBlank]
      .replace(/^#{1,6}\s*/, "")
      .replace(/^제\s*\d+\s*화\s*[:：\-]?\s*/u, "")
      .trim();
    if (candidate && candidate.length <= 60) {
      title = `제 ${source.index}화 ${candidate}`.trim();
      lines.splice(firstNonBlank, 1);
    }
  }
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    index: source.index,
    title,
    body,
    startTurn: source.startTurn,
    endTurn: source.endTurn,
  };
}

export function safeNovelFilename(value: unknown) {
  const base = String(value || "소설")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "소설";
  return `${base}-웹소설.pdf`;
}
