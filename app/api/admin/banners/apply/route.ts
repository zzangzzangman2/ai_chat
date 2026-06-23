import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

// Publish draft banners (table: banners) into live banners (table: banners_live).
// The homepage reads ONLY from banners_live, so changes are reflected only after this endpoint is called.
export async function POST() {
  const u = await getSessionUser();
  if (!u?.email || !isAdminEmail(u.email)) return unauthorized();

  try {
    const tx = db.transaction(() => {
      db.exec(`DELETE FROM banners_live`);
      db.exec(`
        INSERT INTO banners_live (imageUrl, linkUrl, isActive, sortOrder, createdAt)
        SELECT imageUrl, linkUrl, isActive, sortOrder, createdAt
        FROM banners
        WHERE isActive = 1
        ORDER BY sortOrder ASC, createdAt DESC
      `);
    });
    tx();
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "apply failed" }, { status: 500 });
  }
}
