'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const LOCAL_POINTS_DISABLED = true;

type User = {
  email: string;
  name?: string;
  picture?: string;
  nickname?: string | null;
};

function AvatarLabel({ user }: { user: User }) {
  const label = user.nickname || user.name || user.email;
  return (
    <span
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: "#e9eefc",
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "inline-block",
        lineHeight: "36px",
      }}
      title={label}
    >
      {label}
    </span>
  );
}

function NicknameModal({
  open,
  defaultNick,
  onClose,
  onSaved,
}: {
  open: boolean;
  defaultNick: string;
  onClose: () => void;
  onSaved: (nickname: string) => void;
}) {
  const [nick, setNick] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const v = String(defaultNick || '').trim();
      if (v) setNick(v);
    }
    if (!open) {
      setNick("");
      setErr(null);
      setSaving(false);
    }
  }, [open]);

  const save = useCallback(async () => {
    const v = nick.trim();
    if (!v) return setErr("닉네임을 입력해줘.");
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
      onSaved(v);
      onClose();
    } catch (e: any) {
      setErr(e?.message || "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [nick, onClose, onSaved]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.70)",
        display: "grid",
        placeItems: "center",
        zIndex: 200,
      }}
    >
      <div
        style={{
          width: "min(460px, calc(100vw - 32px))",
          borderRadius: 22,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(14,14,16,0.94)",
          boxShadow: "0 18px 70px rgba(0,0,0,0.68)",
          padding: 18,
          backdropFilter: "blur(10px)",
        }}
      >
        <div style={{ display: "grid", justifyItems: "center", gap: 10, padding: "8px 6px 4px" }}>
          {/* 로고 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/arca-headset.png"
            alt="Arca"
            style={{ width: 86, height: 86, borderRadius: 18, objectFit: "cover", boxShadow: "0 10px 30px rgba(0,0,0,0.55)" }}
          />
          <div style={{ fontWeight: 950, fontSize: 22, letterSpacing: "0.2px", backgroundImage: "var(--arca-grad)", WebkitBackgroundClip: "text", color: "transparent", textShadow: "0 0 18px var(--arca-glow)" }}>
            Arca
          </div>
          <div style={{ fontSize: 12, opacity: 0.72, textAlign: "center", lineHeight: 1.35 }}>
            시작하려면 고유한 닉네임을 정해주세요. (2~20자)
          </div>
        </div>

        <input
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          placeholder="예) 박성준"
          style={{
            width: "100%",
            height: 44,
            borderRadius: 14,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(255,255,255,0.05)",
            color: "#e9eefc",
            padding: "0 14px",
            outline: "none",
            marginTop: 12,
          }}
        />
        {err ? <div style={{ marginTop: 8, fontSize: 12, color: "#ffb4b4" }}>{err}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 38,
              padding: "0 14px",
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.06)",
              color: "#e9eefc",
              cursor: "pointer",
            }}
          >
            나중에
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={save}
            style={{
              height: 38,
              padding: "0 14px",
              borderRadius: 14,
              border: "1px solid rgba(168,85,247,0.35)",
              background: "rgba(168,85,247,0.25)",
              color: "#e9eefc",
              cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.7 : 1,
              fontWeight: 800,
            }}
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  open,
  user,
  onClose,
  onOpenNickname,
  onDelete,
  onUploaded,
}: {
  open: boolean;
  user: any;
  onClose: () => void;
  onOpenNickname: () => void;
  onDelete: () => void;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  const upload = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/profile/picture", { method: "POST", body: fd });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setErr(j?.error || "업로드에 실패했습니다.");
        return;
      }
      onUploaded();
    } catch (e: any) {
      setErr(e?.message || "업로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(520px, 100%)",
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(14,14,14,0.98)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 950, color: "#e9eefc" }}>설정</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 36,
              height: 36,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
              color: "#e9eefc",
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: 12,
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 999,
                overflow: "hidden",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                flex: "0 0 auto",
              }}
            >
              {user?.picture ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.picture}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              ) : null}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 950, color: "#e9eefc" }}>프로필 사진</div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
                JPG/PNG/WebP, 2MB 이하
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                if (fileRef.current) fileRef.current.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              style={{
                height: 36,
                padding: "0 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                background: busy ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)",
                color: busy ? "rgba(233,238,252,0.55)" : "#e9eefc",
                cursor: busy ? "not-allowed" : "pointer",
                fontWeight: 900,
              }}
            >
              {busy ? "업로드…" : "등록"}
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenNickname();
            }}
            style={{
              width: "100%",
              height: 44,
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
              color: "#e9eefc",
              cursor: "pointer",
              fontWeight: 950,
            }}
          >
            닉네임 변경 (7일 1회)
          </button>

          <button
            type="button"
            onClick={onDelete}
            style={{
              width: "100%",
              height: 44,
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(239,68,68,0.12)",
              color: "#ffe7e7",
              cursor: "pointer",
              fontWeight: 950,
            }}
          >
            회원탈퇴
          </button>

          {err ? <div style={{ fontSize: 12, color: "#ffb4b4" }}>{err}</div> : null}

          <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
            * 회원탈퇴 시 계정은 비활성화되며, 다시 로그인해도 사용이 제한됩니다.
          </div>
        </div>
      </div>
    </div>
  );
}

function getKSTDateKey(d: Date = new Date()) {
  // Format: YYYY-MM-DD in Asia/Seoul
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(d); // sv-SE => 2026-01-04
  } catch {
    // Fallback (local timezone)
    return d.toISOString().slice(0, 10);
  }
}

function addDaysKST(dateKey: string, days: number) {
  // dateKey: YYYY-MM-DD
  const [y, m, d] = dateKey.split("-").map((v) => parseInt(v, 10));
  const base = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return getKSTDateKey(base);
}

type FriendFeeState = {
  lastCheckin: string; // YYYY-MM-DD
  streak: number;
  total: number;
};

function FriendFeeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<FriendFeeState>({ lastCheckin: "", streak: 0, total: 0 });
  const [toast, setToast] = useState("");

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem("mate_friend_fee_state");
      if (raw) {
        const parsed = JSON.parse(raw) as FriendFeeState;
        if (parsed && typeof parsed === "object") setState(parsed);
      }
    } catch {
      // ignore
    }
  }, [open]);

  const persist = useCallback((next: FriendFeeState) => {
    setState(next);
    try {
      localStorage.setItem("mate_friend_fee_state", JSON.stringify(next));
      window.dispatchEvent(new Event("mate_friend_fee_updated"));
    } catch {
      // ignore
    }
  }, []);

  const today = getKSTDateKey();
  const checkedToday = state.lastCheckin === today;

  const onCheckin = useCallback(() => {
    const todayKey = getKSTDateKey();
    if (state.lastCheckin === todayKey) {
      setToast("오늘은 이미 출석체크 했어요 💜");
      return;
    }
    const yesterday = addDaysKST(todayKey, -1);
    const nextStreak = state.lastCheckin === yesterday ? Math.max(1, (state.streak || 0) + 1) : 1;
    const nextTotal = (state.total || 0) + 10;

    persist({ lastCheckin: todayKey, streak: nextStreak, total: nextTotal });
    setToast("출석체크 완료! 친구비 +10 💕");
  }, [persist, state.lastCheckin, state.streak, state.total]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open || !mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10050,
        background: "rgba(0,0,0,0.58)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(520px, 92vw)",
          borderRadius: 18,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(18,18,24,0.92)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
          backdropFilter: "blur(10px)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 14px 10px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/arca-headset.png" alt="Arca" style={{ width: 34, height: 34, borderRadius: 10, objectFit: "cover" }} />
            <div style={{ display: "grid", gap: 2 }}>
              <div style={{ fontWeight: 950, letterSpacing: "0.2px", fontSize: 16, color: "#e9eefc" }}>
                💕 친구비 입금
              </div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>출석체크로 친구비를 받아요</div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            style={{
              height: 34,
              width: 34,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#e9eefc",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: "34px",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <div
            style={{
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.05)",
              padding: 14,
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontWeight: 900, color: "#e9eefc" }}>오늘 출석</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{today}</div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, opacity: 0.86 }}>
                상태: <span style={{ fontWeight: 900 }}>{checkedToday ? "출석 완료 ✅" : "미출석"}</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.86 }}>
                연속: <span style={{ fontWeight: 900 }}>{state.streak || 0}일</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.86 }}>
                누적 친구비: <span style={{ fontWeight: 900 }}>{state.total || 0}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={onCheckin}
              disabled={checkedToday}
              style={{
                height: 40,
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.14)",
                background: checkedToday ? "rgba(255,255,255,0.06)" : "rgba(168,85,247,0.28)",
                color: "#e9eefc",
                cursor: checkedToday ? "not-allowed" : "pointer",
                fontWeight: 950,
              }}
            >
              출석체크
            </button>

            {toast ? (
              <div style={{ fontSize: 12, opacity: 0.85 }}>{toast}</div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.55 }}>* 출석체크는 하루 1회 가능 (KST 기준)</div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}


export default function AuthControls(props: { onOpenFriendFeePage?: () => void } = {}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const [nickModal, setNickModal] = useState(false);
  const [defaultNick, setDefaultNick] = useState<string>("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [friendFeeOpen, setFriendFeeOpen] = useState(false);
  const [friendFeeTotal, setFriendFeeTotal] = useState<number>(0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Friend-fee state fetch can get noisy when streaming/billing triggers many updates.
  // We coalesce requests and throttle re-fetching to keep dev logs readable.
  const friendFeeLastFetchAtRef = useRef<number>(0);
  const friendFeeInFlightRef = useRef<Promise<void> | null>(null);
  const friendFeePendingTimerRef = useRef<number | null>(null);
  const friendFeeDidImportRef = useRef<boolean>(false);

  const FRIEND_FEE_USER_ID_KEY = "mate_friendfee_userid_v1";
  const friendFeeKey = useCallback((base: string, uid: string | null | undefined) => {
    const safe = (uid || "").trim();
    if (!safe) return base; // fallback (should not happen)
    return `${base}__${safe}`;
  }, []);

  const getCurrentFriendFeeUserId = useCallback((): string | null => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(FRIEND_FEE_USER_ID_KEY);
      return raw && raw.trim() ? raw.trim() : null;
    } catch {
      return null;
    }
  }, []);

  const loadFriendFeeTotal = useCallback(
    async (opts?: { force?: boolean }) => {
      if (LOCAL_POINTS_DISABLED) return;
      if (typeof window === "undefined") return;

      const uid = getCurrentFriendFeeUserId();

      const readFromLocal = (): number | null => {
        try {
          // Prefer new cache (real balance) -> UI is rounded
          const balRaw = uid
            ? window.localStorage.getItem(friendFeeKey("mate_friendfee_balance_v1", uid))
            : window.localStorage.getItem("mate_friendfee_balance_v1");
          if (balRaw != null) {
            const n = Number(balRaw);
            if (Number.isFinite(n)) return Math.round(n);
          }

          // Legacy cache
          const legacyRaw = uid
            ? window.localStorage.getItem(friendFeeKey("mate_friend_fee_state", uid))
            : window.localStorage.getItem("mate_friend_fee_state");
          if (legacyRaw) {
            const j = JSON.parse(legacyRaw);
            const t = Number((j as any)?.total ?? 0);
            if (Number.isFinite(t)) return t;
          }
        } catch {
          // ignore
        }
        return null;
      };

      // Fast UI update from same-tab cache (never hits network)
      const localUi = readFromLocal();
      if (localUi != null) setFriendFeeTotal(localUi);

      // Unless explicitly forced, do NOT call /api/friendfee/state.
      // This prevents accidental polling loops (e.g., when some UI updates fire frequently).
      if (!opts?.force) {
        if (friendFeeInFlightRef.current) return friendFeeInFlightRef.current;
        if (localUi != null) return;

        // If we have no local cache at all (first ever visit), allow a single server fetch
        // but still protect with a generous TTL.
        const now = Date.now();
        const last = friendFeeLastFetchAtRef.current || 0;
        const ttlMs = 60_000;
        if (now - last < ttlMs) return;
      }

      // Coalesce concurrent calls.
      if (friendFeeInFlightRef.current) return friendFeeInFlightRef.current;

      const now = Date.now();
      friendFeeLastFetchAtRef.current = now;

      const task = (async () => {
        // (마이그레이션) 기존 로컬스토리지 잔액을 서버로 1회 이관
        // - 서버 잔액이 0이고 ledger가 비어 있을 때만 적용되므로 안전
        if (!friendFeeDidImportRef.current) {
          friendFeeDidImportRef.current = true;
          try {
            const importedKey = uid ? friendFeeKey("mate_friendfee_imported_v1", uid) : "mate_friendfee_imported_v1";
            const already = window.localStorage.getItem(importedKey);
            if (!already) {
              const raw = uid
                ? window.localStorage.getItem(friendFeeKey("mate_friendfee_balance_v1", uid))
                : window.localStorage.getItem("mate_friendfee_balance_v1");
              const localBal = Number(raw);
              if (Number.isFinite(localBal) && localBal > 0) {
                await fetch("/api/friendfee/import", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ balance: localBal }),
                }).catch(() => null);
              }
              try {
                window.localStorage.setItem(importedKey, "1");
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }
        }

        // 1) 서버(DB) 잔액이 진실의 원본 (기기/브라우저 무관)
        try {
          const r = await fetch("/api/friendfee/state", { cache: "no-store" });
          if (r.ok) {
            const j = await r.json().catch(() => null);
            if (j?.ok) {
              const balReal = Number(j.balance ?? 0);
              const balUi = Math.round(Number.isFinite(balReal) ? balReal : 0);
              setFriendFeeTotal(balUi);

              // local cache (동일 탭/구형 UI 호환)
              try {
                if (uid) {
                  localStorage.setItem(friendFeeKey("mate_friendfee_balance_v1", uid), String(balReal));
                  localStorage.setItem(friendFeeKey("mate_friend_fee_state", uid), JSON.stringify({ total: balUi, updatedAt: Date.now() }));
                } else {
                  localStorage.setItem("mate_friendfee_balance_v1", String(balReal));
                  localStorage.setItem("mate_friend_fee_state", JSON.stringify({ total: balUi, updatedAt: Date.now() }));
                }
              } catch {
                // ignore
              }
              return;
            }
          }
        } catch {
          // ignore
        }

        // 2) 서버가 안되면 (오프라인 등) 로컬 캐시 폴백
        const fallback = readFromLocal();
        if (fallback != null) {
          setFriendFeeTotal(fallback);
          return;
        }
        setFriendFeeTotal(0);
      })();

      friendFeeInFlightRef.current = task;
      try {
        await task;
      } finally {
        if (friendFeeInFlightRef.current === task) friendFeeInFlightRef.current = null;
      }
    },
    [friendFeeKey, getCurrentFriendFeeUserId]
  );

  useEffect(() => {
    // 최초 로드
    if (typeof window === "undefined") return;
    loadFriendFeeTotal({ force: true });

    const onUpdated = (ev?: Event) => {
      // Fast-path: if the event already carries the new balance (from a server response),
      // update UI immediately without triggering another /state fetch.
      try {
        const d = (ev as any)?.detail;
        if (d && typeof d.balanceUi === "number") {
          setFriendFeeTotal(d.balanceUi);
          return;
        }
      } catch {
        // ignore
      }

      // Next best: same-tab cache (avoid spamming /api/friendfee/state).
      try {
        const uid = getCurrentFriendFeeUserId();
        const balRaw = uid
          ? window.localStorage.getItem(friendFeeKey("mate_friendfee_balance_v1", uid))
          : window.localStorage.getItem("mate_friendfee_balance_v1");
        if (balRaw != null) {
          const n = Number(balRaw);
          if (Number.isFinite(n)) {
            setFriendFeeTotal(Math.round(n));
            return;
          }
        }
        const legacyRaw = uid
          ? window.localStorage.getItem(friendFeeKey("mate_friend_fee_state", uid))
          : window.localStorage.getItem("mate_friend_fee_state");
        if (legacyRaw) {
          const j = JSON.parse(legacyRaw);
          const t = Number((j as any)?.total ?? 0);
          if (Number.isFinite(t)) {
            setFriendFeeTotal(t);
            return;
          }
        }
      } catch {
        // ignore
      }

      // NOTE:
      // In heavy chat/streaming flows, we may receive many "updated" events.
      // We intentionally avoid triggering a server fetch here to prevent
      // spamming /api/friendfee/state.
      //
      // The chat pipeline refreshes the balance once at the end of each send
      // (and also at initial mount / user switch), so doing a fallback fetch
      // here is both redundant and can cause excessive polling.
      return;
    };
    const onStorage = (e: StorageEvent) => {
      const uid = getCurrentFriendFeeUserId();
      const keys = new Set<string>([
        "mate_friend_fee_state",
        "mate_friendfee_balance_v1",
        uid ? friendFeeKey("mate_friend_fee_state", uid) : "",
        uid ? friendFeeKey("mate_friendfee_balance_v1", uid) : "",
        FRIEND_FEE_USER_ID_KEY,
      ]);
      if (e.key && keys.has(e.key)) loadFriendFeeTotal();
    };

    window.addEventListener("mate_friend_fee_updated", onUpdated as any);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("mate_friend_fee_updated", onUpdated as any);
      window.removeEventListener("storage", onStorage);
    };
  }, [loadFriendFeeTotal]);

  // When the authenticated user changes, switch the friend-fee bucket immediately.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const uid = (user as any)?.email || (user as any)?.id || "";
    try {
      if (uid) window.localStorage.setItem(FRIEND_FEE_USER_ID_KEY, String(uid));
      else window.localStorage.removeItem(FRIEND_FEE_USER_ID_KEY);
    } catch {
      // ignore
    }
    // Force a reload of balance for the new user in the same tab.
    loadFriendFeeTotal({ force: true });
    try {
      window.dispatchEvent(new Event("mate_friend_fee_updated"));
    } catch {
      // ignore
    }
  }, [user, loadFriendFeeTotal]);

  useEffect(() => {
    // 모달 닫힐 때 최신 값 반영(같은 탭에서는 storage 이벤트가 안 뜸)
    if (typeof window === "undefined") return;
    if (!friendFeeOpen) loadFriendFeeTotal();
  }, [friendFeeOpen, loadFriendFeeTotal]);
  useEffect(() => {
    const onOpen = () => setFriendFeeOpen(true);
    if (typeof window !== "undefined") {
      window.addEventListener("mate:openFriendFee", onOpen as any);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("mate:openFriendFee", onOpen as any);
      }
    };
  }, []);


  const menuRef = useRef<HTMLDivElement | null>(null);
  const nickBtnRef = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      const j = await r.json().catch(() => ({} as any));
      const u = (j?.user ?? null) as User | null;
      setUser(u);

      if (u) {
        const nick = (u.nickname ?? "").toString().trim();
        setDefaultNick(nick);

        // 닉네임이 없으면 전용 페이지로 유도 (기존 정책 유지)
        if (!nick) {
          if (typeof window !== "undefined") {
            const p = window.location?.pathname || "";
            if (p !== "/nickname") window.location.href = "/nickname";
          }
        }
      } else {
        setDefaultNick("");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onLogin = useCallback(() => {
    window.location.href = "/api/auth/google";
  }, []);

  const onLogout = useCallback(async () => {
    setMenuOpen(false);
    setMenuPos(null);
    setFriendFeeOpen(false);
    setSettingsOpen(false);
    setDeleteConfirmOpen(false);
    
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);

    // Clear current user pointer so next login starts from its own bucket.
    try {
      window.localStorage.removeItem(FRIEND_FEE_USER_ID_KEY);
      window.dispatchEvent(new Event("mate_friend_fee_updated"));
    } catch {
      // ignore
    }

    // Notify the app shell to drop any cached auth state immediately.
    try {
      window.dispatchEvent(new Event("sj:logout"));
    } catch {}

    // Hard refresh to ensure all server/client caches are reset and gated routes close.
    try {
      window.location.replace("/?logged_out=1");
    } catch {
      try {
        window.location.reload();
      } catch {}
    }
  }, []);

  const onOpenSettings = useCallback(() => {
    setMenuOpen(false);
    setMenuPos(null);
    setDeleteErr(null);
    setSettingsOpen(true);
  }, []);

  const onOpenDeleteConfirm = useCallback(() => {
    setDeleteErr(null);
    setDeleteConfirmOpen(true);
  }, []);

  const onConfirmDelete = useCallback(async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    try {
      const r = await fetch("/api/profile/delete", { method: "POST" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || "회원탈퇴에 실패했습니다.");
      // 세션은 서버에서 삭제되므로, 클라이언트에서도 즉시 로그아웃 처리
      setUser(null);
      try {
        window.localStorage.removeItem(FRIEND_FEE_USER_ID_KEY);
      } catch {}
      try {
        window.location.replace("/?deleted=1");
      } catch {
        window.location.reload();
      }
    } catch (e: any) {
      setDeleteErr(e?.message || "회원탈퇴에 실패했습니다.");
    } finally {
      setDeleteBusy(false);
      setDeleteConfirmOpen(false);
      setSettingsOpen(false);
      setMenuOpen(false);
      setMenuPos(null);
    }
  }, [deleteBusy, FRIEND_FEE_USER_ID_KEY]);

  // Close dropdown on outside click / ESC
  useEffect(() => {
    if (!menuOpen) return;

    const onDown = (e: MouseEvent) => {
      const btn = nickBtnRef.current;
      const menu = menuRef.current;
      const t = e.target;
      if (t instanceof Node) {
        if (btn && btn.contains(t)) return;
        if (menu && menu.contains(t)) return;
      }
      setMenuOpen(false);
      setMenuPos(null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setMenuPos(null);
      }
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Position dropdown under the nickname button (portal menu)
  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }

    const update = () => {
      const btn = nickBtnRef.current;
      if (!btn) return;

      const r = btn.getBoundingClientRect();
      const minW = 160;
      const left = Math.max(8, Math.min(window.innerWidth - minW - 8, r.right - minW));
      const top = Math.min(window.innerHeight - 8, r.bottom + 8);
      setMenuPos({ top, left });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [menuOpen]);

  const right = useMemo(() => {
    if (loading) {
      return <div style={{ fontSize: 12, opacity: 0.6 }}>…</div>;
    }

    if (!user) {
      return (
        <button
          type="button"
          onClick={onLogin}
          style={{
            height: 36,
            padding: "0 12px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(255,255,255,0.06)",
            color: "#e9eefc",
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          로그인
        </button>
      );
    }

    return (
      <>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {/* (RED) 닉네임 버튼: 메뉴 토글 */}
          <button
            ref={nickBtnRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.06)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen ? "true" : "false"}
          >
            {/* AvatarLabel 내부 글씨 크기가 작으면 여기서 감싸서 키운다 */}
            <div style={{ fontSize: 18, fontWeight: 950, lineHeight: "20px" }}>
              <AvatarLabel user={user} />
            </div>
          </button>

          {/* (YELLOW) 친구비 버튼: 페이지 이동 (nested button 금지) */}
          {!LOCAL_POINTS_DISABLED && <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (props.onOpenFriendFeePage) props.onOpenFriendFeePage();
              else setFriendFeeOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (props.onOpenFriendFeePage) props.onOpenFriendFeePage();
                else setFriendFeeOpen(true);
              }
            }}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.06)",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              userSelect: "none",
            }}
            aria-label={`친구비 ${friendFeeTotal.toLocaleString()} 보유`}
            title={`친구비 ${friendFeeTotal.toLocaleString()}`}
          >
            <img src="/friendfee-coin.png" alt="friend fee" width={26} height={26} style={{ display: "block" }} />
            <span style={{ fontSize: 18, fontWeight: 950, letterSpacing: 0.2 }}>{friendFeeTotal.toLocaleString()}</span>
          </div>}
        </div>

        {menuOpen && menuPos && typeof document !== "undefined" &&
          createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{
                position: "fixed",
                top: menuPos.top,
                left: menuPos.left,
                minWidth: 160,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(10,10,10,0.95)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
                padding: 6,
                zIndex: 1000,
              }}
            >
              <button
                type="button"
                onClick={onOpenSettings}
                role="menuitem"
                style={{
                  width: "100%",
                  textAlign: "left",
                  height: 36,
                  padding: "0 10px",
                  borderRadius: 10,
                  border: "none",
                  background: "transparent",
                  color: "#e9eefc",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                설정
              </button>

              <button
                type="button"
                onClick={onLogout}
                role="menuitem"
                style={{
                  width: "100%",
                  textAlign: "left",
                  height: 36,
                  padding: "0 10px",
                  borderRadius: 10,
                  border: "none",
                  background: "transparent",
                  color: "#e9eefc",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                로그아웃
              </button>
            </div>,
            document.body
          )}
      </>
    );
  }, [loading, menuOpen, menuPos, onLogin, onLogout, onOpenSettings, user, friendFeeTotal, props.onOpenFriendFeePage]);

  return (
    <>
      {right}
      {!LOCAL_POINTS_DISABLED && <FriendFeeModal open={friendFeeOpen} onClose={() => setFriendFeeOpen(false)} />}
      <SettingsModal
        open={settingsOpen}
        user={user}
        onClose={() => setSettingsOpen(false)}
        onOpenNickname={() => setNickModal(true)}
        onDelete={() => {
          setDeleteConfirmOpen(true);
          setDeleteErr(null);
        }}
        onUploaded={() => refresh()}
      />

      {deleteConfirmOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 1300,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleteConfirmOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width: "min(460px, 100%)",
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(14,14,14,0.98)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
              padding: 16,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 950, color: "#e9eefc" }}>정말 탈퇴하시겠습니까?</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
              탈퇴 시 계정은 비활성화되며, 동일한 계정으로 다시 로그인해도 사용이 제한됩니다.
            </div>

            {deleteErr ? <div style={{ marginTop: 10, fontSize: 12, color: "#ffb4b4" }}>{deleteErr}</div> : null}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => setDeleteConfirmOpen(false)}
                style={{
                  height: 40,
                  padding: "0 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)",
                  color: "#e9eefc",
                  cursor: deleteBusy ? "not-allowed" : "pointer",
                  fontWeight: 900,
                }}
              >
                취소
              </button>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => void onConfirmDelete()}
                style={{
                  height: 40,
                  padding: "0 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: deleteBusy ? "rgba(239,68,68,0.10)" : "rgba(239,68,68,0.18)",
                  color: "#ffe7e7",
                  cursor: deleteBusy ? "not-allowed" : "pointer",
                  fontWeight: 950,
                }}
              >
                {deleteBusy ? "처리 중…" : "탈퇴"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <NicknameModal
        open={nickModal}
        defaultNick={defaultNick}
        onClose={() => setNickModal(false)}
        onSaved={() => refresh()}
      />
    </>
  );
}
