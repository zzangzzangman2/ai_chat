import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * next-auth is intentionally NOT used in this project.
 *
 * This file remains only to prevent accidental 404 routing differences
 * (some earlier branches referenced /api/auth/* patterns).
 *
 * If anything calls this endpoint, return a clear error.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: "next-auth is not enabled in this project. Use /api/auth/google and /api/auth/callback.",
    },
    { status: 410 }
  );
}

export async function POST() {
  return GET();
}
