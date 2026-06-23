import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail, isLocalAuthEnabled } from "@/lib/auth";

export async function GET(request: Request) {
  // 프리셋 목록
  // - scope=mine: (작업실) 로그인 => 내 프리셋(공개/비공개) / 비로그인 => []
  // - 기본: (작품 선택/홈) 비로그인 => 공개 프리셋만
  // - 기본: (작품 선택/홈) 로그인   => 공개 프리셋만 (요청사항: 비공개는 제작자 포함 누구에게도 노출하지 않음)
  const url = new URL(request.url);
  const scope = (url.searchParams.get("scope") || "").toLowerCase();
  const view = (url.searchParams.get("view") || "").toLowerCase();

  const u = await getSessionUser();
  const email = u?.email ?? "";
  const isLocal = isLocalAuthEnabled();
  const isAdmin = isAdminEmail(email);

  if (scope === "mine") {
    if (!email) return NextResponse.json({ presets: [] });
    const rows = isAdmin || isLocal
      ? db
          .prepare(
            `SELECT
              id, name, background, characterName, characterAge, character, systemPrompt,
              image, tags, memoryRoster, target, gallery, firstMessages, lorebooks, createdAt,
              COALESCE(userEmail,'') AS userEmail,
              COALESCE(isPublic,1) AS isPublic,
              COALESCE(isNsfw,0) AS isNsfw
            FROM presets
            ORDER BY createdAt DESC`
          )
          .all()
      : db
          .prepare(
            `SELECT
              id, name, background, characterName, characterAge, character, systemPrompt,
              image, tags, memoryRoster, target, gallery, firstMessages, lorebooks, createdAt,
              COALESCE(userEmail,'') AS userEmail,
              COALESCE(isPublic,1) AS isPublic,
              COALESCE(isNsfw,0) AS isNsfw
            FROM presets
            WHERE COALESCE(userEmail,'') = ?
            ORDER BY createdAt DESC`
          )
          .all(email);
    return NextResponse.json({ presets: rows });
  }

  // 기본(홈/작품선택)
  // 요청사항: 비공개 작품은 "작품 리스트(홈/작품선택)"에서 누구에게도 보이지 않게.
  // - 제작자(로그인)도 포함
  // - 관리자는 필요 시 작업실(scope=mine)에서 확인 가능
  const rows =
    isLocal
      ? db
          .prepare(
            `SELECT
              id, name, background, characterName,
              SUBSTR(COALESCE(character,''), 1, 800) AS character,
              image, tags, target, createdAt,
              COALESCE(userEmail,'') AS userEmail,
              COALESCE(isPublic,1) AS isPublic,
              COALESCE(isNsfw,0) AS isNsfw
            FROM presets
            ORDER BY createdAt DESC`
          )
          .all()
      : view === "home"
      ? db
          .prepare(
            `SELECT
              id, name, background, characterName,
              SUBSTR(COALESCE(character,''), 1, 800) AS character,
              image, tags, target, createdAt,
              COALESCE(userEmail,'') AS userEmail,
              COALESCE(isPublic,1) AS isPublic,
              COALESCE(isNsfw,0) AS isNsfw
            FROM presets
            WHERE COALESCE(isPublic,1) = 1
            ORDER BY createdAt DESC`
          )
          .all()
      : db
          .prepare(
            `SELECT
              id, name, background, characterName, characterAge, character, systemPrompt,
              image, tags, memoryRoster, target, gallery, firstMessages, lorebooks, createdAt,
              COALESCE(userEmail,'') AS userEmail,
              COALESCE(isPublic,1) AS isPublic,
              COALESCE(isNsfw,0) AS isNsfw
            FROM presets
            WHERE COALESCE(isPublic,1) = 1
            ORDER BY createdAt DESC`
          )
          .all();

  if (view === "home") {
    return NextResponse.json(
      { presets: rows },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  }
  return NextResponse.json({ presets: rows });
}
