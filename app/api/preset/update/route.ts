// app/api/preset/update/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";

type AnyRow = Record<string, any>;

function hasOwn(obj: any, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeJsonArrayString(raw: any, fieldName: string): { ok: true; value: string } | { ok: false; error: string } {
  // DB에는 string(JSON)로 저장. 업데이트 시에도 string을 유지.
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, value: "[]" };
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: `${fieldName} must be a JSON array` };
    }
    return { ok: true, value: s };
  } catch {
    return { ok: false, error: `${fieldName} must be valid JSON` };
  }
}

function normalizeRosterValue(raw: any): { ok: true; value: string } | { ok: false; error: string } {
  // Accept string(JSON) | string("a,b") | string("a\n b") | string[]
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .slice(0, 200);
    return { ok: true, value: JSON.stringify(Array.from(new Set(cleaned))) };
  }

  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, value: "[]" };

  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) return { ok: false, error: "memoryRoster must be a JSON array" };
      const cleaned = parsed
        .map((v) => String(v || "").trim())
        .filter(Boolean)
        .slice(0, 200);
      return { ok: true, value: JSON.stringify(Array.from(new Set(cleaned))) };
    } catch {
      return { ok: false, error: "memoryRoster must be valid JSON" };
    }
  }

  const parts = s
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 200);
  return { ok: true, value: JSON.stringify(Array.from(new Set(parts))) };
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const isAdmin = isAdminEmail(u.email);

  try {
    const body: AnyRow = await req.json();
    const id = String(body?.id || "").trim();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    // ✅ 먼저 현재 값을 읽어두고, body에 해당 키가 없으면 기존 값을 유지한다.
    const current = isAdmin
      ? (db.prepare(`SELECT * FROM presets WHERE id=?`).get(id) as AnyRow | undefined)
      : (db.prepare(`SELECT * FROM presets WHERE id=? AND userEmail=?`).get(id, u.email) as AnyRow | undefined);

    if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

    const name = hasOwn(body, "name") ? String(body?.name ?? "") : String(current.name ?? "");
    const background = hasOwn(body, "background") ? String(body?.background ?? "") : String(current.background ?? "");
    const characterName = hasOwn(body, "characterName") ? String(body?.characterName ?? "") : String(current.characterName ?? "");
    const characterAge = hasOwn(body, "characterAge") ? Number(body?.characterAge ?? 0) : Number(current.characterAge ?? 0);
    const character = hasOwn(body, "character") ? String(body?.character ?? "") : String(current.character ?? "");
    const systemPrompt = hasOwn(body, "systemPrompt") ? String(body?.systemPrompt ?? "") : String(current.systemPrompt ?? "");

    const image = hasOwn(body, "image") ? String(body?.image ?? "") : String(current.image ?? "");
    const tags = hasOwn(body, "tags") ? String(body?.tags ?? "") : String(current.tags ?? "");

    const targetRaw = hasOwn(body, "target") ? String(body?.target ?? "all") : String(current.target ?? "all");
    const target = targetRaw === "male" || targetRaw === "female" || targetRaw === "all" ? targetRaw : String(current.target ?? "all");

    // JSON string fields: validate only if provided
    let gallery = String(current.gallery ?? "[]");
    if (hasOwn(body, "gallery")) {
      const n = normalizeJsonArrayString(body?.gallery, "gallery");
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      gallery = n.value;
    }

    let firstMessages = String(current.firstMessages ?? "[]");
    if (hasOwn(body, "firstMessages")) {
      const n = normalizeJsonArrayString(body?.firstMessages, "firstMessages");
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      firstMessages = n.value;
    }

    let lorebooks = String(current.lorebooks ?? "[]");
    if (hasOwn(body, "lorebooks")) {
      const n = normalizeJsonArrayString(body?.lorebooks, "lorebooks");
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      lorebooks = n.value;
    }

    let memoryRoster = String((current as any).memoryRoster ?? "[]");
    if (hasOwn(body, "memoryRoster")) {
      const n = normalizeRosterValue((body as any)?.memoryRoster);
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      memoryRoster = n.value;
    }

    const isPublic = hasOwn(body, "isPublic")
      ? (body?.isPublic === 0 || body?.isPublic === false ? 0 : 1)
      : (current.isPublic === 0 || current.isPublic === false ? 0 : 1);

    const isNsfw = hasOwn(body, "isNsfw")
      ? (body?.isNsfw === 1 || body?.isNsfw === true ? 1 : 0)
      : (current.isNsfw === 1 || current.isNsfw === true ? 1 : 0);

    if (isAdmin) {
      db.prepare(
        `UPDATE presets
         SET name=?, background=?, characterName=?, characterAge=?, character=?, systemPrompt=?,
             image=?, tags=?, target=?, gallery=?, firstMessages=?, lorebooks=?, memoryRoster=?, isPublic=?, isNsfw=?
         WHERE id=?`
      ).run(
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
        isPublic,
        isNsfw,
        id
      );
    } else {
      db.prepare(
        `UPDATE presets
         SET name=?, background=?, characterName=?, characterAge=?, character=?, systemPrompt=?,
             image=?, tags=?, target=?, gallery=?, firstMessages=?, lorebooks=?, memoryRoster=?, isPublic=?, isNsfw=?
         WHERE id=? AND userEmail=?`
      ).run(
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
        isPublic,
        isNsfw,
        id,
        u.email
      );
    }

    const preset = isAdmin
      ? db.prepare(`SELECT * FROM presets WHERE id=?`).get(id)
      : db.prepare(`SELECT * FROM presets WHERE id=? AND userEmail=?`).get(id, u.email);

    return NextResponse.json({ preset });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}
