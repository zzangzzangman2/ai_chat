import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

type RowAny = Record<string, any>;

function getCols(table: string) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return new Set((cols || []).map((c) => String(c?.name || "")));
  } catch {
    return new Set<string>();
  }
}

function pickCol(cols: Set<string>, candidates: string[], fallback: string) {
  for (const c of candidates) if (cols.has(c)) return c;
  return fallback;
}

export async function GET(req: Request) {
  try {
    const u = await getSessionUser();
    if (!u?.email) return NextResponse.json({ items: [] }, { status: 200 });

    const { searchParams } = new URL(req.url);
    const limitRaw = Number(searchParams.get("limit") || 5);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(30, limitRaw)) : 5;

    const cols = getCols("chats");

    // Flexible column mapping
    const emailCol = pickCol(cols, ["userEmail", "user_email", "email", "ownerEmail", "owner_email"], "userEmail");
    const presetCol = pickCol(cols, ["presetId", "preset_id", "presetID"], "presetId");
    const titleCol = pickCol(cols, ["title", "chatTitle", "name"], "title");
    const createdCol = pickCol(cols, ["createdAt", "created_at", "created"], "createdAt");

    const updatedCandidate = pickCol(
      cols,
      ["updatedAt", "updated_at", "lastUpdatedAt", "last_updated_at"],
      "__NONE__"
    );
    const hasUpdated = updatedCandidate !== "__NONE__";
    const updatedCol = hasUpdated ? updatedCandidate : createdCol;

    // IMPORTANT: don't reference a non-existent column in SQL
    const tsExpr = hasUpdated ? `COALESCE(${updatedCol}, ${createdCol})` : `${createdCol}`;

    // 1) Get a pool of recent chats (bigger than limit), then 2) de-dupe by preset key in JS.
    const pool = Math.min(200, Math.max(30, limit * 10));
    const sql = `
      SELECT id,
             ${presetCol} AS presetId,
             ${titleCol} AS title,
             ${tsExpr} AS updatedAt
      FROM chats
      WHERE ${emailCol} = ?
      ORDER BY ${tsExpr} DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(u.email, pool) as RowAny[];

    const seen = new Set<string>();
    const items: {
      id: string;
      presetId: string | null;
      title: string;
      updatedAt: string | null;
      createdAt: number | null;
      presetName?: string;
      image?: string;
    }[] = [];

    for (const r of rows || []) {
      const pid = r.presetId ?? null;
      const key = pid ? String(pid) : `__chat__${String(r.id)}`; // presetId 없으면 채팅 단위로라도 노출
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: String(r.id),
        presetId: pid ? String(pid) : null,
        title: r.title ? String(r.title) : "채팅",
        updatedAt: r.updatedAt ? String(r.updatedAt) : null,
        createdAt: r.updatedAt ? Number(r.updatedAt) : null,
      });
      if (items.length >= limit) break;
    }

    // --- Enrich with preset name / image (work cover) ---
    // presets table columns are stable in this project, but keep it defensive.
    const pcols = getCols("presets");
    const pidCol = pickCol(pcols, ["id"], "id");
    const pNameCol = pickCol(pcols, ["name"], "name");
    const pCharNameCol = pickCol(pcols, ["characterName", "character_name"], "characterName");
    const pImageCol = pickCol(pcols, ["image", "imageUrl", "image_url", "coverImage", "cover_image"], "image");
    const pEmailCol = pickCol(pcols, ["userEmail", "user_email", "email", "ownerEmail", "owner_email"], "userEmail");

    const presetIds = Array.from(
      new Set(items.map((it) => (it.presetId ? String(it.presetId) : "")).filter(Boolean))
    );

    if (presetIds.length) {
      const placeholders = presetIds.map(() => "?").join(",");
      const psql = `
        SELECT ${pidCol} AS id,
               ${pNameCol} AS name,
               ${pCharNameCol} AS characterName,
               ${pImageCol} AS image
        FROM presets
        WHERE ${pEmailCol} = ? AND ${pidCol} IN (${placeholders})
      `;
      const prows = db.prepare(psql).all(u.email, ...presetIds) as RowAny[];
      const byId = new Map<string, { presetName: string; image: string | undefined }>();
      for (const pr of prows || []) {
        const id = String(pr.id);
        const nm = String(pr.name || "").trim();
        const cn = String(pr.characterName || "").trim();
        const presetName = nm || cn || "작품";
        const image = pr.image ? String(pr.image) : undefined;
        byId.set(id, { presetName, image });
      }

      for (const it of items) {
        if (!it.presetId) continue;
        const meta = byId.get(String(it.presetId));
        if (!meta) continue;
        it.presetName = meta.presetName;
        it.image = meta.image;
        // Prefer displaying the work name instead of generic "채팅".
        if (!it.title || it.title === "채팅") it.title = meta.presetName;
      }
    }

    return NextResponse.json({ items }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ items: [], error: String(e?.message || e) }, { status: 200 });
  }
}
