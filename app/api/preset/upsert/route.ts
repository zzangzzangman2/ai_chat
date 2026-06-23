import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { randomUUID } from "crypto";

type Body = {
  isPublic?: number | boolean;
  isNsfw?: number | boolean;
  id?: string;
  name: string;
  background: string;
  characterName: string;
  characterAge: number;
  character: string;
  systemPrompt: string;
  memoryRoster?: string | string[];
};

function normalizeRoster(raw: any): string {
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .slice(0, 200);
    return JSON.stringify(Array.from(new Set(cleaned)));
  }
  const s = String(raw ?? "").trim();
  if (!s) return "[]";
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .slice(0, 200);
        return JSON.stringify(Array.from(new Set(cleaned)));
      }
    } catch {
      // fallthrough
    }
  }
  const parts = s
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 200);
  return JSON.stringify(Array.from(new Set(parts)));
}

function bad(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json()) as Body;

  const name = (body.name || "").trim();
  const background = (body.background || "").trim();
  const characterName = (body.characterName || "").trim();
  const characterAge = Number(body.characterAge || 0);
  const character = (body.character || "").trim();
  const systemPrompt = (body.systemPrompt || "").trim();
  const memoryRoster = normalizeRoster((body as any)?.memoryRoster);

  const isPublic = (body as any)?.isPublic === 0 || (body as any)?.isPublic === false ? 0 : 1;
  const isNsfw = (body as any)?.isNsfw === 1 || (body as any)?.isNsfw === true ? 1 : 0;

  if (!name) return bad("프리셋 이름을 적어주세요.");
  if (!background) return bad("배경을 적어주세요.");
  if (!characterName) return bad("상대방 캐릭터 이름을 적어주세요.");
  if (!Number.isFinite(characterAge) || characterAge <= 0) return bad("상대방 나이를 올바르게 적어주세요.");
  if (!character) return bad("상대방 캐릭터(성격/말투/행동 원칙)를 적어주세요.");

  const now = Date.now();
  const id = body.id?.trim() || randomUUID();

  // NOTE: query has only 1 placeholder
  const exists = db.prepare(`SELECT 1 FROM presets WHERE id = ?`).get(id);

  if (exists) {
    db.prepare(
      `UPDATE presets
       SET name=?, background=?, characterName=?, characterAge=?, character=?, systemPrompt=?, memoryRoster=?, isPublic=?, isNsfw=?
       WHERE id=? AND userEmail=?`
    ).run(name, background, characterName, characterAge, character, systemPrompt, memoryRoster, isPublic, isNsfw, id, u.email);
  } else {
    db.prepare(
      `INSERT INTO presets (id, userEmail, name, background, characterName, characterAge, character, systemPrompt, memoryRoster, createdAt, isPublic, isNsfw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, u.email, name, background, characterName, characterAge, character, systemPrompt, memoryRoster, now, isPublic, isNsfw);
  }

  const preset = db
    .prepare(
      `SELECT id, name, background, characterName, characterAge, character, systemPrompt, memoryRoster, createdAt, COALESCE(isPublic,1) AS isPublic, COALESCE(isNsfw,0) AS isNsfw
       FROM presets WHERE id=? AND userEmail=?`
    )
    .get(id, u.email);

  return NextResponse.json({ preset });
}

