// "친구비"(화폐) 비용 표기/차감 유틸
// NOTE: 브라우저(localStorage/window)를 사용하므로 클라이언트에서만 호출해야 한다.

// -----------------------------
// 비용 표기/환율
// -----------------------------

// 채팅 내 비용 표시는 '고정 환율'
export const KRW_PER_FRIENDFEE = 1.7;

export function ratePer1kForModel(model: string | undefined): number {
  const m = String(model || "").toLowerCase();
  // 서버 /api/friendfee/spend 의 단가 규칙과 동일하게 맞춘다.
  if (m.includes("flash")) return 1.0;
  if (m.includes("2.5") && m.includes("pro")) return 3.5;
  if (m.includes("3") && m.includes("pro")) return 4.5;
  // fallback: pro-tier
  return 3.5;
}

export function calcFriendFee(totalTokens: number, model: string | undefined): number {
  const t = Number(totalTokens) || 0;
  return (t / 1000) * ratePer1kForModel(model);
}

export function roundFriendFeeUi(fee: number): number {
  return Math.round(Number(fee) || 0);
}

export function formatKrwUi(krw: number): string {
  const n = Math.round(Number(krw) || 0);
  return `₩${n.toLocaleString("ko-KR")}`;
}

// -----------------------------
// 잔액 저장/이벤트
// -----------------------------

// 친구비 0일 때 UX 팝업 멘트(랜덤)
const FRIEND_FEE_EMPTY_LINES = [
  "나 아직 할 말 많은데… 😢 조금만 더 같이 있어주면 안 될까?",
  "다음 이야기가 정말 중요한데…!",
  "헤어지기엔 아직 이르잖아…",
  "아직 끝내기엔 아쉬워…",
  "조금만 더 같이 있어줄래?",
  "이 다음이 진짜 중요한데…",
  "벌써 헤어질 시간이야…?",
  "조금만 더 이야기하면 안 될까?",
];

// FriendFee is stored per-account (so different logins don't share balances).
export const FRIEND_FEE_USER_ID_KEY = "mate_friendfee_userid_v1";

export function getFriendFeeUserId(): string {
  try {
    const raw = window.localStorage.getItem(FRIEND_FEE_USER_ID_KEY);
    return raw && raw.trim() ? raw.trim() : "";
  } catch {
    return "";
  }
}

export function ffKey(base: string): string {
  const uid = getFriendFeeUserId();
  return uid ? `${base}__${uid}` : base;
}

export function pickFriendFeeEmptyLine(): string {
  const i = Math.floor(Math.random() * FRIEND_FEE_EMPTY_LINES.length);
  return FRIEND_FEE_EMPTY_LINES[i] || FRIEND_FEE_EMPTY_LINES[0];
}

export function readFriendFeeBalance(): number {
  try {
    const raw = window.localStorage.getItem(ffKey("mate_friendfee_balance_v1"));
    if (raw != null) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    const legacy = window.localStorage.getItem(ffKey("mate_friend_fee_state"));
    if (!legacy) return 0;
    const j = JSON.parse(legacy);
    const t = Number((j as any)?.total ?? 0);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

export function writeFriendFeeBalance(nextBalance: number) {
  // 내부는 소수 유지(서버가 실수 잔액을 반환). UI에서만 Math.round.
  const b = Math.max(0, Number(nextBalance) || 0);
  try {
    window.localStorage.setItem(ffKey("mate_friendfee_balance_v1"), String(b));
  } catch {
    // ignore
  }
  try {
    // legacy UI 호환: total은 정수로 저장
    window.localStorage.setItem(
      ffKey("mate_friend_fee_state"),
      JSON.stringify({ total: Math.round(b), updatedAt: Date.now() })
    );
  } catch {
    // ignore
  }
  try {
    // Include the latest balance in the event to avoid a follow-up /api/friendfee/state fetch.
    const detail = { balanceReal: b, balanceUi: Math.round(b), at: Date.now() };
    window.dispatchEvent(new CustomEvent("mate_friend_fee_updated", { detail }));
  } catch {
    try {
      window.dispatchEvent(new Event("mate_friend_fee_updated"));
    } catch {
      // ignore
    }
  }
}
