"use client";

import React, { useCallback, useEffect, useState } from "react";

type MeUser = {
  email: string;
  nickname?: string | null;
  name?: string;
  picture?: string;
};

export default function NicknamePage() {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [nick, setNick] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      const u = (j?.user ?? null) as MeUser | null;
      setUser(u);
      const hasNick = !!String(u?.nickname ?? "").trim();
      if (u && hasNick) {
        // 이미 설정돼 있으면 홈으로
        window.location.replace("/");
        return;
      }

      // 기본 닉네임 추천(가능하면 personaName 1개)
      try {
        const pr = await fetch("/api/profile", { cache: "no-store" });
        const pj = await pr.json().catch(() => ({}));
        const first = Array.isArray(pj?.profiles) ? pj.profiles[0] : null;
        const pn = String(first?.personaName || "").trim();
        if (pn) setNick(pn);
      } catch {
        // ignore
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    const v = nick.trim();
    if (!v || v.length < 2 || v.length > 20) {
      setErr("닉네임은 2~20자로 입력해줘.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/profile/nickname", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      window.location.replace("/");
    } catch (e: any) {
      setErr(e?.message || "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [nick]);

  const isAuthed = !!user?.email;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--app-bg)",
        color: "var(--foreground)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(720px, 96vw)",
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 22,
          padding: 18,
          boxShadow: "0 10px 40px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "10px 0 6px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/arca-headset.png" alt="Arca" style={{ width: 92, height: 92, borderRadius: 22, objectFit: "cover" }} />
          <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: "-0.5px", color: "#9b5cff" }}>닉네임 설정</div>
          <div style={{ fontSize: 13, opacity: 0.8, textAlign: "center" }}>
            {loading ? "불러오는 중…" : isAuthed ? "시작하려면 고유한 닉네임을 정해주세요. (2~20자)" : "계속하려면 로그인이 필요합니다."}
          </div>
        </div>

        {!loading && !isAuthed ? (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 14 }}>
            <a
              href="/api/auth/google"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                width: "min(420px, 100%)",
                borderRadius: 16,
                padding: "12px 14px",
                border: "1px solid rgba(255,255,255,0.14)",
                background: "var(--arca-grad-soft)",
                color: "#e9eefc",
                textDecoration: "none",
                fontWeight: 900,
              }}
            >
              Google로 계속하기
            </a>
          </div>
        ) : (
          <>
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              placeholder="예) 박성준"
              style={{
                width: "100%",
                height: 48,
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(255,255,255,0.05)",
                color: "#e9eefc",
                padding: "0 14px",
                outline: "none",
                marginTop: 14,
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              disabled={loading || saving}
            />

            {err ? <div style={{ marginTop: 8, fontSize: 12, color: "#ffb4b4" }}>{err}</div> : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
              <a
                href="/"
                style={{
                  height: 40,
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "0 14px",
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)",
                  color: "rgba(233,238,252,0.85)",
                  textDecoration: "none",
                  fontWeight: 800,
                }}
              >
                나중에
              </a>
              <button
                type="button"
                disabled={saving || loading || !isAuthed}
                onClick={() => void save()}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 14,
                  border: "1px solid rgba(168,85,247,0.35)",
                  background: "rgba(168,85,247,0.25)",
                  color: "#e9eefc",
                  cursor: saving ? "not-allowed" : "pointer",
                  opacity: saving ? 0.7 : 1,
                  fontWeight: 900,
                }}
              >
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
