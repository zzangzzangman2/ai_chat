import { NextResponse } from "next/server";
import { getSessionUser, isAdminEmail } from "@/lib/auth";
import path from "path";
import fs from "fs/promises";

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u?.email || !isAdminEmail(u.email)) return unauthorized();

  const form = await req.formData();
  const file = form.get("file");
  const linkUrl = String(form.get("linkUrl") || "").trim();

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  // file is Blob
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = (() => {
    const name = (file as any).name ? String((file as any).name) : "";
    const m = name.match(/\.(png|jpg|jpeg|webp|gif)$/i);
    if (m) return "." + m[1].toLowerCase();
    // fallback to mime
    const type = (file as any).type ? String((file as any).type) : "";
    if (type.includes("png")) return ".png";
    if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
    if (type.includes("webp")) return ".webp";
    if (type.includes("gif")) return ".gif";
    return ".png";
  })();

  const fileName = `banner_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;

  // IMPORTANT:
  // relDir must NOT start with '/' when joining filesystem paths.
  // If it starts with '/', path.join() treats it as absolute and drops "public".
  // We still return a URL that *does* start with '/'.
  const relDirFs = path.join("uploads", "banners");
  const absDir = path.join(process.cwd(), "public", relDirFs);
  await fs.mkdir(absDir, { recursive: true });

  const absPath = path.join(absDir, fileName);
  await fs.writeFile(absPath, buf);

  const url = `/uploads/banners/${fileName}`;
  return NextResponse.json({ ok: true, imageUrl: url, linkUrl });
}
