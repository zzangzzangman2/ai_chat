"use client";

import React, { useEffect, useMemo, useState } from "react";

type Pack = {
  id: string;
  amount: number;
  priceLabel: string;
  badge?: string;
  sub?: string;
};

export default function FriendFeePage(props: { onExitToChat?: () => void } = {}) {
  // ---- Server persistent state ----
  // FriendFee는 서버(DB)에 영속 저장되어, 브라우저/PC가 바뀌어도 동일하게 유지된다.
  const STORAGE_ATT = "mate_friendfee_attendance_v1";
  const STORAGE_BAL = "mate_friendfee_balance_v1";
  // Legacy key (top-bar pill / 기존 모달에서 읽는 값)
  const STORAGE_LEGACY = "mate_friend_fee_state";

  // Store FriendFee per-account (so different logins don't share balances).
  const FRIEND_FEE_USER_ID_KEY = "mate_friendfee_userid_v1";
  const getUid = () => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(FRIEND_FEE_USER_ID_KEY) : null;
      return raw && raw.trim() ? raw.trim() : "";
    } catch {
      return "";
    }
  };
  const k = (base: string) => {
    const uid = getUid();
    return uid ? `${base}__${uid}` : base;
  };

  const [balance, setBalance] = useState<number>(0);
  const [att, setAtt] = useState<{ days: string[]; lastCheck: string | null }>({ days: [], lastCheck: null });

  const todayKey = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }, []);

  // UX: 충전(친구비) 페이지에서 바로 채팅을 치려는 경우
  // - Enter 키를 누르면 채팅 화면으로 빠르게 복귀
  // - (주의) 입력창/텍스트영역에 포커스가 있을 때는 방해하지 않는다.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (e.isComposing) return;
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || (t as any)?.isContentEditable) return;
      if (props.onExitToChat) props.onExitToChat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  const { streak, cycleDay } = useMemo(() => {
    // streak: 연속 출석 일수 (오늘 포함)
    // cycleDay: 1~7 (7일째는 2배)
    const uniq = Array.from(new Set(att.days)).sort();
    if (uniq.length === 0) return { streak: 0, cycleDay: 0 };

    const toNum = (k: string) => {
      const [y, m, d] = k.split("-").map((v) => parseInt(v, 10));
      // local date -> ms
      return new Date(y, (m || 1) - 1, d || 1).getTime();
    };
    const dayMs = 24 * 60 * 60 * 1000;

    // start from today; if not checked today, streak=0 for UI (since we only show today's completion)
    const hasToday = uniq.includes(todayKey);
    if (!hasToday) {
      // still show current running streak ending yesterday
      const yesterday = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${dd}`;
      })();
      if (!uniq.includes(yesterday)) return { streak: 0, cycleDay: 0 };
    }

    const startKey = hasToday ? todayKey : (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    })();

    let s = 1;
    let cursor = toNum(startKey);
    // walk backwards day-by-day
    while (true) {
      const prev = cursor - dayMs;
      const prevKey = (() => {
        const d = new Date(prev);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${dd}`;
      })();
      if (uniq.includes(prevKey)) {
        s += 1;
        cursor = prev;
        continue;
      }
      break;
    }

    const cycle = ((s - 1) % 7) + 1;
    return { streak: s, cycleDay: cycle };
  }, [att.days, todayKey]);

  const checkedToday = useMemo(() => att.days.includes(todayKey), [att.days, todayKey]);

  useEffect(() => {
    let cancelled = false;

    // 1) 빠른 UI: localStorage 캐시를 먼저 적용(있으면)
    try {
      const rawAtt = localStorage.getItem(k(STORAGE_ATT));
      if (rawAtt) {
        const parsed = JSON.parse(rawAtt);
        if (parsed && Array.isArray(parsed.days)) setAtt({ days: parsed.days, lastCheck: parsed.lastCheck ?? null });
      }
      const rawBal = localStorage.getItem(k(STORAGE_BAL));
      if (rawBal) {
        const n = parseInt(rawBal, 10);
        if (Number.isFinite(n)) setBalance(n);
      }
    } catch {
      // ignore
    }

    // 2) 진실의 원본: 서버(DB)에서 상태 로드
    (async () => {
      try {
        const r = await fetch("/api/friendfee/state", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (!j?.ok) return;
        if (cancelled) return;
        const nextBal = Math.round(Number(j.balance ?? 0));
        const days = Array.isArray(j.attendance?.days) ? j.attendance.days : [];
        const lastCheck = j.attendance?.lastCheck ?? null;
        persist({ days, lastCheck }, nextBal, { lastCheckin: lastCheck ?? "", streak: streak || 0, total: nextBal });
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (
    nextAtt: { days: string[]; lastCheck: string | null },
    nextBal: number,
    legacy?: { lastCheckin: string; streak: number; total: number }
  ) => {
    setAtt(nextAtt);
    setBalance(nextBal);
    try {
      localStorage.setItem(k(STORAGE_ATT), JSON.stringify(nextAtt));
      localStorage.setItem(k(STORAGE_BAL), String(nextBal));

      // keep legacy key in sync (top-bar pill 등 기존 UI 연동)
      if (legacy) {
        localStorage.setItem(k(STORAGE_LEGACY), JSON.stringify(legacy));
      } else {
        // at minimum, keep total synced
        try {
          const prev = localStorage.getItem(k(STORAGE_LEGACY));
          const j = prev ? JSON.parse(prev) : {};
          localStorage.setItem(k(STORAGE_LEGACY), JSON.stringify({ ...(j || {}), total: nextBal }));
        } catch {
          localStorage.setItem(k(STORAGE_LEGACY), JSON.stringify({ total: nextBal }));
        }
      }

      // same-tab에서도 즉시 반영되도록 커스텀 이벤트 발행
      try {
        const detail = { balanceReal: Number(nextBal), balanceUi: Math.round(Number(nextBal)), at: Date.now() };
        window.dispatchEvent(new CustomEvent("mate_friend_fee_updated", { detail }));
      } catch {
        window.dispatchEvent(new Event("mate_friend_fee_updated"));
      }
    } catch {
      // ignore
    }
  };

  const doCheckIn = async () => {
    if (checkedToday) return;
    try {
      const r = await fetch("/api/friendfee/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dayKey: todayKey }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) return;

      // 서버 응답 기준으로 업데이트
      const nextBal = Math.round(Number(j.balance ?? balance));
      const days = Array.from(new Set([...att.days, todayKey])).sort();
      persist({ days, lastCheck: todayKey }, nextBal, {
        lastCheckin: todayKey,
        streak: Number(j.streak ?? streak ?? 0),
        total: nextBal,
      });
    } catch {
      // ignore
    }
  };

  const packs = useMemo<Pack[]>(
    () => [
      { id: "p1", amount: 3500, priceLabel: "₩5,900" },
      { id: "p2", amount: 5700, priceLabel: "₩6,500", badge: "첫 구매가", sub: "첫구매 한정 · -32%" },
      { id: "p3", amount: 15900, priceLabel: "₩23,900", badge: "-11%" },
      { id: "p4", amount: 32900, priceLabel: "₩48,900", badge: "-12%" },
      { id: "p5", amount: 61900, priceLabel: "₩61,900", badge: "첫 구매가", sub: "첫구매 한정 · -41%" },
    ],
    []
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Header */}
      <div
        style={{
          borderRadius: 22,
          border: "none",
          background: "rgba(255,255,255,0.04)",
          padding: 16,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 24, fontWeight: 950, letterSpacing: "-0.2px" }}>친구비 입금</div>
            <div style={{ fontSize: 13, opacity: 0.78 }}>친구비로 작품을 더 오래, 더 깊게 이어가요.</div>
          </div>

          <div
            style={{
              width: 208,
              height: 176,
              borderRadius: 0,
              border: "none",
              background: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
                    fontSize: 10,
              padding: 0,
              overflow: "visible",
              flex: "0 0 auto",
            }}
            title="친구비"
          >
            <img
              src="/friendfee-hero.png"
              alt="친구비"
              style={{
                width: 208,
                height: 176,
                objectFit: "contain",
                imageRendering: "auto",
                filter: "none",
                transform: "translateZ(0)",
              }}
              draggable={false}
            />
          </div>
        </div>
      </div>

      {/* Attendance */}
      <div
        style={{
          borderRadius: 22,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.03)",
          padding: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 950, letterSpacing: "-0.2px", whiteSpace: "nowrap" }}>
                출석 {Math.max(streak, 0)}/7
              </div>
              <div style={{ fontSize: 12, opacity: 0.62, whiteSpace: "nowrap" }}>연속 {Math.max(streak, 0)}일</div>
              <div style={{ fontSize: 12, opacity: 0.5, whiteSpace: "nowrap" }}>· 7일차 x2</div>
            </div>
          </div>

          {checkedToday ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(34,197,94,0.14)",
                color: "#22c55e",
                fontWeight: 950,
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              }}
            >
              ✓ 오늘 출석 완료
            </div>
          ) : (
            <button
              type="button"
              onClick={doCheckIn}
              style={{
                height: 28,
                padding: "0 12px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "linear-gradient(135deg, rgba(155,92,255,0.22), rgba(99,102,241,0.16))",
                color: "#e9eefc",
                fontWeight: 950,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              }}
              title="출석하면 친구비 5,000 지급 (7일째 2배)"
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.10)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                    fontSize: 12,
                  border: "1px solid rgba(255,255,255,0.10)",
                  flex: "0 0 auto",
                }}
                aria-hidden
              >
                <img src="/friendfee-coin.png" alt="친구비" style={{ width: 34, height: 34, objectFit: "contain" }} />
              </span>
              출석하기
            </button>
          )}
        </div>

        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 14 }}>
          {Array.from({ length: 7 }).map((_, i) => {
            const day = i + 1;
            const active = cycleDay > 0 ? day <= cycleDay : false;
            const done = checkedToday ? active : day < cycleDay;
            const is7 = day === 7;
            return (
              <div key={day} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 }}>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: done ? "rgba(34,197,94,0.30)" : active ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    position: "relative",
                    opacity: active || done ? 1 : 0.55,
                  }}
                >
                  {done ? "✓" : ""}
                  
                </div>
                <div style={{ fontSize: 10, opacity: 0.70, lineHeight: "10px" }}>{day}</div>
                {is7 ? <div style={{ fontSize: 10, opacity: 0.55, lineHeight: "10px" }}>x2</div> : <div style={{ height: 10 }} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Balance */}
      <div
        style={{
          borderRadius: 22,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.03)",
          padding: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src="/friendfee-coin.png"
            alt="친구비"
            style={{ width: 44, height: 44, objectFit: "contain", flex: "0 0 auto" }}
          />
          <div>
            <div style={{ fontSize: 12, opacity: 0.78 }}>현재 잔액</div>
            <div style={{ fontSize: 26, fontWeight: 950, letterSpacing: "-0.2px" }}>
              {balance.toLocaleString("ko-KR")} <span style={{ fontSize: 14, opacity: 0.78 }}>친구비</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled
          style={{
            height: 38,
            padding: "0 14px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.10)",
            color: "#e9eefc",
            fontWeight: 950,
            cursor: "not-allowed",
            opacity: 0.9,
          }}
          title="결제/충전 동작은 다음 단계에서 연결합니다."
        >
          ＋ 충전하기
        </button>
      </div>

      {/* List */}
      <div style={{ display: "grid", gap: 12 }}>
        {packs.map((p) => (
          <div
            key={p.id}
            style={{
              borderRadius: 20,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.03)",
              padding: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 12,
                  background: "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  flex: "0 0 auto",
                }}
                aria-hidden
              >
                <img src="/friendfee-coin.png" alt="친구비" style={{ width: 34, height: 34, objectFit: "contain" }} />
              </div>

              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 22, fontWeight: 950, letterSpacing: "-0.2px" }}>
                    {p.amount.toLocaleString("ko-KR")}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.78 }}>친구비</div>

                  {p.badge ? (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        padding: "4px 8px",
                        borderRadius: 999,
                        background: p.badge.includes("첫") ? "rgba(239,68,68,0.22)" : "rgba(99,102,241,0.20)",
                        border: "1px solid rgba(255,255,255,0.10)",
                      }}
                    >
                      {p.badge}
                    </span>
                  ) : null}

                  {p.sub ? <span style={{ fontSize: 12, opacity: 0.75, whiteSpace: "nowrap" }}>{p.sub}</span> : null}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" }}>
              <div
                style={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(155,92,255,0.22)",
                  color: "#e9eefc",
                  fontWeight: 950,
                  minWidth: 92,
                  textAlign: "center",
                }}
              >
                {p.priceLabel}
              </div>
            </div>
          </div>
        ))}

        <div style={{ fontSize: 12, opacity: 0.6, padding: "4px 2px" }}>
          * 결제/충전 동작은 다음 단계에서 연결합니다.
        </div>
      </div>
    </div>
  );
}
