import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { attachSessionCookie, getSessionUser, signSession } from "@/lib/auth";
import { getUserByEmail, setUserImageByEmail } from "@/lib/db";

export const runtime = "nodejs";

function safeExtFromType(type: string) {
  const t = (type || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("webp")) return "webp";
  return "";
}

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ ok: false, error: "invalid_form" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "file_required" }, { status: 400 });
  }

  // 2MB 제한
  const maxBytes = 2 * 1024 * 1024;
  if (file.size <= 0 || file.size > maxBytes) {
    return NextResponse.json({ ok: false, error: "file_too_large" }, { status: 413 });
  }

  const ext = safeExtFromType(file.type);
  if (!ext) return NextResponse.json({ ok: false, error: "unsupported_type" }, { status: 415 });

  const buf = Buffer.from(await file.arrayBuffer());
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const filename = `${Date.now()}_${hash}.${ext}`;

  const uploadsDir = path.join(process.cwd(), "public", "uploads", "profile");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const abs = path.join(uploadsDir, filename);
  fs.writeFileSync(abs, buf);

  const url = `/uploads/profile/${filename}`;
  setUserImageByEmail(session.email, url);

  // 세션도 갱신해서 즉시 반영
  const dbUser = getUserByEmail(session.email);
  const jwt = await signSession({
    email: session.email,
    name: dbUser?.name ?? session.name ?? null,
    picture: (dbUser as any)?.image ?? (dbUser as any)?.picture ?? session.picture ?? null,
    nickname: dbUser?.nickname ?? session.nickname ?? null,
  });

  const res = NextResponse.json({ ok: true, url });
  await attachSessionCookie(res, jwt);
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
