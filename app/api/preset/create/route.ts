// app/api/preset/create/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { randomUUID } from "crypto";

function normalizeRoster(raw: any): string {
  // Store as JSON array string.
  // Accept: undefined | string(JSON) | string("a,b") | string("a\n b") | string[]
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .slice(0, 200);
    return JSON.stringify(Array.from(new Set(cleaned)));
  }

  const s = String(raw ?? "").trim();
  if (!s) return "[]";

  // If it's already JSON, honor it.
  if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith('"') && s.endsWith('"'))) {
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

  // Fallback: split by comma/newline.
  const parts = s
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 200);
  return JSON.stringify(Array.from(new Set(parts)));
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await req.json();
    const now = Date.now();
    const id = randomUUID();

    const name = String(body?.name || "새 프리셋");
    const background = String(body?.background || "");
    const characterName = String(body?.characterName || "상대");
    const characterAge = Number(body?.characterAge || 0);
    const character = String(body?.character || "");
    const systemPrompt = String(body?.systemPrompt || "");

    const image = String(body?.image || "");
    const tags = String(body?.tags || "");
    const target = String(body?.target || "all");
    const isPublic = body?.isPublic === 0 || body?.isPublic === false ? 0 : 1;
    const isNsfw = body?.isNsfw === 1 || body?.isNsfw === true ? 1 : 0;
    const gallery = String(body?.gallery || "[]");
    const firstMessages = String(body?.firstMessages || "[]");
    const lorebooks = String(body?.lorebooks || "[]");
    const memoryRoster = normalizeRoster(body?.memoryRoster);

    db.prepare(
      `INSERT INTO presets (
          id, userEmail, name, background, characterName, characterAge, character, systemPrompt,
          image, tags, target, gallery, firstMessages, lorebooks, memoryRoster,
          createdAt, isPublic, isNsfw
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      u.email,
      name,
      background,
      characterName,
      characterAge,
      character,
      systemPrompt,
      image,
      tags,
      target,
      gallery,
      firstMessages,
      lorebooks,
      memoryRoster,
      now,
      isPublic,
      isNsfw
    );

    return NextResponse.json({
      preset: {
        id,
        name,
        background,
        characterName,
        characterAge,
        character,
        systemPrompt,
        image,
        tags,
        memoryRoster,
        target,
        gallery,
        firstMessages,
        lorebooks,
        createdAt: now,
        isPublic,
        isNsfw,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}

