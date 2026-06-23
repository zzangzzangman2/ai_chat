import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";
import crypto from "crypto";

export async function GET(req: Request) {
  const u = await getSessionUser();
  const email = String(u?.email || "").trim();
  const isAdmin = isAdminEmail(email);
  const { searchParams } = new URL(req.url);
  const scope = String(searchParams.get("scope") || "").toLowerCase();

  // Legacy endpoint hardening:
  // - default: public presets only
  // - scope=mine: own presets (admin can see all)
  // - scope=all: admin only
  type PresetRow = Record<string, unknown>;
  let rows: PresetRow[] = [];
  if (scope === "all" && isAdmin) {
    rows = db.prepare("SELECT * FROM presets ORDER BY createdAt DESC").all() as PresetRow[];
  } else if (scope === "mine") {
    if (!email) return NextResponse.json([]);
    if (isAdmin) {
      rows = db.prepare("SELECT * FROM presets ORDER BY createdAt DESC").all() as PresetRow[];
    } else {
      rows = db
        .prepare(
          `SELECT * FROM presets
           WHERE COALESCE(NULLIF(userEmail,''), NULLIF(ownerEmail,''), '') = ?
           ORDER BY createdAt DESC`
        )
        .all(email) as PresetRow[];
    }
  } else {
    rows = db
      .prepare(
        `SELECT * FROM presets
         WHERE COALESCE(isPublic, 1) = 1
         ORDER BY createdAt DESC`
      )
      .all() as PresetRow[];
  }
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const ownerEmail = String(u.email || "").trim();
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  const name = String(body.name ?? "").trim();
  const background = String(body.background ?? "");
  const character = String(body.character ?? "");
  const systemPrompt = String(body.systemPrompt ?? "");

  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  db.prepare(
    `INSERT INTO presets (id, ownerEmail, userEmail, name, background, character, systemPrompt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ownerEmail, ownerEmail, name, background, character, systemPrompt, createdAt);

  const row = db.prepare("SELECT * FROM presets WHERE id=?").get(id);
  return NextResponse.json(row);
}
