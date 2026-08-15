"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Preset } from "@/app/page";
import { labelTokenKey } from "@/app/components/chat/utils/tokenUi";
import { useChatStreamPacer } from "@/app/components/chat/hooks/useChatStream";
import {
  KRW_PER_FRIENDFEE,
  calcFriendFee,
  roundFriendFeeUi,
  formatKrwUi,
  pickFriendFeeEmptyLine,
  readFriendFeeBalance,
  writeFriendFeeBalance,
} from "@/app/components/chat/utils/friendFee";
import { Icon, SettingsIcon } from "@/app/components/chat/ChatArea/Icons";
import { buildGalleryMap } from "@/app/components/chat/ChatArea/gallery";
import {
  getModelBadge,
  getModelDisplayLabel,
  getReasoningLevelOptions,
  getReasoningPresets,
  inferReasoningLevel,
  isAssistantLikeRole,
  isReasoningPresetTokens,
  isLikelyStarLabel,
  maybeUnescapeJsonEscapes,
  normalizeStarVariants,
  ReasoningLevel,
  stripEndMarkerClient,
  stripLeadingTitleForDisplay,
  stripAllStarGlyphs,
  splitTrailingMetaFenceBlocksAtEndClient,
  toPromptRole,
} from "@/app/components/chat/ChatArea/textUtils";
import { renderNovelNode } from "@/app/components/chat/ChatArea/renderer/renderNovel";
import { renderMarkdownLiteNode } from "@/app/components/chat/ChatArea/renderer/renderMarkdownLite";
import { buildInputPreviewNodes as buildInputPreviewNodesNode } from "@/app/components/chat/ChatArea/renderer/inputPreview";
import { computeMessageWindow } from "@/app/components/chat/ChatArea/selectors/messageWindow";
import { MessageList } from "@/app/components/chat/ChatArea/MessageList";
import MemoryPanel from "@/app/components/MemoryPanel";
import RelationshipGraphPanel from "@/app/components/RelationshipGraphPanel";
import { CHAT_MODEL_IDS, type ChatModelId, coerceChatModelId } from "@/lib/models";
import { mergeStreamFinalContent } from "@/app/components/chat/ChatArea/streamMerge";

const LOCAL_POINTS_DISABLED = true;


// (image) 외부 이미지가 간헐적으로 핫링크/리퍼러 차단(403) 등으로 깨지는 케이스가 있어
// 1) 원본 URL로 로드
// 2) 실패 시 same-origin 프록시(/api/image-proxy)로 한 번 재시도
// 3) 프록시도 실패하면 링크(원본 열기)로 폴백
function SmartImage({
  src,
  alt,
  style,
  theme,
}: {
  src: string;
  alt?: string;
  style?: React.CSSProperties;
  theme?: { panel2?: string; border?: string; muted?: string; accent?: string };
}) {
  const normalized = useMemo(() => {
    let s = String(src || "").trim();
    if (!s) return "";
    if (s.startsWith("//")) s = `https:${s}`;
    return s;
  }, [src]);

  const proxy = useMemo(() => {
    if (!normalized) return "";
    return `/api/image-proxy?url=${encodeURIComponent(normalized)}`;
  }, [normalized]);

  const [cur, setCur] = useState<string>(normalized);
  const triedProxyRef = useRef<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    triedProxyRef.current = false;
    setFailed(false);
    setCur(normalized);
  }, [normalized]);

  if (!normalized) return null;

  if (failed) {
    const bg = theme?.panel2 || "rgba(255,255,255,0.04)";
    const br = theme?.border || "rgba(255,255,255,0.10)";
    const muted = theme?.muted || "rgba(229,231,235,0.70)";
    const accent = theme?.accent || "#a78bfa";
    return (
      <div
        style={{
          background: bg,
          border: `1px solid ${br}`,
          borderRadius: 14,
          padding: 12,
          maxWidth: 900,
        }}
      >
        <div style={{ color: muted, fontSize: 13, marginBottom: 6 }}>이미지를 불러오지 못했습니다.</div>
        <a href={normalized} target="_blank" rel="noreferrer" style={{ color: accent, fontSize: 13 }}>
          원본 이미지 열기
        </a>
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={cur}
      alt={alt || ""}
      loading="lazy"
      style={style}
      onError={() => {
        // 1차 실패 → 프록시로 재시도
        if (!triedProxyRef.current && proxy && cur !== proxy) {
          triedProxyRef.current = true;
          setCur(proxy);
          return;
        }
        // 프록시도 실패
        setFailed(true);
      }}
    />
  );
}




export type Msg = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "model";
  content: string;
  createdAt: number;
  usage?: null | {
    model?: string;
    promptTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
    finishReason?: string;
    maxOutputTokensRequested?: number;
    maxOutputTokensForProvider?: number;
    effectiveMaxOutputTokens?: number;
    reasoningHeadroomTokens?: number;
    thinkingBudget?: number | null;
    thinkingLevel?: "low" | "medium" | "high" | string | null;
    estimatedCostUsd?: number;
    estimatedCostKrw?: number;
    usdToKrw?: number;
    // (추정) 입력 구성 토큰 합
    estPromptTotal?: number;
    // (추정) 입력 구성 분해
    tokenBreakdown?: Record<string, number>;
  };
};

type Settings = {
  chatId: string;

  personaName: string;
  personaAge: number;
  personaGender: string;
  personaInfo: string;

  memoryFrom: number;
  summaryEvery: number;
  summaryLength: number;

  userNote: string;
  longMemoryGuidance?: string;

  narrationColor?: string;
  renderMode: "chat" | "novel";

  model: ChatModelId;
  maxOutputTokens: number;
  maxReasoningTokens: number;

  updatedAt: number;
};


// UI 옵션 (settings route의 허용 목록과 맞춰 둔다)
// UI 옵션 (settings route의 허용 목록과 맞춰 둔다)
const MODEL_OPTIONS = CHAT_MODEL_IDS;

// 채팅 본문(대사/지문) 컬럼 최대 폭 (영상 UI처럼 가운데 좁게)
const CHAT_COLUMN_MAX = 680;


export type ChatTheme = {
  bg: string;
  bg2: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  speech: string;
  narration: string;
  panel: string;
};

export type MessageContentRenderer = ({ message }: { message: Msg }) => ReactElement;


export default function ChatArea(props: {
  presetId: string | null;
  presets: Preset[];
  onChangePreset: (id: string) => void;
  onChatIdChange?: (chatId: string) => void;
  // (layout) 외부 레이아웃(예: 좌측 사이드바 접기/펼치기) 변경 시
  // 하단 고정 입력창 도킹 좌표를 재계산하기 위한 키
  layoutKey?: number | string;
  // UI-only options (기능 로직은 유지)
  settingsUiMode?: "inline" | "drawer";
  hideSettingsToggle?: boolean;
  externalSettingsOpen?: boolean;
  onExternalSettingsOpenChange?: (open: boolean) => void;
}) {
  const { presetId, presets, layoutKey } = props;


  const settingsUiMode = props.settingsUiMode ?? "inline";

  const [chatId, setChatIdState] = useState<string>("");
  // 채팅 전환 직전에 이전 히스토리 요청이 늦게 끝나더라도 새 채팅 화면을 덮어쓰지 못하게 한다.
  // state 반영을 기다리지 않고 즉시 세대를 올려, 같은 이벤트 루프에서 완료되는 이전 요청도 차단한다.
  const activeChatIdRef = useRef<string>("");
  const chatContextGenerationRef = useRef(0);
  const setChatId = useCallback((nextChatId: string) => {
    const next = String(nextChatId || "");
    activeChatIdRef.current = next;
    chatContextGenerationRef.current += 1;
    setChatIdState(next);
  }, []);
  useEffect(() => {
    if (props.onChatIdChange) props.onChatIdChange(chatId);
  }, [chatId, props.onChatIdChange]);

  const [messages, setMessages] = useState<Msg[]>([]);

  // (성능/메모리) 긴 대화는 '전체를 한 번에' 불러오지 않고, 최신 구간만 먼저 로드한 뒤
  // 위로 스크롤할 때마다 이전 구간을 추가로 불러온다(일반 소설/커뮤니티 스타일).
  // NOTE: 진입 체감을 위해 "첫 로드"는 더 작게 받고, 스크롤 로드는 중간 크기로 유지한다.
  // - 서버는 20~400 사이에서 clamp
  // - 페이지가 너무 크면 prepend 시 리플로우/파싱 비용이 커져 상단 로드 구간에서 끊김이 커질 수 있음
  const HISTORY_INITIAL_PAGE_SIZE = 40;
  const HISTORY_PAGE_SIZE = 60;
  const [hasMoreOlder, setHasMoreOlder] = useState<boolean>(false);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const oldestCreatedAtRef = useRef<number | null>(null);
  const [hasMoreNewer, setHasMoreNewer] = useState<boolean>(false);
  const [loadingNewer, setLoadingNewer] = useState<boolean>(false);
  const newestCreatedAtRef = useRef<number | null>(null);

  // (성능/메모리) 클라이언트에 유지할 메시지 상한. 초과 시 '현재 보고 있는 쪽'을 유지하며 반대쪽을 버린다.
  // NOTE: 브라우저 메모리/리렌더 부담을 줄이기 위해 클라이언트 메시지 보관 상한을 낮춘다.
  // (필요 시 위로 스크롤하면 서버에서 다시 불러오는 방식)
  const WINDOW_HARD_CAP = 260;

  // (성능) 진짜 windowing/virtualization
  // - 화면에는 항상 일정한 수의 메시지만 렌더한다.
  // - 위로 올리면 window의 시작점을 위로 이동(=이전 구간으로 이동)
  // - 아래(nearBottom)로 돌아오면 자동으로 최신 tail window로 리셋
  // NOTE: 대화가 길어질수록 각 메시지의 렌더/정규식 파싱 비용이 누적되어 UI가 버벅일 수 있음.
  // 따라서 "화면에 렌더하는 메시지 수"를 더 보수적으로 잡아서(기본 40)
  // 항상 일정한 DOM 크기로 유지한다.
  const WINDOW_RENDER_SIZE = 40;
  // (UX) 위로 스크롤로 이전 구간을 불러올 때는 '한 번에 한 페이지'처럼 점프하는 체감이 좋다.
  // 그래서 step도 render size에 맞춘다.
  const WINDOW_STEP = WINDOW_RENDER_SIZE;

  // messages 변경(삭제/편집/윈도우 이동 등) 시 페이지네이션 커서를 항상 최신으로 동기화
  useEffect(() => {
    oldestCreatedAtRef.current = (messages[0] as any)?.createdAt ?? null;
    newestCreatedAtRef.current = (messages[messages.length - 1] as any)?.createdAt ?? null;
  }, [messages]);


  // (성능) 메시지 렌더 window의 시작 인덱스
  const [windowStart, setWindowStart] = useState<number>(0);
  const windowStartRef = useRef<number>(0);
  const pinnedToBottomRef = useRef<boolean>(true);

  // ---- scroll/input refs (TS: callbacks below reference these, so declare early) ----
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  // 하단 고정 입력창 높이를 실시간으로 측정해 메시지 영역이 절대 침범되지 않도록 한다.
  const inputBarRef = useRef<HTMLDivElement | null>(null);
  const dockLastRef = useRef<{ left: number; width: number }>({ left: -1, width: -1 });
  // 하단 고정 입력창이 컨텐츠/스크롤을 가리지 않도록 확보하는 여백(px)
  // - 초기값이 과도하면(예: 360) 첫 렌더에서 '빈 공간'이 커 보일 수 있어 보수적으로 시작
  const [bottomInset, setBottomInset] = useState(240);
  const bottomInsetRef = useRef<number>(240);
  useEffect(() => {
    bottomInsetRef.current = bottomInset;
  }, [bottomInset]);

  // Mobile 1차: 뷰포트 높이/스크롤 영역을 모바일에 맞게 조정하기 위해 폭 기반 감지
  const [isMobile, setIsMobile] = useState(false);
  const [viewportHeightPx, setViewportHeightPx] = useState<number>(0);
  const [keyboardInsetPx, setKeyboardInsetPx] = useState<number>(0);
  useEffect(() => {
    windowStartRef.current = windowStart;
  }, [windowStart]);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // send()에서 발생한 오류를 사용자에게 노출하기 위한 상태
  const [, setSendError] = useState<string | null>(null);
  // 관리자만 클라이언트 개발자 로그를 보도록 제한
  const [canViewDeveloperMode, setCanViewDeveloperMode] = useState<boolean>(false);

  // In-flight /api/chat/send cancellation (abort + sequence gating)
  const sendAbortRef = useRef<AbortController | null>(null);
  const sendSeqGenRef = useRef<number>(0);
  const sendActiveSeqRef = useRef<number>(0);

  // FriendFee: avoid spamming /api/friendfee/state.
  // We refresh once after a send completes (done / JSON response).
  const friendFeeRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const friendFeeLastRefreshAtRef = useRef<number>(0);
  const refreshFriendFeeStateOnce = useCallback(async () => {
    if (LOCAL_POINTS_DISABLED) return;
    if (typeof window === "undefined") return;
    const now = Date.now();
    // Hard de-dupe within a short window (streaming done + JSON hydration etc.)
    if (now - friendFeeLastRefreshAtRef.current < 1200) return;
    if (friendFeeRefreshInFlightRef.current) return;
    friendFeeLastRefreshAtRef.current = now;

    const task = (async () => {
      try {
        const r = await fetch("/api/friendfee/state", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json().catch(() => null);
        if (j?.ok && typeof j.balance === "number") {
          // This will also dispatch a UI event (mate_friend_fee_updated)
          writeFriendFeeBalance(j.balance);
        }
      } catch {
        // ignore
      }
    })();

    friendFeeRefreshInFlightRef.current = task;
    try {
      await task;
    } finally {
      if (friendFeeRefreshInFlightRef.current === task) friendFeeRefreshInFlightRef.current = null;
    }
  }, []);

  // (기존 기능 유지용)
  // - 재생성/수정 흐름에서 사용되는 선택 메시지 id
  // - send() payload/리셋에서 참조하므로 반드시 존재해야 함
  const [selectedMsgIdForRegenerate, setSelectedMsgIdForRegenerate] = useState<string | null>(null);
  const [selectedMsgIdForRewrite, setSelectedMsgIdForRewrite] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // (UI) 추천답변 생성 중 표시/플로우 안정화
  const [suggestLoading, setSuggestLoading] = useState<boolean>(false);
  // 추천답변 요청 경쟁 상태 방지(연타/채팅 전환 시 stale 응답 무시)
  const suggestReqSeqRef = useRef<number>(0);
  const suggestChatIdRef = useRef<string>("");
  // (UI) 이미지 보기 토글
  // - ON: 마크다운 이미지 / 이미지 URL 라인 / {{img:..}} 이미지 모두 표시
  // - OFF: 출력된 이미지 전부 숨김 + 외부 이미지 URI/마크다운도 화면에서 제거
  const [showImages, setShowImages] = useState<boolean>(true);

  // (UI) 채팅방 텍스트 설정 (채팅별 localStorage)
  type ParaSpacing = "veryTight" | "tight" | "normal" | "wide" | "veryWide";
  const [chatFontSizePx, setChatFontSizePx] = useState<number>(18); // default 18px
  const [paraSpacing, setParaSpacing] = useState<ParaSpacing>("tight"); // default 좁게

  const paraGapPx = useMemo(() => {
    const map: Record<ParaSpacing, number> = {
      veryTight: 8,
      tight: 12,
      normal: 16,
      wide: 22,
      veryWide: 30,
    };
    return map[paraSpacing] ?? 12;
  }, [paraSpacing]);
  // 서버가 빈 바디로 응답하면 res.json()이 'Unexpected end of JSON input'로 터질 수 있음.
  // (특히 dev/proxy/중간 오류 상황) 모든 API 응답 파싱은 이 헬퍼로 안전 처리.
  async function safeJson(res: Response): Promise<any> {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // JSON이 아닐 때도(예: HTML 에러) caller가 메시지 출력할 수 있게 raw 포함
      return { _raw: text };
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/user/status", { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (cancelled || !res.ok) return;
        const role = String(json?.role || "").toLowerCase();
        setCanViewDeveloperMode(role === "admin");
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const devDebug = useCallback(
    (...args: any[]) => {
      if (!canViewDeveloperMode) return;
      console.debug(...args);
    },
    [canViewDeveloperMode]
  );
  const devWarn = useCallback(
    (...args: any[]) => {
      if (!canViewDeveloperMode) return;
      console.warn(...args);
    },
    [canViewDeveloperMode]
  );
  const devError = useCallback(
    (...args: any[]) => {
      if (!canViewDeveloperMode) return;
      console.error(...args);
    },
    [canViewDeveloperMode]
  );



  // 서버(DB)에 저장된 usage/cost 정보를 history에서 다시 불러와 메시지에 주입
  // - NDJSON 스트리밍(done) 응답에는 usage가 포함되어 있지 않기 때문에,
  //   토큰/비용 UI가 0 또는 공백으로 보이는 문제를 방지한다.
  const hydrateUsageForMessage = useCallback(
    async (messageId: string) => {
      if (!chatId || !messageId) return null;
      try {
        const res = await fetch(`/api/chat/history?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(messageId)}`);
        if (!res.ok) return null;
        const json = await safeJson(res);
        const msgs = Array.isArray(json?.messages) ? json.messages : [];
        const found = msgs.find((m: any) => m?.id === messageId)?.usage;
        if (!found) return null;
        setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, usage: found } : m)));
        return found;
      } catch {
        // ignore
        return null;
      }
    },
    [chatId]
  );


  // 메시지별 토큰/비용 팝업
  const [tokenPopup, setTokenPopup] = useState<{ open: boolean; title: string; usage?: any }>(
    { open: false, title: "", usage: null }
  );
  const tokenPopupMessageIdRef = useRef<string>("");

  const [tokenPopupAnchor, setTokenPopupAnchor] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null>(null);

  // -----------------------------
  // 친구비 0일 때 UX 팝업
  // -----------------------------
  const [friendFeeEmptyPopup, setFriendFeeEmptyPopup] = useState<{ open: boolean; text: string }>(
    { open: false, text: "" }
  );
  const friendFeeEmptyShownRef = useRef(false);

  const openFriendFeeEmptyPopup = useCallback(() => {
    // 과도한 연속 호출 방지(한 번 열렸으면 사용자가 닫을 때까지 유지)
    setFriendFeeEmptyPopup((prev) => {
      if (prev.open) return prev;
      return { open: true, text: pickFriendFeeEmptyLine() };
    });
  }, []);

  const closeFriendFeeEmptyPopup = useCallback(() => {
    setFriendFeeEmptyPopup({ open: false, text: "" });
  }, []);

  const goFriendFeeCharge = useCallback(() => {
    closeFriendFeeEmptyPopup();
    try {
      window.dispatchEvent(new Event("mate:openFriendFeePage"));
    } catch {
      // fallback: older modal open event
      window.dispatchEvent(new Event("mate:openFriendFee"));
    }
  }, [closeFriendFeeEmptyPopup]);

  // -----------------------------
  // 친구비 자동 차감 (assistant 메시지 완료 후)
  // -----------------------------
  const billingEnabledAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (billingEnabledAtRef.current != null) return;
    try {
      const k = "mate_friendfee_billing_enabled_at_v1";
      const raw = window.localStorage.getItem(k);
      const v = raw != null ? Number(raw) : NaN;
      const ts = Number.isFinite(v) && v > 0 ? v : Date.now();
      if (!Number.isFinite(v) || v <= 0) window.localStorage.setItem(k, String(ts));
      billingEnabledAtRef.current = ts;
    } catch {
      billingEnabledAtRef.current = Date.now();
    }
  }, []);

  const clearFriendFeeBilledMark = useCallback(
    (messageId: string) => {
      if (typeof window === "undefined") return;
      if (!chatId) return;
      const mid = String(messageId || "").trim();
      if (!mid) return;
      const billedKey = `mate_friendfee_billed_${chatId}_v1`;
      try {
        const raw = window.localStorage.getItem(billedKey);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return;
        const next = arr.map((x: any) => String(x)).filter((x: string) => x !== mid);
        window.localStorage.setItem(billedKey, JSON.stringify(next));
      } catch {
        // ignore
      }
    },
    [chatId]
  );

  useEffect(() => {
    if (LOCAL_POINTS_DISABLED) return;
    if (typeof window === "undefined") return;
    if (!chatId) return;
    const enabledAt = billingEnabledAtRef.current ?? 0;
    const billedKey = `mate_friendfee_billed_${chatId}_v1`;
    let billed = new Set<string>();
    try {
      const raw = window.localStorage.getItem(billedKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) billed = new Set(arr.map((x) => String(x)));
      }
    } catch {
      // ignore
    }

    let cancelled = false;

    (async () => {
      let changed = false;

      for (const m of messages) {
        if (cancelled) return;
        if (m.role !== "assistant") continue;
        if (!m?.id) continue;
        if (billed.has(m.id)) continue;
        if ((m.createdAt ?? 0) < enabledAt) continue; // 기능 적용 이전 메시지는 소급 차감하지 않음

        const total = Number(m.usage?.totalTokens);
        if (!Number.isFinite(total) || total <= 0) continue;

        const model = (m.usage?.model as string | undefined) ?? ("" + (m as any)?.model || undefined);

        // 서버(DB)에서 원자적으로 차감 (중복 차감 방지 + 기기/브라우저 동기화)
        try {
          const r = await fetch("/api/friendfee/spend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId, messageId: m.id, totalTokens: total, model }),
          });
          const j = await r.json().catch(() => null);

          if (j?.ok) {
            // 서버 잔액을 로컬 캐시에 반영 + 상단바 즉시 갱신 이벤트
            if (typeof j.balance === "number") writeFriendFeeBalance(j.balance);
            billed.add(m.id);
            changed = true;
          } else if (r.status === 402 || j?.error === "insufficient") {
            // 잔액 부족 UX 팝업(한 번만)
            if (!friendFeeEmptyShownRef.current) {
              friendFeeEmptyShownRef.current = true;
              openFriendFeeEmptyPopup();
            }
            // 부족일 때는 billed로 마킹하지 않음(충전 후 재시도 가능)
          }
        } catch {
          // 네트워크/서버 오류 시 로컬 차감은 하지 않는다.
        }
      }

      if (changed) {
        try {
          window.localStorage.setItem(billedKey, JSON.stringify(Array.from(billed)));
        } catch {
          // ignore
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, chatId, openFriendFeeEmptyPopup]);

    const [deletePopup, setDeletePopup] = useState<{ open: boolean; messageId: string; pairedUserId?: string }>(
      { open: false, messageId: "" }
    );
  // stream pacer와 분리된 수동 thinking 타겟(이어쓰기 등 JSON 응답 대기용)
  const [manualThinkingTargetId, setManualThinkingTargetId] = useState<string>("");
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    desc: string;
    confirmText: string;
    danger?: boolean;
    action?: "newChat" | "deleteChat" | "deleteProfile";
    profileId?: string;
  }>({ open: false, title: "", desc: "", confirmText: "확인" });

  const openConfirm = useCallback(
    (args: { title: string; desc: string; confirmText?: string; danger?: boolean; action: "newChat" | "deleteChat" | "deleteProfile"; profileId?: string }) => {
      setConfirmModal({
        open: true,
        title: args.title,
        desc: args.desc,
        confirmText: args.confirmText ?? "확인",
        danger: args.danger,
        action: args.action,
        profileId: args.profileId,
      });
    },
    []
  );


  // 채팅 설정 패널 접기/펼치기
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => (props.settingsUiMode === "drawer" ? false : true));
  const effectiveSettingsOpen = settingsUiMode === "drawer" ? (props.externalSettingsOpen ?? settingsOpen) : settingsOpen;

  const setUiSettingsOpen = (open: boolean) => {
    if (settingsUiMode === "drawer") {
      if (props.onExternalSettingsOpenChange) props.onExternalSettingsOpenChange(open);
      else setSettingsOpen(open);
    } else {
      setSettingsOpen(open);
    }
  };

  // 설정 Drawer 내부 뷰(홈 -> 각 설정) 전환
  const [settingsView, setSettingsView] = useState<"home" | "persona" | "userNote" | "model" | "room" | "memory" | "relations">("home");

  // Drawer 모드라도 "장기기억/관계도" 화면은 더 넓게 보이도록 도킹한다.
  // - 모바일(좁은 화면)에서는 기존처럼 drawer(overlay)로 유지
    const isMemoryDock =
      effectiveSettingsOpen && (settingsView === "memory" || settingsView === "relations") && !isMobile;
    // 관계도는 독립 캔버스로 본다. 데스크톱에서는 채팅 컬럼을
    // 잠시 숨겨 긴 관계 라벨과 많은 인물이 충분한 폭을 쓰게 한다.
    const isRelationshipFocus =
      effectiveSettingsOpen && settingsView === "relations" && !isMobile;

  // 페르소나 프로필(여러 개 저장/선택)
  const [profileModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<
    Array<{ id: string; personaName: string; personaAge: number; personaGender: string; personaInfo: string }>
  >([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) || null,
    [profiles, selectedProfileId]
  );
  const [profileDraft, setProfileDraft] = useState<{ id?: string; personaName: string; personaAge: number; personaGender: string; personaInfo: string }>(
    { personaName: "", personaAge: 0, personaGender: "남", personaInfo: "" }
  );

  const [personaApplyMsg, setPersonaApplyMsg] = useState<string>("");

  // Drawer가 열릴 때는 항상 홈으로 복귀
  useEffect(() => {
    if (settingsUiMode === "drawer" && effectiveSettingsOpen) {
      setSettingsView("home");
    }
  }, [settingsUiMode, effectiveSettingsOpen]);

  // (침범 방지) 페이지(body) 스크롤을 차단하고, 채팅 영역만 스크롤되도록 한다.
  // - 입력창이 길어져도 화면 전체가 아래로 밀리지 않게(=노란선 아래 침범 방지)
  useEffect(() => {
    // ChatArea는 html/body 스크롤을 잠가 "채팅 영역만" 스크롤되게 만든다.
    // 그런데 잠그기 직전에 페이지가 아래로 스크롤된 상태였다면,
    // 상단바가 화면 밖으로 밀린 채(그리고 스크롤은 잠겨) "상단바가 사라진 것처럼" 보이는 케이스가 생긴다.
    // 그래서 채팅 진입 시 window 스크롤을 0으로 리셋하고, 나갈 때는 원래 스크롤 위치를 복구한다.
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;

    const prevScrollX = typeof window !== "undefined" ? window.scrollX : 0;
    const prevScrollY = typeof window !== "undefined" ? window.scrollY : 0;

    try {
      if (typeof window !== "undefined") window.scrollTo(0, 0);
      // Safari/older browsers: 일부 환경에서 scrollTo만으로는 즉시 반영이 안 되는 경우가 있어 보강
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } catch {
      // ignore
    }

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
      try {
        if (typeof window !== "undefined") window.scrollTo(prevScrollX, prevScrollY);
      } catch {
        // ignore
      }
    };
  }, []);



  // 페르소나 설정 화면으로 진입 시: 선택된 프로필을 Draft에 반영(모달 없이 인라인 편집)
  const personaInitRef = useRef(false);
  useEffect(() => {
    if (settingsView !== "persona") {
      personaInitRef.current = false;
      return;
    }
    if (personaInitRef.current) return;
    personaInitRef.current = true;

    const pick =
      (selectedProfileId ? profiles.find((x) => x.id === selectedProfileId) : null) ||
      selectedProfile ||
      (profiles.length > 0 ? profiles[0] : null);

    if (pick) {
      setSelectedProfileId(pick.id);
      setProfileDraft({
        id: pick.id,
        personaName: pick.personaName,
        personaAge: pick.personaAge,
        personaGender: pick.personaGender || "남",
        personaInfo: pick.personaInfo,
      });
    } else {
      setSelectedProfileId("");
      setProfileDraft({ personaName: "", personaAge: 0, personaGender: "남", personaInfo: "" });
    }
  }, [settingsView, profiles, selectedProfile, selectedProfileId]);

  // (변경) 옛 장기기억(/api/chat/memory) UI/상태 제거 — MemoryPanel(DB 조회)만 사용

  // 채팅방 이름(제목) UI-only 저장 (DB/API는 건드리지 않음)
  const [chatTitle, setChatTitle] = useState<string>("");
  const [editingChatTitle, setEditingChatTitle] = useState(false);
  const [chatTitleDraft, setChatTitleDraft] = useState<string>("");
  const chatTitleInputRef = useRef<HTMLInputElement | null>(null);

  // 입력창 하단 모델 선택 드롭다운
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (modelMenuRef.current?.contains(t)) return;
      if (modelBtnRef.current?.contains(t)) return;
      setModelMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!chatId) {
      setChatTitle("");
      setEditingChatTitle(false);
      setChatTitleDraft("");
      return;
    }
    try {
      if (typeof window === "undefined") return;
      const k = `chatTitle:${chatId}`;
      const v = window.localStorage.getItem(k) || "";
      setChatTitle(v);
    } catch {
      // ignore
    }
  }, [chatId]);

  useEffect(() => {
    if (editingChatTitle) {
      requestAnimationFrame(() => {
        chatTitleInputRef.current?.focus();
        chatTitleInputRef.current?.select();
      });
    }
  }, [editingChatTitle]);


  const beginEditChatTitle = useCallback(() => {
    setChatTitleDraft(chatTitle || "");
    setEditingChatTitle(true);
  }, [chatTitle]);

  const cancelEditChatTitle = useCallback(() => {
    setEditingChatTitle(false);
    setChatTitleDraft("");
  }, []);

  const saveEditChatTitle = useCallback(() => {
    if (!chatId) {
      cancelEditChatTitle();
      return;
    }
    const v = (chatTitleDraft || "").trim();
    setChatTitle(v);
    try {
      if (typeof window !== "undefined") {
        const k = `chatTitle:${chatId}`;
        if (!v) window.localStorage.removeItem(k);
        else window.localStorage.setItem(k, v);
      }
    } catch {
      // ignore
    }
    setEditingChatTitle(false);
  }, [chatId, chatTitleDraft, cancelEditChatTitle]);



  // (요구사항) 최근 AI 답변 1개만 인라인 수정
  const [editingAssistantId, setEditingAssistantId] = useState<string>("");
  const [assistantDraft, setAssistantDraft] = useState<string>("");

  // (요구사항) 유저 메시지 수정: 해당 지점의 다음 AI 답변까지 재생성할 수 있도록
  const [editingUserId, setEditingUserId] = useState<string>("");
  const [userDraft, setUserDraft] = useState<string>("");

  // (성능) drafts 변경 핸들러를 안정화해서, 메인 입력 타이핑 시 메시지 리스트가 불필요하게 리렌더되지 않게 함
  const onChangeAssistantDraft = useCallback((v: string) => setAssistantDraft(v), []);
  const onChangeUserDraft = useCallback((v: string) => setUserDraft(v), []);

  // (성능) 진짜 windowing: 렌더 메시지 수를 고정
  // - 예전에는 "메시지가 충분히 많아질 때"(threshold)만 windowing을 켰는데,
  //   출력 1개당 글자 수가 큰 채팅(소설 모드)에서는 20~50턴만 쌓여도 UI가 급격히 느려질 수 있다.
  // - 따라서 **항상** windowing을 적용해 DOM/렌더 비용을 일정하게 유지한다.
  const CHAT_RENDER_TAIL_THRESHOLD = 0;

  // (성능/체감) 파생 상태(가시 구간/숨김 개수/마지막 ID 등)를 한 번에 계산하여
  // ChatArea.tsx 내부의 대형 useMemo 블록을 줄인다 (HMR/TS 서버 체감 개선).
  const {
    visibleMessages,
    hiddenMessageCount,
    hiddenNewerMessageCount,
    lastAssistantId,
    firstAssistantId,
  } = useMemo(
    () =>
      computeMessageWindow(messages, 0, {
        threshold: CHAT_RENDER_TAIL_THRESHOLD,
        defaultTail: WINDOW_RENDER_SIZE,
        windowStart,
        windowSize: Math.min(messages.length, WINDOW_RENDER_SIZE),
      }),
    [messages, windowStart]
  );

  // (windowing) pinned(nearBottom) 상태면 새 메시지가 쌓여도 항상 최신 tail window로 유지
  //             pinned가 아니면 현재 windowStart를 유지하되 범위를 벗어나면 clamp
  useEffect(() => {
    if (!messages.length) {
      setWindowStart(0);
      return;
    }
    const maxStart = Math.max(0, messages.length - WINDOW_RENDER_SIZE);
    if (pinnedToBottomRef.current) {
      setWindowStart(maxStart);
    } else {
      setWindowStart((ws) => Math.min(ws, maxStart));
    }
  }, [messages.length]);

  // (UI) MemoryPanel 자동 반영을 위한 키 (assistant 턴 완료 시 변경)
  const memoryUiKey = useMemo(() => {
    if (!chatId) return "";
    return `${chatId}:${lastAssistantId || ""}`;
  }, [chatId, lastAssistantId]);



  // (무한 스크롤 UX) 아래쪽에 가까우면 자동 스크롤/붙임 처리를 안정적으로 하기 위한 헬퍼
  const isNearBottom = useCallback((el: HTMLDivElement | null) => {
    if (!el) return true;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    return gap < 120;
  }, []);

  const updateNearBottom = useCallback(() => {
    const el = scrollRef.current;
    nearBottomRef.current = isNearBottom(el);
  }, [isNearBottom]);

  // (성능) window 크기는 고정. "더 보기"는 누적 확장이 아니라 "구간 이동"으로만 동작.
  const moveWindowUp = useCallback(
    (mode: "more" | "all") => {
      const el = scrollRef.current;
      // anchor: 현재 화면의 첫 메시지가 이동 후에도 같은 위치를 유지하도록 보정
      const anchorId = visibleMessages[0]?.id;
      const anchorEl = anchorId ? (el?.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLElement | null) : null;
      const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;

      pinnedToBottomRef.current = false;

      setWindowStart((prev) => {
        const next = mode === "all" ? 0 : Math.max(0, prev - WINDOW_STEP);
        return next;
      });

      requestAnimationFrame(() => {
        if (!el || !anchorId || anchorTop == null) return;
        const afterAnchorEl = el.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLElement | null;
        if (!afterAnchorEl) return;
        const afterTop = afterAnchorEl.getBoundingClientRect().top;
        const delta = afterTop - anchorTop;
        // delta만큼 보정해서 "한 번에 쭉" 점프하는 느낌을 줄인다
        el.scrollTop += delta;
      });
    },
    [visibleMessages]
  );

  const resetWindowToTail = useCallback(
    (alsoScrollToBottom: boolean) => {
      pinnedToBottomRef.current = true;
      setWindowStart(Math.max(0, messages.length - WINDOW_RENDER_SIZE));
      if (alsoScrollToBottom) {
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTop = el.scrollHeight;
        });
      }
    },
    [messages.length]
  );

const topAutoLoadLockRef = useRef(false);
  // 공통 토스트(알림) - 브라우저 alert 대신 앱 내 UI로 표시
  type ToastVariant = "success" | "error" | "info";
  const [toast, setToast] = useState<null | {
    title: string;
    message?: string;
    variant: ToastVariant;
  }>(null);
  const toastTimerRef = useRef<any>(null);

  const showToast = useCallback((title: string, message?: string, variant: ToastVariant = "info", ms = 2200) => {
    try {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    } catch {}
    // 요구사항: 토스트는 5초 이내 자동 종료
    const ttl = Math.min(5000, Math.max(1200, Number(ms) || 2200));
    setToast({ title, message, variant });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, ttl);
  }, []);

const loadOlder = useCallback(async () => {
    if (!chatId) return;
    if (loadingOlder) return;
    if (!hasMoreOlder) return;

    const targetChatId = chatId;
    const targetGeneration = chatContextGenerationRef.current;

    const before = oldestCreatedAtRef.current;
    if (before == null) return;

    const el = scrollRef.current;
    const beforeH = el?.scrollHeight ?? 0;
    const beforeTop = el?.scrollTop ?? 0;

    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/chat/history?chatId=${encodeURIComponent(chatId)}&limit=${HISTORY_PAGE_SIZE}&before=${encodeURIComponent(
          String(before)
        )}&includeUsage=0`
      );
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "이전 내용 불러오기 실패");
      if (
        activeChatIdRef.current !== targetChatId ||
        chatContextGenerationRef.current !== targetGeneration
      ) return;

      const page: Msg[] = Array.isArray(json?.messages) ? (json.messages as Msg[]) : [];
      const nextHasMore = !!json?.hasMoreOlder;

      if (page.length > 0) {
        // oldest cursor 업데이트(오름차순이므로 page[0]이 가장 오래된 메시지)
        oldestCreatedAtRef.current = (page[0] as any)?.createdAt ?? oldestCreatedAtRef.current;

        // prepend + dedupe
        let added = 0;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const add = page.filter((m) => m && !seen.has(m.id));
          if (!add.length) return prev;
          added = add.length;

          // prepend(older) → 오름차순 유지
          const merged = [...add, ...prev];

          // windowing: 오래된 구간을 유지(HEAD)하고, 초과분은 최신(TAIL)부터 버린다
          if (merged.length > WINDOW_HARD_CAP) {
            return merged.slice(0, WINDOW_HARD_CAP);
          }
          return merged;
        });

        // prepend로 인해 인덱스가 밀리므로, "현재 보고 있는 구간"이 유지되도록 windowStart를 보정한다.
        // - pinned(아래쪽 고정) 상태면 tail window가 유지되어야 하므로 여기서 건드리지 않는다.
        if (added > 0 && !pinnedToBottomRef.current) {
          setWindowStart((ws) => ws + added);
        }

        // window가 오래된 구간으로 이동하면서 최신 구간이 잘렸을 수 있으므로,
        // 아래로 스크롤 시 다시 불러올 수 있게 플래그를 켜둔다
        if (messages.length + page.length > WINDOW_HARD_CAP) setHasMoreNewer(true);

        // prepend 후 스크롤 위치 보정(화면이 튀지 않게)
        requestAnimationFrame(() => {
          const el2 = scrollRef.current;
          if (!el2) return;
          const afterH = el2.scrollHeight;
          const delta = afterH - beforeH;
          el2.scrollTop = beforeTop + delta;
        });
      }

      setHasMoreOlder(nextHasMore);
    } catch (e: any) {
      showToast("이전 내용 불러오기 실패", e?.message || "오류", "error", 3500);
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, hasMoreOlder, loadingOlder, showToast, messages.length]);

  const loadNewer = useCallback(async () => {
    if (!chatId) return;
    if (loadingNewer) return;
    if (!hasMoreNewer) return;

    const targetChatId = chatId;
    const targetGeneration = chatContextGenerationRef.current;

    const after = newestCreatedAtRef.current;
    if (after == null) return;

    setLoadingNewer(true);
    try {
      const res = await fetch(
        `/api/chat/history?chatId=${encodeURIComponent(chatId)}&limit=${HISTORY_PAGE_SIZE}&after=${encodeURIComponent(
          String(after)
        )}&includeUsage=0`
      );
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "다음 내용 불러오기 실패");
      if (
        activeChatIdRef.current !== targetChatId ||
        chatContextGenerationRef.current !== targetGeneration
      ) return;

      const page: Msg[] = Array.isArray(json?.messages) ? (json.messages as Msg[]) : [];
      const nextHasMore = !!json?.hasMoreNewer;

      if (page.length > 0) {
        // newest cursor 업데이트(오름차순이므로 마지막이 가장 최근)
        newestCreatedAtRef.current = (page[page.length - 1] as any)?.createdAt ?? newestCreatedAtRef.current;

        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const add = page.filter((m) => m && !seen.has(m.id));
          if (!add.length) return prev;

          const merged = [...prev, ...add];

          // windowing: 최신 구간을 유지(TAIL)하고, 초과분은 과거(HEAD)부터 버린다
          if (merged.length > WINDOW_HARD_CAP) {
            return merged.slice(merged.length - WINDOW_HARD_CAP);
          }
          return merged;
        });

        // window가 최신 구간으로 이동하면서 과거 구간이 잘렸을 수 있으므로,
        // 위로 스크롤 시 다시 불러올 수 있게 플래그를 켜둔다
        if (messages.length + page.length > WINDOW_HARD_CAP) setHasMoreOlder(true);
      }

      setHasMoreNewer(nextHasMore);
    } catch (e: any) {
      showToast("다음 내용 불러오기 실패", e?.message || "오류", "error", 3500);
    } finally {
      setLoadingNewer(false);
    }
  }, [chatId, hasMoreNewer, loadingNewer, showToast, HISTORY_PAGE_SIZE, messages.length]);


  // (스크롤 안정화)
  // - 스트리밍/입력창 리사이즈/리스트 리렌더 등으로 content 높이가 짧은 간격으로 계속 변하면
  //   scrollTop 보정이 여러 군데에서 중복으로 발생하며 "위아래로 떨림"(멀미) 현상이 생길 수 있다.
  // - 해결: "바닥 고정" 스크롤 보정은 한 프레임에 1번만(coalesce) 실행하고,
  //   프로그램 보정 중 발생한 onScroll은 사용자 스크롤로 오인하지 않도록 가드한다.
  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollingRef = useRef(false);
  const lastUserScrollAtRef = useRef(0);
  const ignoreUserScrollUntilRef = useRef(0);
  const markIgnoreUserScroll = (ms: number = 250) => {
    const now = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
    const until = now + ms;
    if (until > ignoreUserScrollUntilRef.current) ignoreUserScrollUntilRef.current = until;
  };

  const scheduleAutoScrollToBottom = useCallback((force: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (!force && !nearBottomRef.current) return;

    const now = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
    // 사용자가 방금 스크롤 중이면(휠/드래그/트랙패드), 자동 보정은 잠깐 멈춘다.
    if (!force && now - lastUserScrollAtRef.current < 160) return;

    if (autoScrollRafRef.current != null) return;
    autoScrollRafRef.current = requestAnimationFrame(() => {
      autoScrollRafRef.current = null;
      const el2 = scrollRef.current;
      if (!el2) return;
      if (!force && !nearBottomRef.current) return;
      const now2 = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
      if (!force && now2 - lastUserScrollAtRef.current < 160) return;

      markIgnoreUserScroll(220);

      autoScrollingRef.current = true;
      // scrollHeight로 세팅하면 브라우저가 clamp 하긴 하지만,
      // 연속 리플로우 상황에서 미세한 오버/언더 보정이 반복되며 떨림이 생길 수 있어
      // maxScrollTop(=scrollHeight-clientHeight)로 정확히 맞춘다.
      const maxTop = Math.max(0, el2.scrollHeight - el2.clientHeight);
      // (진동 방지) 동일/1px 수준 보정은 생략해 스크롤 이벤트 폭주를 막는다.
      if (Math.abs(el2.scrollTop - maxTop) > 1) el2.scrollTop = maxTop;
      pinnedToBottomRef.current = true;
      nearBottomRef.current = true;

      requestAnimationFrame(() => {
        autoScrollingRef.current = false;
      });
    });
  }, []);


  // (windowing UX) 맨 위에서 "더 위로" 스크롤(휠 업)을 시도하면 바로 이전 구간을 로드한다.
  // - onScroll은 scrollTop이 변할 때만 발생하므로, 이미 맨 위(0)에서 wheel을 올리면
  //   preventDefault 때문에 onScroll이 안 타는 케이스가 있다.
  // - 영상처럼 "한 번에 툭" 이전 구간이 뜨도록 wheel-capture에서도 동일한 트리거를 호출한다.
  const triggerTopAutoLoad = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (topAutoLoadLockRef.current) return;
    topAutoLoadLockRef.current = true;
    window.setTimeout(() => {
      topAutoLoadLockRef.current = false;
    }, 220);

    // 로드/윈도우 이동으로 인한 scrollTop 보정은 사용자 스크롤로 오인하지 않게 한다.
    markIgnoreUserScroll(420);

    // 1) 이미 메모리에 있는 older(위쪽) 구간이면 windowStart를 위로 이동
    if (hiddenMessageCount > 0) {
      moveWindowUp("more");
      return;
    }
    // 2) 서버에서 이전 페이지 로드
    if (hasMoreOlder && !loadingOlder) {
      loadOlder();
    }
  }, [hiddenMessageCount, hasMoreOlder, loadingOlder, loadOlder, moveWindowUp]);


  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const now = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
    const ignoreUser = now < ignoreUserScrollUntilRef.current;

    // 프로그램(auto) 스크롤/레이아웃 변경으로 유발된 스크롤 이벤트는
    // "사용자 스크롤"로 오인하면 pinned 상태가 풀렸다가 다시 붙는 과정에서 화면이 출렁인다.
    if (!autoScrollingRef.current && !ignoreUser) {
      lastUserScrollAtRef.current = now;
    }

    const near = isNearBottom(el);
    nearBottomRef.current = near;

    if (autoScrollingRef.current || ignoreUser) {
      // auto/레이아웃 유발 스크롤은 windowing/로드 트리거를 건드리지 않는다.
      if (near) pinnedToBottomRef.current = true;
      return;
    }

    // (windowing) 아래(nearBottom)로 돌아오면 항상 최신 tail window로 자동 리셋
    if (near) {
      if (!pinnedToBottomRef.current) {
        resetWindowToTail(false);
      }

      // (windowing) 아래쪽으로 내려왔을 때, 잘려나간 최신 구간이 있으면 다시 불러온다
      if (hasMoreNewer && !loadingNewer) {
        loadNewer();
      }
      return;
    } else {
      pinnedToBottomRef.current = false;
    }

    if (el.scrollTop > 140) return;
    triggerTopAutoLoad();
  }, [hasMoreNewer, loadingNewer, loadNewer, isNearBottom, resetWindowToTail, triggerTopAutoLoad]);

  // (UX) 스크롤 컨테이너 상단/하단에서 wheel이 body로 "새는" 현상을 차단
  // - 특히 "맨 위에서 계속 휠"하면 페이지 전체가 스크롤되거나 멈칫하는 느낌이 발생
  const onChatWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;

    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    // 맨 위/아래에서 wheel이 body로 새지 않게 차단
    if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) {
      e.preventDefault();
    }
    // (핵심) 이미 맨 위(0)에서 wheel-up을 하면 onScroll이 안 타는 케이스가 있어
    // wheel-capture에서 곧바로 이전 구간 로드를 트리거한다.
    if (atTop && e.deltaY < 0) {
      triggerTopAutoLoad();
    }
  }, [triggerTopAutoLoad]);



  // (intro) 첫 assistant 메시지는 '가이드/배너' 같은 문서형 텍스트가 많아,
  // 따옴표로 실제 대사를 표시한 줄만 대사로 취급하고(그 외는 지문),
  // UI가 모든 줄에 자동 따옴표/대사 박스를 씌우는 오해를 방지한다.
  // - firstAssistantId는 computeMessageWindow()에서 visibleMessages 기반으로 계산된다.



  // (요구사항 #4) 같은 작품(프리셋) 안에서 여러 채팅을 선택할 수 있어야 함
  const [chatList, setChatList] = useState<
    Array<{ id: string; createdAt: number; title: string; lastMessage: string }>
  >([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(!!mq.matches);
    update();
    try {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    } catch {
      // Safari fallback (legacy)
      (mq as any).addListener?.(update);
      return () => (mq as any).removeListener?.(update);
    }
  }, []);

  // Mobile 2차: visualViewport를 우선 사용해 키보드/브라우저 UI 변화 시 실제 표시 높이를 반영한다.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;

    const updateViewportMetrics = () => {
      const rawHeight = vv?.height ?? window.innerHeight;
      const nextHeight = Math.max(320, Math.round(rawHeight || 0));

      const layoutHeight = Math.max(0, Math.round(window.innerHeight || 0));
      const vvBottom = vv
        ? Math.round((vv.height || 0) + (vv.offsetTop || 0))
        : layoutHeight;
      const rawInset = Math.max(0, layoutHeight - vvBottom);

      const activeEl = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
      const activeTag = String(activeEl?.tagName || "").toLowerCase();
      const activeInputType =
        activeTag === "input" ? String((activeEl as HTMLInputElement).type || "").toLowerCase() : "";
      const textLikeInput =
        activeTag === "textarea" ||
        (activeTag === "input" &&
          !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(activeInputType)) ||
        Boolean(activeEl?.isContentEditable);

      // 주소창 높이 변화(작은 inset)와 소프트키보드(큰 inset)를 구분해 과한 점프를 막는다.
      const nextKeyboardInset = rawInset >= 120 || textLikeInput ? rawInset : 0;

      setViewportHeightPx((prev) => (Math.abs(prev - nextHeight) >= 2 ? nextHeight : prev));
      setKeyboardInsetPx((prev) => (Math.abs(prev - nextKeyboardInset) >= 2 ? nextKeyboardInset : prev));
    };

    updateViewportMetrics();
    window.addEventListener("resize", updateViewportMetrics);
    window.addEventListener("orientationchange", updateViewportMetrics);
    vv?.addEventListener("resize", updateViewportMetrics);
    vv?.addEventListener("scroll", updateViewportMetrics);
    return () => {
      window.removeEventListener("resize", updateViewportMetrics);
      window.removeEventListener("orientationchange", updateViewportMetrics);
      vv?.removeEventListener("resize", updateViewportMetrics);
      vv?.removeEventListener("scroll", updateViewportMetrics);
    };
  }, []);

  // 입력창 높이가 변해 bottomInset이 달라질 때, 사용자가 바닥을 보고 있는 상태면
  // 마지막 메시지가 다시 입력창 아래로 '가려져 보이는' 것을 방지하기 위해 자동으로 끝으로 재정렬한다.
  useEffect(() => {
    scheduleAutoScrollToBottom(false);
  }, [bottomInset, scheduleAutoScrollToBottom]);

  // 모바일 키보드 표시/숨김으로 실제 입력바 위치가 변할 때도 바닥 메시지 가림을 방지한다.
  useEffect(() => {
    if (!isMobile) return;
    scheduleAutoScrollToBottom(false);
  }, [isMobile, keyboardInsetPx, scheduleAutoScrollToBottom]);

  // {{img:REFKEY}} 토큰 파서
  // NOTE: 이미지 기능은 현재 '정상 기준선' 밖이지만, 기존 렌더링이 이 함수를 참조하므로
  //       런타임 ReferenceError가 나지 않도록 컴포넌트 스코프에 안전하게 고정한다.
  function splitByImgToken(input: string) {
    const blocks: Array<{ type: "text"; text: string } | { type: "img"; key: string }> = [];
    const re = /\{\{img:([^}]+)\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const start = m.index;
      const end = re.lastIndex;
      const before = input.slice(last, start);
      if (before) blocks.push({ type: "text", text: before });
      const key = String(m[1] || "").trim();
      if (key) blocks.push({ type: "img", key });
      last = end;
    }
    const tail = input.slice(last);
    if (tail) blocks.push({ type: "text", text: tail });
    return blocks.length ? blocks : [{ type: "text" as const, text: input }];
  }

  // (HTML) 소설 모드에서 <table>...</table> 블록은 그대로 렌더링하되,
  // 나머지 텍스트(대사/지문/이미지 토큰 정책)는 기존 소설 렌더 경로를 유지해야 한다.
  // 과거에는 "텍스트 청크에 <table>이 포함되면 청크 전체를 renderMarkdownLite"로 처리해서
  // {{img:...}} 토큰이 텍스트로 노출되거나, 대사/지문 색 규칙이 무시되는 문제가 있었다.
  function escapeTableCellForRender(s: string) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function tabRowsToHtmlForRender(rows: string[][]) {
    if (rows.length < 2) return rows.map((r) => r.join("\t")).join("\n");
    const cols = Math.max(...rows.map((r) => r.length));
    const norm = rows.map((r) => Array.from({ length: cols }, (_, i) => String(r[i] || "").trim()));
    const head = norm[0] || [];
    const body = norm.slice(1);
    return `<table><thead><tr>${head.map((c) => `<th>${escapeTableCellForRender(c)}</th>`).join("")}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${escapeTableCellForRender(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  }

  function convertTabTablesToHtmlForRender(input: string) {
    const lines = String(input || "").replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let group: string[] = [];
    const flush = () => {
      if (!group.length) return;
      out.push(group.length >= 2 ? tabRowsToHtmlForRender(group.map((line) => line.split("\t"))) : group[0]);
      group = [];
    };
    for (const line of lines) {
      const cols = line.split("\t");
      const isTableLine = cols.length >= 2 && cols.some((c) => c.trim());
      if (isTableLine) group.push(line);
      else {
        flush();
        out.push(line);
      }
    }
    flush();
    return out.join("\n");
  }

  function extractHtmlTablesToTokens(input: string) {
    const s = convertTabTablesToHtmlForRender(String(input || ""));
    const tables: string[] = [];
    const re = /<table[\s>][\s\S]*?<\/table\s*>/gi;
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const start = m.index;
      const end = re.lastIndex;
      out += s.slice(last, start);
      const id = tables.length;
      tables.push(String(m[0] || ""));
      // 토큰이 라인 시작으로 남도록(=line-start fence/토큰 파서 경로 유지)
      out += `\n{{htmltbl:${id}}}\n`;
      last = end;
    }
    out += s.slice(last);
    return { text: out, tables };
  }

  const updateDocking = useCallback(() => {
    const el = inputBarRef.current;
    if (el) {
      const h = Math.max(0, (el as any).offsetHeight || 0);
      // 안전 여백(여유 공간) 포함 (고정 입력창/하단 칩/그림자 등 포함해서 넉넉히)
      // inputBarRef의 offsetHeight(h)에는 safe-area/padding까지 포함된다.
      // 겹침 방지용 여유는 과도하지 않게 잡아(=스크롤 영역이 불필요하게 좁아지지 않게) 최소치만 더한다.
      const nextInset = Math.max(160, h + 24);
      const prevInset = bottomInsetRef.current || 0;
      // (진동 방지) 서브픽셀/반올림으로 1px 수준의 변동이 자주 발생하면
      // 입력창/하단 여백이 계속 재계산되며 스크롤/줄바꿈이 흔들릴 수 있다.
      // 실제 줄수 변화는 보통 20px+로 크게 변하므로, 작은 변동은 무시한다.
      if (Math.abs(nextInset - prevInset) >= 6) {
        // inset 변화로 scrollTop이 clamp 되며 onScroll이 튈 수 있어, 잠깐 사용자 스크롤 판정을 막는다.
        markIgnoreUserScroll(320);
        bottomInsetRef.current = nextInset;
        setBottomInset(nextInset);
      }
    }
    // (UI) 메인 레이아웃이 바뀌어도 입력창이 채팅 컬럼과 항상 수평 정렬되도록 도킹 좌표를 갱신한다.
    try {
      const c = contentRef.current;
      const sref = scrollRef.current;
      let r = c ? c.getBoundingClientRect() : null;
      // 도킹 토글 순간 contentRef가 0px로 튀는 경우가 있어 scrollRef로 fallback
      if ((!r || r.width < 50) && sref) r = sref.getBoundingClientRect();
      if (r) {
        const left = Math.max(0, Math.floor(r.left));
        // Mobile 1차: 작은 화면/분할 화면에서 320px 강제 때문에 입력창이 잘리는 문제 완화
        const rawW = Math.max(0, Math.floor(r.width));
        const winW = typeof window !== "undefined" ? Math.max(0, Math.floor(window.innerWidth || 0)) : rawW;
        const width = winW > 0 ? Math.min(rawW, winW) : rawW;

        const prev = dockLastRef.current;
        // (진동 방지) 1px 수준의 잦은 도킹 좌표 변경은 입력창 래핑/높이 변화를 유발해 화면이 흔들릴 수 있다.
        if (Math.abs(left - prev.left) >= 2 || Math.abs(width - prev.width) >= 2) {
          dockLastRef.current = { left, width };
          document.documentElement.style.setProperty("--chatDockLeft", `${left}px`);
          document.documentElement.style.setProperty("--chatDockWidth", `${width}px`);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    const el = inputBarRef.current;
    if (!el) return;

    updateDocking();

    const ro = new ResizeObserver(() => updateDocking());
    ro.observe(el);
    window.addEventListener("resize", updateDocking);
    return () => {
      try {
        ro.disconnect();
      } catch {}
      window.removeEventListener("resize", updateDocking);
    };
  }, [updateDocking]);

  // Sidebar 접기/펼치기처럼 "위치"만 바뀌는 레이아웃 변화는 ResizeObserver로 잡히지 않을 수 있다.
  // layoutKey가 바뀌면 rAF/timeout으로 한 번 더 도킹 좌표를 재계산해
  // 메시지 컬럼과 하단 입력창이 절대 따로 놀지 않게 한다.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // 레이아웃 트랜지션(예: width/transform) 이후에도 한 번 더 보정
    const id1 = requestAnimationFrame(() => updateDocking());
    const id2 = requestAnimationFrame(() => requestAnimationFrame(() => updateDocking()));
    const t = window.setTimeout(() => updateDocking(), 260);
    return () => {
      try {
        cancelAnimationFrame(id1);
        cancelAnimationFrame(id2);
      } catch {}
      window.clearTimeout(t);
    };
  }, [layoutKey, props.externalSettingsOpen, isMobile, settingsOpen, settingsView, settingsUiMode, isMemoryDock, updateDocking]);

  useEffect(() => {
    updateDocking();
  }, [viewportHeightPx, updateDocking]);



  // (무한 스크롤) 위로 올렸을 때, 서버(DB)에서 이전 구간을 추가로 불러와 앞에 붙인다.
  
  const scrollToBottomIfAllowed = useCallback(() => {
    scheduleAutoScrollToBottom(false);
  }, [scheduleAutoScrollToBottom]);

  const scrollToBottomForce = useCallback(() => {
    scheduleAutoScrollToBottom(true);
  }, [scheduleAutoScrollToBottom]);

  // settings state (저장 후 유지)
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  


  const bottomRef = useRef<HTMLDivElement | null>(null);


  // React 개발 모드가 mount effect를 재실행해도 첫 번째 실행에서 소비한 진입 의도를 유지한다.
  // 그렇지 않으면 두 번째 실행이 /latest를 불러와 방금 만든 채팅을 예전 대화로 덮을 수 있다.
  const forceNewChatIntentRef = useRef<string>("");
  const forceNewChatStartedRef = useRef<string>("");
  const forceOpenChatIntentRef = useRef<{ presetId: string; chatId: string } | null>(null);
  const forceOpenChatAppliedRef = useRef<string>("");
  // busy state가 렌더에 반영되기 전의 빠른 연속 클릭도 생성 POST를 하나로 합친다.
  const createChatInFlightRef = useRef(false);

  const consumeForceNewChatFlag = useCallback(
    (pid: string) => {
      // 작품 탭에서 "새 대화 시작" 버튼을 누르면 localStorage에 presetId를 기록해둠.
      // 채팅 탭 진입 시 이 플래그가 있으면 최신 채팅을 로드하지 말고 새 채팅을 생성한다.
      if (forceNewChatIntentRef.current === pid) return true;
      try {
        const key = "forceNewChatPresetId";
        const v = window.localStorage.getItem(key) || "";
        if (v && v === pid) {
          window.localStorage.removeItem(key);
          forceNewChatIntentRef.current = pid;
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    },
    []
  );

  const consumeForceOpenChatId = useCallback((pid: string) => {
    // 작품 상세에서 이어하기 목록을 선택한 경우, 지정한 chatId를 우선 열어준다.
    const cached = forceOpenChatIntentRef.current;
    if (cached?.presetId === pid && cached.chatId) return cached.chatId;
    try {
      const pidKey = "forceOpenChatPresetId";
      const chatKey = "forceOpenChatId";
      const targetPid = window.localStorage.getItem(pidKey) || "";
      const targetChatId = window.localStorage.getItem(chatKey) || "";
      if (targetPid && targetPid === pid && targetChatId) {
        window.localStorage.removeItem(pidKey);
        window.localStorage.removeItem(chatKey);
        forceOpenChatIntentRef.current = { presetId: pid, chatId: targetChatId };
        return targetChatId;
      }
    } catch {
      // ignore
    }
    return "";
  }, []);

  const selectedPreset = useMemo(() => {
    if (!presetId) return null;
    return presets.find((p) => p.id === presetId) || null;
  }, [presetId, presets]);
  const effectiveChatTitle = useMemo(() => {
    const t = (chatTitle || "").trim();
    if (t) return t;
    // 기본 표시 이름: 작품명(프리셋명)
    const presetName = String(selectedPreset?.name || "").trim();
    return presetName || "채팅";
  }, [chatTitle, selectedPreset]);



  // (UI) 이미지 보기 토글: 채팅별로 저장(localStorage)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const scope = chatId ? `chat:${chatId}` : presetId ? `preset:${presetId}` : "global";
      const key = `ai:showImages:${scope}`;
      const v = window.localStorage.getItem(key);
      if (v === "0") setShowImages(false);
      else if (v === "1") setShowImages(true);
      // 없으면 기본값(true) 유지
    } catch {
      // ignore
    }
  }, [chatId, presetId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const scope = chatId ? `chat:${chatId}` : presetId ? `preset:${presetId}` : "global";
      const key = `ai:showImages:${scope}`;
      window.localStorage.setItem(key, showImages ? "1" : "0");
    } catch {
      // ignore
    }
  }, [chatId, presetId, showImages]);

  // (UI) 채팅별 텍스트 설정 로드
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const scope = chatId ? `chat:${chatId}` : presetId ? `preset:${presetId}` : "global";
      const kSize = `ai:chatFontSize:${scope}`;
      const kPara = `ai:paraSpacing:${scope}`;
      const vSize = window.localStorage.getItem(kSize);
      if (vSize) {
        const n = Math.max(12, Math.min(24, Number(vSize)));
        if (Number.isFinite(n)) setChatFontSizePx(n);
      }
      const vPara = window.localStorage.getItem(kPara);
      if (vPara === "veryTight" || vPara === "tight" || vPara === "normal" || vPara === "wide" || vPara === "veryWide") {
        setParaSpacing(vPara as ParaSpacing);
      }
      // 없으면 default 유지(18px, tight)
    } catch {
      // ignore
    }
  }, [chatId, presetId]);

  // (UI) 채팅별 텍스트 설정 저장
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const scope = chatId ? `chat:${chatId}` : presetId ? `preset:${presetId}` : "global";
      const kSize = `ai:chatFontSize:${scope}`;
      const kPara = `ai:paraSpacing:${scope}`;
      window.localStorage.setItem(kSize, String(Math.max(12, Math.min(24, chatFontSizePx))));
      window.localStorage.setItem(kPara, paraSpacing);
    } catch {
      // ignore
    }
  }, [chatId, presetId, chatFontSizePx, paraSpacing]);



// 갤러리(Workspace) 이미지: {{img:REFKEY}} 토큰으로 채팅/소설 출력 중간에 삽입 가능
// preset.gallery는 JSON 문자열로 저장된다. (GalleryItem[] 포맷)
  const galleryMap = useMemo(() => buildGalleryMap((selectedPreset as any)?.gallery), [selectedPreset]);


  const npcName = (selectedPreset?.characterName || "상대").trim() || "상대";
  const userName = (settings?.personaName || selectedProfile?.personaName || "나").trim() || "나";

  // Chat UI theme (dark, novel-focused). 다른 화면(작업실 등) 테마는 추후 분리 가능.
  // (성능) 렌더마다 객체가 새로 생성되면 하위 콜백/컴포넌트가 매번 새 타입으로 인식될 수 있으므로 고정한다.
  const CHAT_THEME = useMemo(
    () => ({
    // 영상 스타일에 맞춰 '완전 블랙' 기반으로 정리
    // Global background palette
    bg: "var(--app-bg)",
    bg2: "var(--markdown-bg)",
    panel: "transparent",
    bubbleUser: "transparent",
    bubbleAssistant: "transparent",
    border: "rgba(255,255,255,0.10)",
    borderStrong: "rgba(255,255,255,0.16)",
    text: "#e5e7eb",
    muted: "rgba(229,231,235,0.70)",
    // 보조 패널/카드 배경
    panel2: "rgba(255,255,255,0.04)",
    // 강조색(버튼/하이라이트)
    accent: "#a78bfa",
    iconBg: "rgba(255,255,255,0.06)",
    iconBorder: "rgba(255,255,255,0.14)",
    // 기본 지문 색상(요청): rgb(204,199,199)
    // (헌법) 소설 지문은 항상 흰색 고정 (회색 금지)
    narration: "#ffffff",
    speech: "#e5e7eb",
    thought: "#c7d2fe",
    name: "#a78bfa",
    }),
    []
  );

  const renderInline = useCallback(
    (text: string) => {
      // Inline stage-direction / 주석 처리:
      // - 대사 중간/끝에 "*...*" 또는 "**...**" 형태로 넣어도 항상 보이게 처리한다.
      // - 별표 자체는 화면에 노출하지 않고(마커 제거), 내부 텍스트만 '지문/주석' 톤으로 렌더한다.
      // - 전각/유사 별표(＊∗ 등)도 '*'로 정규화하여 동일하게 동작한다.
      const s = normalizeStarVariants(String(text || ""));
      const parts: React.ReactNode[] = [];
      let i = 0;
      let k = 0;

      while (i < s.length) {
        const a = s.indexOf("*", i);
        if (a === -1) {
          parts.push(s.slice(i));
          break;
        }

        // support **...** as well
        const isDouble = s.slice(a, a + 2) === "**";
        const marker = isDouble ? "**" : "*";
        const markerLen = isDouble ? 2 : 1;
        const close = s.indexOf(marker, a + markerLen);

        // No closing marker -> keep the remainder as-is (so user can see what they typed)
        if (close === -1) {
          parts.push(s.slice(i));
          break;
        }

        if (a > i) parts.push(s.slice(i, a));

        const inner = s.slice(a + markerLen, close);
        parts.push(
          <span
            key={`aside-${k++}`}
            style={{
              color: "rgba(229,231,235,0.72)",
              fontStyle: "italic",
            }}
          >
            {inner}
          </span>
        );
        i = close + markerLen;
      }

      return <>{parts}</>;
    },
    []
  );

  


  // (novel) 대사/속마음 색상 하이라이트
  // - "..." / “...” : 대사 (rgb(253,186,116))
  // - '...'           : 속마음 (rgb(34,197,94))
  // - *...* / **...** : 지문 마커는 유지하되, 출력에서는 * 문자를 제거한다.
  const NOVEL_DIALOGUE_COLOR = "rgb(253,186,116)";
  const NOVEL_THOUGHT_COLOR = "rgb(34,197,94)";

  // (readability) 메시지 본문을 아주 살짝만 굵게
  // (UI) 소설 모드 본문이 너무 얇아 가독성이 떨어진다는 피드백이 있어,
  // 본문만 살짝 굵게(기존 파싱/색/레이아웃 로직 불변).
  const NOVEL_TEXT_WEIGHT = 600;

  const renderNovelInlineColored = useCallback((rawText: string) => {
    const nodes: React.ReactNode[] = [];
    let k = 0;

    // "\" ..." 처럼 따옴표 직후 공백, 끝의 "" 중복, 닫기 직전의 * 잔상 등을 정리해서
    // 대사/속마음 하이라이트가 깔끔하게 보이도록 한다(표현은 유지, 렌더링만 정리).
    const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const normalizeQuotedChunk = (chunkRaw: string, closeChar: string) => {
      let s = String(chunkRaw || "");
      if (!s) return s;
      // 1) opening quote 이후 공백 제거
      // (fix) 따옴표 바로 뒤에 zero-width 문자(\u200B 등)가 끼면 \s 매칭이 실패해
		  // 화면에 " 공백이 재발할 수 있음.
		  // 또한 일부 모델/스트리밍 조각에서 \u180E 같은 '눈에는 공백처럼 보이는' format 문자가 섞여 나오는 케이스가 있어
		  // 이를 함께 제거한다.
      if (s.length >= 2) {
        s =
          s[0] +
          s
            .slice(1)
		        .replace(/^[\s\u00A0\uFEFF\u180E\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\u202A-\u202E]+/, "");
      }
      // 2) 닫기 직전 * 잔상 제거 (예: "...*" )
      const closeRe = escRe(closeChar);
      s = s.replace(new RegExp(`\\*+\\s*(?=${closeRe}+$)`), "");
      // 3) 닫는 따옴표 중복 축약 (예: "" -> ")
      s = s.replace(new RegExp(`${closeRe}{2,}$`), closeChar);
      return s;
    };

    const pushColored = (chunk: string, color: string) => {
      if (!chunk) return;
      nodes.push(
        <span key={`q-${k++}`} style={{ color }}>
          {chunk}
        </span>
      );
    };

    const nextIndexOfAny = (s: string, start: number, needles: string[]) => {
      let best = -1;
      let needle = "";
      for (const n of needles) {
        const p = s.indexOf(n, start);
        if (p !== -1 && (best === -1 || p < best)) {
          best = p;
          needle = n;
        }
      }
      return { pos: best, needle };
    };

    const parseQuotes = (seg: string) => {
      let i = 0;
	      while (i < seg.length) {
	        // 모델이 가끔 fullwidth/닫는따옴표(＂/”)로 시작하는 케이스가 있어 함께 처리
	        const hit = nextIndexOfAny(seg, i, ['"', '＂', '“', '”', "'"]);
        if (hit.pos === -1) {
          const tail = seg.slice(i);
          if (tail) nodes.push(tail);
          break;
        }
        if (hit.pos > i) {
          const plain = seg.slice(i, hit.pos);
          if (plain) nodes.push(plain);
        }

        if (hit.needle === "'") {
          let end = seg.indexOf("'", hit.pos + 1);
          if (end === -1) {
            const tail = seg.slice(hit.pos);
            // 스트리밍 중 닫는 따옴표가 아직 오지 않았어도 속마음 색을 유지한다.
            pushColored(tail, NOVEL_THOUGHT_COLOR);
            break;
          }
          // 연속된 '' 같은 중복 닫기까지 포함
          while (end + 1 < seg.length && seg[end + 1] === "'") end++;
          const q = normalizeQuotedChunk(seg.slice(hit.pos, end + 1), "'");
          pushColored(q, NOVEL_THOUGHT_COLOR);
          i = end + 1;
          continue;
        }

        // double quotes: "..." or “...”
        // fullwidth double quotes: ＂...＂
        if (hit.needle === '＂') {
          let end = seg.indexOf('＂', hit.pos + 1);
          if (end === -1) {
            const tail = seg.slice(hit.pos);
            // 닫힘 전 스트리밍 조각도 대사로 보이게 한다.
            pushColored(tail, NOVEL_DIALOGUE_COLOR);
            break;
          }
          // 연속된 닫기 따옴표까지 포함
          while (end + 1 < seg.length && seg[end + 1] === '＂') end++;
          const q = normalizeQuotedChunk(seg.slice(hit.pos, end + 1), '＂');
          pushColored(q, NOVEL_DIALOGUE_COLOR);
          i = end + 1;
          continue;
        }

        // closing curly double quote used as opener: ”...”(fallback to normal ")
        if (hit.needle === '”') {
          let end = seg.indexOf('”', hit.pos + 1);
          let closeChar: string = '”';
          if (end === -1) {
            end = seg.indexOf('"', hit.pos + 1);
            closeChar = '"';
          }
          if (end === -1) {
            const tail = seg.slice(hit.pos);
            pushColored(tail, NOVEL_DIALOGUE_COLOR);
            break;
          }
          while (end + 1 < seg.length && seg[end + 1] === closeChar) end++;
          const q = normalizeQuotedChunk(seg.slice(hit.pos, end + 1), closeChar);
          pushColored(q, NOVEL_DIALOGUE_COLOR);
          i = end + 1;
          continue;
        }

        if (hit.needle === '“') {
          let end = seg.indexOf('”', hit.pos + 1);
          let closeChar = '”';
          if (end === -1) {
            // fallback: sometimes the model mixes curly/open quote with normal close quote
            end = seg.indexOf('"', hit.pos + 1);
            closeChar = '"';
          }
          if (end === -1) {
            const tail = seg.slice(hit.pos);
            pushColored(tail, NOVEL_DIALOGUE_COLOR);
            break;
          }
          // 연속된 닫기 따옴표까지 포함
          while (end + 1 < seg.length && seg[end + 1] === closeChar) end++;
          const q = normalizeQuotedChunk(seg.slice(hit.pos, end + 1), closeChar);
          pushColored(q, NOVEL_DIALOGUE_COLOR);
          i = end + 1;
          continue;
        }

        // hit.needle === '"'
        let end = seg.indexOf('"', hit.pos + 1);
        if (end === -1) {
          const tail = seg.slice(hit.pos);
          pushColored(tail, NOVEL_DIALOGUE_COLOR);
          break;
        }
        // 연속된 "" 같은 중복 닫기까지 포함
        while (end + 1 < seg.length && seg[end + 1] === '"') end++;
        const q = normalizeQuotedChunk(seg.slice(hit.pos, end + 1), '"');
        pushColored(q, NOVEL_DIALOGUE_COLOR);
        i = end + 1;
      }
    };

    // 1) *...* / **...** 마커 제거 + 내부도 quotes 파싱
    const t = normalizeStarVariants(String(rawText || ""));
    let i = 0;
    while (i < t.length) {
      const a = t.indexOf('*', i);
      if (a === -1) {
        parseQuotes(t.slice(i));
        break;
      }
      if (a > i) parseQuotes(t.slice(i, a));

      const isDouble = t.slice(a, a + 2) === '**';
      const markerLen = isDouble ? 2 : 1;
      const close = t.indexOf(isDouble ? '**' : '*', a + markerLen);
      if (close === -1) {
        // 닫히지 않는 *는 출력에서 제거
        i = a + markerLen;
        continue;
      }
      parseQuotes(t.slice(a + markerLen, close));
      i = close + markerLen;
    }

    return <>{nodes}</>;
  }, []);

// 메시지 액션 버튼(인라인 SVG) 공통 스타일
  // - 런타임에서 undefined가 되지 않도록 반드시 한 곳에서 정의
  // (성능) 매 렌더마다 새 객체 생성 방지
  const iconButtonStyle: React.CSSProperties = useMemo(
    () => ({
      width: 34,
      height: 34,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 10,
      background: CHAT_THEME.iconBg,
      border: `1px solid ${CHAT_THEME.iconBorder}`,
      color: CHAT_THEME.text,
      cursor: "pointer",
    }),
    [CHAT_THEME.iconBg, CHAT_THEME.iconBorder, CHAT_THEME.text]
  );

  // 입력창 미리보기(색상 하이라이트): *...* / **...** 는 지문(흰색), 그 외는 대사(주황)
  // - 입력 중에만 사용(출력/렌더 기준선에는 영향 없음)
  const buildInputPreviewNodes = buildInputPreviewNodesNode;


  const renderNovel = useCallback(
    (text: string) => renderNovelNode(text, { theme: CHAT_THEME, renderInline }),
    [CHAT_THEME, renderInline]
  );

  // (성능) send는 매 렌더 새로 만들어지는 함수 선언이라 deps에 직접 넣으면
  // renderMarkdownLite -> MessageContent memo가 통째로 무효화된다.
  // 클릭 시점에만 필요하므로 latest-ref로 우회한다.
  const sendRef = useRef<(t?: unknown) => void>(() => {});
  useEffect(() => {
    sendRef.current = (t?: unknown) => {
      void send(t);
    };
  });

  // (Chat 모드) 최소 마크다운 렌더러
  // - 목적: 채팅 모드에서도 ```status 같은 코드블록/외부 이미지 마크다운이 UI에 그대로 보이게
  // - 주의: renderNovel(소설 모드) 로직/스타일은 절대 건드리지 않는다.
  const renderMarkdownLite = useCallback(
    (text: string): React.ReactNode =>
      renderMarkdownLiteNode(text, {
        theme: CHAT_THEME,
        renderInline,
        showImages,
        onQuickUserText: (t) => sendRef.current(t),
      }),
    [CHAT_THEME, renderInline, showImages]
  );

  // (템플릿) 프리셋 첫 메시지 등에 {{user}} placeholders가 남아있는 경우
  // 현재 선택된 페르소나로 최소 치환한다.
  function applyPersonaTemplate(t: string, p: { personaName: string; personaAge: number; personaGender: string } | null): string {
    let s = String(t || "");
    if (!p) return s;
    // 구체 토큰을 먼저 치환(순서 중요)
    s = s.replace(/\{\{user\}\}의\s*성별/g, String(p.personaGender || ""));
    s = s.replace(/\{\{user\}\}의\s*나이/g, String(p.personaAge ?? ""));
    // 남은 {{user}} 치환
    s = s.replace(/\{\{user\}\}/g, String(p.personaName || ""));
    return s;
  }

  // (UI) 이미지 보기 OFF일 때: 이미지 마크다운/URL 라인을 본문에서 제거한다.
  // - 소설 모드(renderNovel) 본문은 건드리지 않고, 입력 텍스트만 정리한다.
  function stripImageLines(t: string): string {
    const s0 = stripLeadingTitleHeader(String(t || ""));
    // 마크다운 이미지 태그 제거 (![](...))
    const s1 = s0.replace(/!\[[^\]]*\]\([^\)]+\)/g, "");
    // {{img:...}} 토큰 제거
    const s1b = s1.replace(/\{\{img:[^}]+\}\}/g, "");
    const lines = s1b.replace(/\r\n/g, "\n").split("\n");
    const imgLineRe = /^\s*"?(?:https?:\/\/|\/\/)[^\s"]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"]*)?"?\s*$/i;
    const cleaned = lines.filter((ln) => !imgLineRe.test(String(ln || "")));
    return cleaned.join("\n");
  }

  
  // 마크다운 이미지(![](...))를 {{img:URL}} 토큰으로 치환한다.
  // - 스트리밍 중 찢긴 조각들이 합쳐진 뒤에도 안정적으로 이미지로 렌더링하기 위함
  function convertMarkdownImagesToImgToken(t: string): string {
    const s0 = stripLeadingTitleHeader(String(t || ""));

    // (fix) 모델이 이미지 마크다운을 "![](url)" 처럼 따옴표로 감싸거나,
    // 라인 앞에 이모지/장식(🍃 등)을 붙여 내보내는 경우가 있다.
    // 기존 변환 로직은 "URL만 단독 라인" 또는 "정상 마크다운"에만 최적화되어 있어
    // 이런 케이스에서는 이미지가 링크 텍스트로 남을 수 있다.
    // → 변환 시작 전에 라인 단위로 다음을 정리한다.
    //   1) 따옴표로 감싼 마크다운 이미지 라인은 따옴표를 제거
    //   2) `!!https://...jpg` / `🍃https://...jpg` 같은 "장식 + 이미지 URL" 라인은 URL을 추출해 토큰화
    const s0q = s0
      // 1) 라인 전체가 "![](url)" 또는 “![](url)” 형태면 따옴표 제거
      .replace(/^[\t ]*(?:["“”'’])\s*(!\[[^\]]*\]\([^\n]*?\))\s*(?:["“”'’])[\t ]*$/gm, "$1");

    // 모델이 가끔 이미지 라인을 `=![](url)` 처럼 '='로 시작시키는 경우가 있다.
    // '='는 의미 없는 마커로 보고 제거한다.
    // - 첫 줄 헤더 제거 오판 방지 (https:// 의 ':' 때문에 첫 줄이 날아가는 문제)
    // - UI에 '=' 텍스트가 남는 문제 방지
    const s1 = s0q
      .replace(/(^|\n)\s*[=＝]+\s*(?=!\[[^\]]*\]\()/g, "$1")
      .replace(/(^|\n)\s*[=＝]+\s*(?=\{\{img:)/gi, "$1")
      .replace(/(^|\n)\s*[=＝]+\s*(?=(?:https?:\/\/|\/\/)[^\s]+)/gi, "$1");

	    // 1) markdown image -> {{img:URL}}
	    const s2 = s1.replace(/!\[[^\]]*\]\(([^)]*)\)/g, (_m, url) => {
	      const u0 = String(url || "").trim();
	      const u1 = u0.replace(/^<|>$/g, "").replace(/^["']+|["']+$/g, "");
	      const u = u1.replace(/\s+/g, "");
	      if (!u) return "";
	      return `{{img:${u}}}`;
	    });

    // 2) bare image URL line -> {{img:URL}}
    // - 외부 이미지가 `https://...webp` 한 줄로만 출력되는 경우가 있어, 그대로 이미지로 표시한다.
    // - 또한 `!!https://...` 또는 `🍃https://...` 처럼 장식이 붙어도 URL을 추출해 토큰화한다.
    const imgUrlLineRe = /^\s*"?(?:https?:\/\/|\/\/)[^\s"]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"]*)?"?\s*$/i;
    const extractDecoratedImageUrl = (line: string): string | null => {
      const raw = String(line || "");
      let x = raw.trim();
      if (!x) return null;

      // 1) 양끝 따옴표 제거
      x = x.replace(/^["“”'’]+|["“”'’]+$/g, "");
      x = x.trim();

      // 2) 흔한 프롬프트 마커 제거: !! / !
      x = x.replace(/^!!\s*/g, "");
      x = x.replace(/^!\s*/g, "");
      x = x.trim();

      // 3) 라인 안에서 이미지 URL만 추출(앞에 이모지/기호가 붙어도 OK)
      const m = x.match(/(?:https?:\/\/|\/\/)[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"'<>]*)?/i);
      if (!m) return null;
      const url = String(m[0] || "");
      if (!url) return null;

      // 4) URL을 제외한 나머지에 '문자/숫자'가 있으면 일반 문장일 수 있으니 변환하지 않음
      const rest = x.replace(url, "").trim();
      if (rest && /[A-Za-z0-9가-힣]/.test(rest)) return null;

      return url;
    };
	    const lines = s2.replace(/\r\n/g, "\n").split("\n");
    const converted = lines.map((ln) => {
	      const raw = String(ln || "");
	      const trimmed = raw.trim();
	      if (!trimmed) return raw;
	      const noEq = trimmed.replace(/^[=＝]+\s*/, "");
      if (imgUrlLineRe.test(noEq)) {
        const u0 = noEq.replace(/^"+|"+$/g, "");
        return `{{img:${u0}}}`;
      }

      // (fix) 장식이 붙은 이미지 URL 라인
      const extracted = extractDecoratedImageUrl(noEq);
      if (extracted && imgUrlLineRe.test(extracted)) {
        const u0 = extracted.replace(/^"+|"+$/g, "");
        return `{{img:${u0}}}`;
      }
	      return raw;
	    });

    // 3) 변환 결과가 "{{img:...}}" 형태로 남으면 라인 단위로 따옴표를 제거
    //    (토큰 파서는 따옴표가 있어도 동작하지만, 남은 따옴표가 대사/지문 판정을 흐릴 수 있음)
    const s3 = converted.join("\n").replace(
      /^[\t ]*(?:["“”'’])\s*(\{\{img:[^}]+\}\})\s*(?:["“”'’])[\t ]*$/gm,
      "$1"
    );
    return s3;
  }

  // (novel) 모델이 가끔 작품 제목/부제 같은 헤더(예: "... : ... |")를 응답 맨앞에 찍는 경우가 있어,
  // 렌더 전에 제거한다(토큰 절감은 불가, 표출/파싱 안정성 목적).
  function stripLeadingTitleHeader(input: string): string {
    const raw = String(input || "").replace(/\r\n/g, "\n");
    const lines = raw.split("\n");
    let i = 0;
    while (i < lines.length && !String(lines[i] || "").trim()) i++;
    if (i >= lines.length) return raw;

    const first = String(lines[i] || "").trim();
    const firstNoEq = first.replace(/^[\s=＝]+/, "");

    // (fix) 이미지/URL 라인이 응답 맨 앞에 오는 경우가 종종 있다.
    // 기존 "짧은 제목: 설명" 헤더 제거 로직이 `https://` 의 ':' 를 제목 헤더로 오인해
    // 첫 줄(=이미지 URL/마크다운 이미지)을 통째로 제거하는 바람에
    // "이미지가 아예 출력 시도도 안 하는" 것처럼 보이는 현상이 발생했다.
    // URL/이미지 토큰/마크다운 이미지는 헤더 제거 대상에서 제외한다.
    // - 또한 모델이 `=![](url)` 처럼 '=' 마커를 앞에 붙이는 경우도 있어, '='를 제거한 값으로 판정한다.
    const isUrlLike = /^(?:https?:\/\/|\/\/)[^\s]+/i.test(firstNoEq);
    const isMdImagePrefixLike = /^!\[[^\]]*\]\(/.test(firstNoEq);
    const isImgTokenPrefixLike = /^\{\{img:/i.test(firstNoEq);
    const isImgTokenLike = /\{\{img:[^}]+\}\}/i.test(firstNoEq);
    if (isUrlLike || isMdImagePrefixLike || isImgTokenPrefixLike || isImgTokenLike) return raw;

    const chk = firstNoEq;
    const looksLikeTitleHeader =
      chk.length <= 90 &&
      (chk.includes("|")
        ? (chk.includes(":") || chk.includes("："))
        : (() => {
            // 예: "마.소.도! : 마법소녀들의 도시!" 같은 "짧은 제목: 설명" 류 1줄 헤더
            // (본문 지문/대사와 혼동되는 경우가 많아 첫 줄에서만 제거)
            if (!(chk.includes(":") || chk.includes("："))) return false;
            const parts = chk.split(/[:：]/);
            const left = String(parts[0] || "").trim();
            const right = String(parts.slice(1).join(":") || "").trim();
            if (!left || !right) return false;
            if (left.length > 24) return false;
            if (right.length > 80) return false;
            // 문장처럼 길면 헤더로 보지 않음
            if (/(다\.|다\!|다\?|니다\.|니다\!|니다\?)/.test(chk)) return false;
            // 따옴표/지문/대사 시작은 제외
            if (/^[\*"“”'’]/.test(chk)) return false;
            // 끝이 문장부호면 헤더로 보지 않음
            if (/[\.!?…。！？]$/.test(chk)) return false;
            return true;
          })());

    if (!looksLikeTitleHeader) return raw;

    // 첫 줄 제거
    const out = [...lines.slice(0, i), ...lines.slice(i + 1)];
    return out.join("\n");
  }

  // 메시지 본문 렌더러
  // - assistant: 소설형(대사/지문) 파서 적용
  // - user: 줄바꿈/이탤릭(*...*)만 유지해서 표시
  const MessageContent = useCallback(
    ({ message }: { message: Msg }) => {
      if (isAssistantLikeRole(message.role)) {
        // (fix) 저장/전송 경로에서 content가 JSON-escape 된 채로 들어오는 경우(\\n/\\" 등)를 먼저 복원한다.
        // 그래야 code fence 내부 개행, 지문(*...*) 제거, 대사(따옴표) 판정이 정상 동작한다.
        const content0 = maybeUnescapeJsonEscapes(String(message.content || ""));
        const txtRaw0 = applyPersonaTemplate(content0, selectedProfile);
        const txtRaw = convertMarkdownImagesToImgToken(txtRaw0);
        const txt = showImages ? txtRaw : stripImageLines(txtRaw);


        // (intro) 첫 assistant 메시지(=가이드/오프닝)는 따옴표로 감싼 줄만 '대사'로 분류한다.
        // - 나머지는 모두 지문으로 처리해, 오프닝 문구/표/설명문이 대사 박스로 보이는 문제를 막는다.
        const introStrictQuotes = Boolean(firstAssistantId && message.id === firstAssistantId);


        const renderImageCut = (key: string, k: string) => {
          if (!showImages) return null;
          const found = galleryMap.get(key);
          if (!found?.src) {
	            // 외부 URL(마크다운 이미지) / data: / blob: 도 바로 렌더링
	            // - 스트리밍 중에는 마크다운 렌더러가 그대로 보여주다가,
	            //   done 단계에서 {{img:...}} 토큰으로 바뀌며 렌더 경로가 달라져서
	            //   "이미지가 보였다가 사라지는" 체감이 발생할 수 있어,
	            //   URL 형식은 모두 동일한 경로로 처리한다.
	            const isUrlLike =
	              /^(?:https?:\/\/|\/\/)[^\s]+/i.test(key) || /^data:image\//i.test(key) || /^blob:/i.test(key);
	            if (isUrlLike) {
	              const src = key.startsWith("//") ? `https:${key}` : key;
	              return (
	                <div
	                  key={k}
	                  style={{
	                    border: "none",
	                    background: CHAT_THEME.panel2,
	                    borderRadius: 20,
	                    overflow: "hidden",
	                    width: "100%",
	                    maxWidth: 900,
	                  }}
	                >
	                  <SmartImage
	                    src={src}
	                    alt={key}
	                    theme={CHAT_THEME}
	                    style={{
	                      width: "100%",
	                      height: "auto",
	                      display: "block",
	                    }}
	                  />
	                </div>
	              );
	            }

            return (
              <div
                key={k}
                style={{
                  border: "none",
                  background: CHAT_THEME.panel2,
                  borderRadius: 18,
                  padding: 14,
                  color: CHAT_THEME.muted,
                  maxWidth: 860,
                }}
              >
                이미지 없음: {key}
              </div>
            );
          }
          return (
	            <div
              key={k}
              style={{
				        border: "none",
				        background: "rgba(255,255,255,0.03)",
				        borderRadius: 20,
				        overflow: "hidden",
				        padding: 0,
				        width: "100%",
				        maxWidth: 900,
				      }}
				>
              <img
                src={found.src}
                alt={found.desc || key}
                style={{
	                  width: "100%",
                  height: "auto",
                  display: "block",
                }}
              />
            </div>
          );
        };
        // renderMode는 채팅별 설정 값이지만, 로딩/마이그레이션 구간에서는 undefined가 될 수 있음.
        // 요구사항: 기본은 '소설' 모드로 안전하게 폴백.
        const effectiveRenderMode: "chat" | "novel" =
          (settings as any)?.renderMode === "chat" || (settings as any)?.renderMode === "novel"
            ? ((settings as any).renderMode as "chat" | "novel")
            : "novel";

        if (effectiveRenderMode === "novel") {
          // (novel) INFO 블록은 현재 사용하지 않으므로 표시하지 않는다.
          const stripInfo = (t: string) => {
            // (legacy) 과거 로그에 남아 있을 수 있는 단독 'INFO' 구분선을 처리한다.
            // - 절대 본문을 '자르지' 않는다. (출력이 다 됐다가 UI에서 잘리는 문제 방지)
            // - 다음 줄이 펜스( ``` )로 시작할 때만 해당 'INFO' 라인을 제거한다.
            const lines = String(t || "").replace(/\r\n/g, "\n").split("\n");

            const out: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              const ln = lines[i];
              if (ln.trim() === "INFO") {
                const next = lines[i + 1] ?? "";
                if (/^\s*```/.test(next)) continue;
              }
              out.push(ln);
            }
            return out.join("\n").trimEnd();
          };

          // 소설 모드 UI: 지문은 항상 흰색(회색/기울임 금지)
					const NOVEL_NARRATION = "#ffffff";
          const NOVEL_BASE_FONT_SIZE = Math.max(12, Math.min(24, Number(chatFontSizePx || 18)));
          const NOVEL_LINE_HEIGHT = 1.85;

					// 소설 모드에서도 코드블록/마크다운 이미지가 동작해야 한다.
					// - 기존 소설 렌더(대사/지문 톤, 개행/문단)는 유지
					// - 코드펜스/이미지 등 "블록"만 안전하게 마크다운 렌더러로 넘긴다.
					const normalizeForNovelMarkdown = (t: string) => {
					// 일부 모델/프롬프트는 opening fence(```LABEL)와 첫 줄 내용을 같은 라인에 붙여 출력한다.
					// 예) ```STATUS [일지0/3]...
					// 예) ```HELLO something...
					// splitByFencedCode는 opening fence가 단독 라인일 때만 안정적으로 분리하므로,
					// LABEL 종류에 상관없이 fence 라인을 분리해 준다.
					const s0 = stripLeadingTitleHeader(String(t || ""));

					// 모델이 이미지 라인을 대사처럼 따옴표로 감싸 출력하는 경우가 있다.
					// 예) "![](https://...png)"  /  “![](https://...png)”
					// → 따옴표만 제거하여 정상적인 마크다운 이미지로 렌더되게 한다.
					const s0u = s0
						// 1) 라인 단위로: "![](url)" / “![](url)” 처럼 이미지 마크다운만 따옴표로 감싼 경우
						.replace(/^\s*(?:["“”])\s*(!\[[^\]]*\]\([\s\S]*?\))\s*(?:["“”])\s*$/gm, "$1")
						// 2) 혹시 라인 단위 매칭이 빠지는 경우를 대비한 인라인 처리(한 줄 범위로만)
						.replace(/(["“”])\s*(!\[[^\]]*\]\([^\n]*?\))\s*\1/g, "$2");

					
					// 일부 모델이 {{img:URL}} 토큰을 출력하는 경우가 있다.
					// 이 프로젝트는 마크다운 이미지(![](...))로 렌더링하는 것이 기본이므로,
					// {{img:...}}는 표준 마크다운 이미지로 변환하고, 주변의 불필요한 * / 따옴표 / }} 찌꺼기를 제거한다.
					const s0v = s0u
						.replace(/\*?\{\{img:([^}]+)\}\}\*?/gim, (_m, inner) => {
								const v0 = String(inner ?? "");
								const v1 = v0.trim().replace(/^["'“”]+|["'“”]+$/g, "");
								return `{{img:${v1}}}`;
							})
						.replace(/\*\s*(!\[[^\]]*\]\([^\n]*?\))\s*\*+/gim, "$1")
						.replace(/(!\[[^\]]*\]\([^\n]*?\))\s*(?:\}\}+|\"\*|\*\"|\*+|\"+|“\*|\*”|”\*|\*“)+/gim, "$1");

					// 모델이 문장 끝에 코드펜스를 붙여버리는 경우가 있다.
					// 예) ...된다.```Info
					// splitByFencedCode는 펜스가 '단독 라인'일 때 가장 안정적이므로,
					// 펜스 앞에 줄바꿈을 강제로 넣어 분리한다.
					const s0w = s0v.replace(/([^\n`])```/g, "$1\n```");

					const s1 = s0w.replace(/^\s*```\s*([^\s`]+)\s+(.+)$/gim, "```$1\n$2");

					// 과거 프롬프트/로그에 남아 있는 "!!URL" 또는 "\"!!URL\"" 형태를
					// 표준 마크다운 이미지로 흡수한다.
					const s2 = s1.replace(/^\s*"?!!\s*([^"\s]+)"?\s*$/gm, "{{img:$1}}");

					// 일부 출력에서 마크다운 이미지가 잘려 `!(url)` 또는 `*!(url)` 형태로 들어오는 경우가 있다.
					// 예) *!(https://.../AA.webp)
					// -> 표준 마크다운 이미지로 흡수한다.
					const s2b = s2.replace(
					  /\*?!\(\s*((?:https?:\/\/|\/\/)[^\s)]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s)]*)?)\s*\)/gim,
					  "{{img:$1}}"
					);

					// 과거/일부 출력에서 이미지 URL만 단독으로(따옴표/괄호 포함) 오는 경우를
					// 표준 마크다운 이미지로 흡수한다. 예: "//itimg.kr/a.webp" 또는 (https://...png)
					const s3 = s2b.replace(
											  /^\s*(?:!{1,2}\s*)?"?\(?\s*((?:https?:\/\/|\/\/)[^\s"()]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s"()]*)?)\s*\)?"?\s*$/gmi,
											  "{{img:$1}}"
										);

					// 스트리밍/정규화 과정에서 URL 내부가 잘려 공백이 끼는 경우(예: dyd1. speedgabia.com)
					// 마크다운 이미지 URL 괄호 안의 공백은 모두 제거하여 복구한다.
					const s4 = s3
								// 스트리밍/정규화 과정에서 URL 내부가 잘려 공백이 끼는 경우(예: dyd1. speedgabia.com)
								// {{img:...}} 토큰 내부의 공백도 제거하여 복구한다.
								.replace(/\{\{img:([^}]+)\}\}/g, (_m, url) => {
									const fixedUrl = String(url || "").replace(/\s+/g, "");
									return `{{img:${fixedUrl}}}`;
								})
								// 마크다운 이미지 URL 괄호 안의 공백도 제거하여 복구한다.
								.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt, url) => {
									const fixedUrl = String(url || "").replace(/\s+/g, "");
									return `![${String(alt || "")}](${fixedUrl})`;
								});

					const s5 = s4
						// 이미지 마크다운 뒤에 스트리밍 찌꺼기(따옴표/별표)가 붙는 경우 제거
						.replace(/(!\[[^\]]*\]\([^\)]*\))\s*[*_]+\s*(?:["“”']+)?/g, "$1")
						.replace(/(?:["“”']+)\s*(!\[[^\]]*\]\([^\)]*\))/g, "$1")
						// 이미지 마크다운이 다른 텍스트와 붙어버리면 줄바꿈으로 분리
						.replace(/(!\[[^\]]*\]\([^\)]*\))(?=[^\s\n])/g, "$1\n")
						// 이미지 뒤에 )*" 같은 찌꺼기가 남는 케이스 제거
						.replace(/(!\[[^\]]*\]\([^\)]*\))\)\s*\*+\s*"/g, "$1)");
					// (policy) 깨진 이미지 마크다운(![] / ![...](...) 미완성)은 UX에 해롭다.
					// - ![]( / ![ 로 시작하지만 닫는 ) / ]( 가 끝까지 없으면 그 라인은 제거
					// - ![] 단독줄, !, !! 같은 찌꺼기도 제거
					// - 코드펜스 내부는 절대 건드리지 않는다.
					// - 간헐적으로 줄 맨 앞에 "!! "가 붙는 케이스는 이미지 찌꺼기일 가능성이 높으므로 보수적으로 제거한다.
					const dropBrokenImageMarkdownLines = (input: string) => {
						const raw = String(input || "");
						if (!raw) return raw;
						const lines = raw.replace(/\r\n/g, "\n").split("\n");
						const out: string[] = [];
						let inFence = false;

						const isFenceLine = (ln: string) => /^\s*```/.test(String(ln || ""));
						const isCompleteImageLine = (ln: string) =>
							/^\s*!\[[^\]]*\]\([^\)]*\)\s*$/.test(String(ln || "").trim());

						for (let i = 0; i < lines.length; i++) {
							let ln = String(lines[i] ?? "");
							if (isFenceLine(ln)) {
								inFence = !inFence;
								out.push(ln);
								continue;
							}
							if (inFence) {
								out.push(ln);
								continue;
							}

							// 1) 앞에 붙는 "!! " 찌꺼기 제거 (문장 시작에서만)
							{
								const m = ln.match(/^(\s*)!!\s+(.+)$/);
								if (m) {
									const lead = m[1] ?? "";
									const rest = String(m[2] ?? "");
									const restTrim = rest.trimStart();

									const restLooksSpecial =
										restTrim.startsWith("![") ||
										restTrim.startsWith("![]") ||
										/^(?:https?:\/\/|\/\/)/i.test(restTrim) ||
										restTrim.includes("](") ||
										/^\s*(?:["“”＂]|\*|\||```)/.test(restTrim);

									const hasOtherBang = restTrim.includes("!");
									if (!restLooksSpecial && !hasOtherBang) {
										ln = `${lead}${restTrim}`;
									}
								}
							}

							const t = ln.trim();

							// 2) 의미 없는 찌꺼기 줄 제거
							if (t === "!" || t === "!!" || t === "![]" || t === "![](" || t === "![" || t === "![") {
								continue;
							}

							// 3) 미완성 이미지 마크다운 라인 제거
							//    - 시작은 ![ 또는 ![]( 인데, 완전한 ![alt](url) 형태가 아니면 제거한다.
							if (t.startsWith("![") || t.startsWith("![](") || t.startsWith("![]")) {
								if (!isCompleteImageLine(ln)) {
									const hasBracketParen = t.includes("](");
									const endsWithParen = t.endsWith(")");
									if (!hasBracketParen || !endsWithParen) continue;
									// 형태가 애매하면(정규식 불일치) 제거가 안전하다.
									continue;
								}
							}

							out.push(ln);
						}

						return out.join("\n");
					};



					// (A) 모델이 지문을 *...* 로 감싸려다 스트리밍/컷으로 인해 시작 '*'만 남기는 경우가 있다.
					// 예) *반면, ... (닫는 * 누락)
					// → bullet list("* ")는 제외하고, 라인 단위로 닫는 *를 보수적으로 붙인다.
					// (B) 이미지 라인 다음에 대사를 내보낼 때 opening quote를 한 줄에 단독으로 내보내거나,
					// 혹은 아예 생략하는 경우가 있다.
					// → (1) 따옴표 단독 라인은 다음 라인 앞으로 합치고
					// → (2) 이미지 다음 라인이 "로 시작하지 않으면 보수적으로 "..." 로 감싼다.
					const fixLonelyAsteriskAndImageDialogue = (input: string) => {
						const raw = String(input || "");
						if (!raw) return raw;
						const REMOVED = "\u0000__REMOVED_QUOTE_ONLY_LINE__\u0000";
						let lines = raw.replace(/\r\n/g, "\n").split("\n");
						let inFence = false;
						const isFenceLine = (ln: string) => /^\s*```/.test(String(ln || ""));
						const isImageLine = (ln: string) => /^\s*!\[[^\]]*\]\([^\)]*\)\s*$/.test(String(ln || "").trim());
						const isTableLike = (ln: string) => /^\s*\|/.test(String(ln || ""));
						const isBullet = (ln: string) => /^\s*\*\s+/.test(String(ln || ""));
						const startsWithQuote = (ln: string) => /^\s*(?:["“”＂])/.test(String(ln || ""));
						const endsWithQuote = (ln: string) => /(?:["”＂])\s*$/.test(String(ln || "").trimEnd());
						const isLikelyDialogueWithoutOpeningQuote = (ln: string) => {
							const core = String(ln || "").trim();
							if (!core) return false;
							// 첫 글자가 문자/숫자인 문장만 (기호/메타 라인 제외)
							if (!/^[A-Za-z0-9가-힣]/.test(core)) return false;
							// 문장 마침부호가 있어야 함(너무 느슨하면 지문까지 오탐)
							if (!/[\.\!\?！？。…~"”＂]$/.test(core)) return false;
							// 서술형 과거형(했다/있었다/이었다/였다.)은 지문일 가능성이 높다 → 보강 금지
							if (/(했다|있었다|이었다|였다)\.$/.test(core) && !/[\!\?！？…~]$/.test(core)) return false;
							// 너무 길고 서술 어조(쉼표가 많은) 문장은 지문일 가능성 ↑
							if (core.length >= 80 && /[,，、]/.test(core)) return false;
							return true;
						};

						const quoteOnly = (ln: string) => {
							const t = String(ln || "").replace(/[\*_`]+/g, "").trim();
							return t === '"' || t === "“" || t === "”" || t === "＂";
						};

						// 1) 따옴표 단독 라인을 다음 라인 앞에 붙이기 (opening quote 복구)
						for (let i = 0; i < lines.length - 1; i++) {
							const ln = lines[i];
							if (isFenceLine(ln)) inFence = !inFence;
							if (inFence) continue;
							if (!quoteOnly(ln)) continue;
							const next = lines[i + 1];
							if (String(next || "").trim().length === 0) continue;
							// 다음 줄이 이미 따옴표로 시작하면 굳이 붙이지 않는다.
							if (!startsWithQuote(next)) {
								const lead = (next.match(/^\s*/)?.[0] ?? "");
								const core = String(next).trim();
								lines[i + 1] = `${lead}"${core}`;
							}
							lines[i] = REMOVED;
						}

						// 2) 라인 단위 보정: lonely '*' 닫기 + 이미지 다음 라인 대사 quote 보강
						inFence = false;
						let prevNonEmpty = "";
						for (let i = 0; i < lines.length; i++) {
							const ln = String(lines[i] ?? "");
							if (isFenceLine(ln)) {
								inFence = !inFence;
								prevNonEmpty = ln.trim().length ? ln : prevNonEmpty;
								continue;
							}
							if (inFence) {
								if (ln.trim().length) prevNonEmpty = ln;
								continue;
							}

							// (A0) stray '*' cleanup: 대사 앞에 붙은 '*' 또는 단독 '*'는 제거
							{
								const t = ln.trim();
								// '*' 한 글자만 남은 라인 제거
								if (t === "*") {
									lines[i] = "";
									continue;
								}
								// 대사 시작 따옴표 앞의 '*' 제거: *"..." / *“...” / *「...」 등
								const mQuote = ln.match(/^(\s*)\*\s*(["“”'’「『])([\s\S]*)$/);
								if (mQuote) {
									const lead = mQuote[1] ?? "";
									const q = mQuote[2] ?? "";
									const rest = mQuote[3] ?? "";
									lines[i] = `${lead}${q}${rest}`;
									// prevNonEmpty 갱신은 아래 공통 로직이 처리
								}
							}
							// (A) lonely leading '*' (bullet 제외): *반면,...  → ...* 로 닫기
							if (!isBullet(ln)) {
								const m = ln.match(/^(\s*)\*(?!\s)([\s\S]*)$/);
								if (m) {
									const lead = m[1] ?? "";
									const rest = m[2] ?? "";
									// rest에 다른 '*'가 없고, 라인이 '*'로 끝나지 않으면 닫아준다.
									if (!rest.includes("*") && !String(ln).trimEnd().endsWith("*")) {
										lines[i] = `${lead}*${rest.trimEnd()}*`;
									}
								}
							}

							// (B) 이미지 다음 라인: 대사라면 따옴표 보강
							const current = String(lines[i] ?? "");
							const trimmed = current.trim();
							if (trimmed.length > 0 && isImageLine(prevNonEmpty)) {
								// 이미 따옴표/지문/테이블/펜스인 경우는 건드리지 않는다.
								const isNarration = /^\s*\*/.test(current) && !isBullet(current);
								if (!startsWithQuote(current) && !isNarration && !isTableLike(current) && !/^\s*```/.test(current) && isLikelyDialogueWithoutOpeningQuote(current)) {
									const lead = (current.match(/^\s*/)?.[0] ?? "");
									const core = current.trim();
									const end = endsWithQuote(core) ? "" : '"';
									lines[i] = `${lead}"${core}${end}`;
								}
							}

							if (String(lines[i] || "").trim().length) prevNonEmpty = String(lines[i]);
						}

							return lines.filter((l) => l !== REMOVED).join("\n");
					};

					const s5a = dropBrokenImageMarkdownLines(s5);

					const s5b = fixLonelyAsteriskAndImageDialogue(s5a);

					// 간헐적으로 마지막 줄에 의미 없이 따옴표(\" / “ / ”)만 단독으로 찍히는 케이스가 있다.
					// 예) (정상 문장/대사 끝)\n"  또는 \n“
					// - 마지막 라인이 따옴표 단독이면 제거하되,
					// - 바로 윗줄이 따옴표로 끝나지 않는 경우에는 '닫는 따옴표'로 간주하고 윗줄 끝에 붙여 복구한다.
					const fixDanglingQuoteLine = (input: string) => {
						const raw = String(input || "");
						if (!raw) return raw;
						// preserve original leading content, but work on trailing lines safely
						const trimmedEnd = raw.replace(/[\t \u00A0]+$/g, "");
						let lines = trimmedEnd.split("\n");
						let changed = false;
						const stripMdNoise = (s: string) => String(s || "").replace(/[\*_`]+/g, "");
						const isQuoteOnly = (s: string) => {
							const t = stripMdNoise(String(s || "")).trim();
							// 흔한 따옴표 변형까지 포함
							return t === '"' || t === "“" || t === "”" || t === "＂";
						};
						const endsWithAnyQuote = (s: string) => {
							const t = stripMdNoise(String(s || "")).trimEnd();
							return t.endsWith('"') || t.endsWith("“") || t.endsWith("”") || t.endsWith("＂");
						};
						while (lines.length > 0 && isQuoteOnly(lines[lines.length - 1])) {
							const q = String(lines[lines.length - 1]).trim();
							lines.pop();
							changed = true;
							if (lines.length === 0) break;
							const prev = lines[lines.length - 1];
							if (!endsWithAnyQuote(prev)) {
								lines[lines.length - 1] = `${prev}${q}`;
							}
						}
						return changed ? lines.join("\n") : raw;
					};

					const s6 = fixDanglingQuoteLine(s5b);
					return s6;
				};


					
					// (repair) gemini-3-pro-preview가 MAX_TOKENS로 잘릴 때
					// ```STATUS 펜스가 `STATUS / STATUS 처럼 깨져서 본문으로 흘러나오는 경우가 있다.
					// done(비스트리밍) 시점에만, "상태창처럼 보이는 블록"을 보수적으로 복구한다.
					const coerceStatusFenceIfMissing = (t: string) => {
						const s = String(t || "");
						if (!s) return s;
						if (/```\s*STATUS\b/i.test(s)) return s;

						const lines = s.replace(/\r\n/g, "\n").split("\n");

						const hasStatusPayloadNear = (from: number) => {
							const tail = lines.slice(from, from + 12).join("\n");
							return (
								/\[일지\s*\d+\s*\/\s*3\]/.test(tail) ||
								/^\s*\[내공\s*:/m.test(tail) ||
								/^\s*\[무공\s*:/m.test(tail) ||
								/^\s*\[명성\s*:/m.test(tail) ||
								/^\s*\[악명\s*:/m.test(tail)
							);
						};

						// 1) `STATUS / ``STATUS / "STATUS" 같은 라인을 opening fence로 복구
						let statusLineIdx = -1;
						for (let i = 0; i < lines.length; i++) {
							const ln = String(lines[i] || "");
							if (
								/^\s*["“”']{0,3}`{1,2}\s*STATUS\b/i.test(ln) ||
								/^\s*["“”']{0,3}STATUS\b/i.test(ln)
							) {
								statusLineIdx = i;
								break;
							}
						}
						if (statusLineIdx >= 0 && hasStatusPayloadNear(statusLineIdx)) {
							let ln = String(lines[statusLineIdx] || "");
							ln = ln.replace(/^\s*["“”']{0,3}`{1,2}\s*(STATUS\b.*)$/i, "```$1");
							ln = ln.replace(/^\s*["“”']{0,3}(STATUS\b.*)$/i, "```$1");
							lines[statusLineIdx] = ln;
							return lines.join("\n");
						}

						// 2) STATUS 토큰이 아예 없지만, [일지0/3] 같은 블록이 본문 끝에 붙는 경우:
						// 해당 구간을 통째로 ```STATUS ... ```로 감싸준다.
						const payloadIdx = lines.findIndex((ln) => /\[일지\s*\d+\s*\/\s*3\]/.test(String(ln || "").trim()));
						if (payloadIdx < 0) return s;

						const head = lines.slice(0, payloadIdx).join("\n").trimEnd();
						const body = lines.slice(payloadIdx).map((ln) => {
							const raw = String(ln || "");
							// 라인 전체가 따옴표로 감싸진 경우만 따옴표 제거 (본문 내용은 보존)
							return raw.replace(/^\s*(["“”])\s*([\s\S]*?)\s*\1\s*$/, "$2");
						});

						const fenced = ["```STATUS", ...body, "```"].join("\n");
						return head ? `${head}\n\n${fenced}` : fenced;
					};


const splitByFencedCode = (t: string, allowAutoClose: boolean = true) => {
	// ```...``` (또는 ~~~...~~~) 형태를 줄 단위로 안전하게 분리한다.
	// 핵심 목표:
	// 1) 의도된 펜스(STATUS/INFO/TEXT 등)는 코드블록으로 분리
	// 2) 오프-펜스/제로폭/따옴표/트레일링 보이지않는 문자 때문에 "닫힘" 인식이 실패해
	//    이후 본문이 통째로 코드블록으로 '먹히는' 문제를 방지
	// 3) 모델이 "```text" 로 닫아버리는 비정상 케이스도 *닫힘으로* 관대하게 처리
	const src = maybeUnescapeJsonEscapes(String(t || ""))
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		// 간혹 '\\```' 형태로 섞여 들어오면 펜스 인식이 깨져서 이후가 통째로 오염됨
		.replace(/\\```/g, "```")
		.replace(/\\~~~/g, "~~~");
	const lines = src.split("\n");
	const out: { type: "text" | "code"; value: string }[] = [];
	let textBuf: string[] = [];
	let inFence = false;
	let fenceChar: "`" | "~" = "`";
	let fenceLen = 3;
	let fenceLang = "";
	let fenceBody: string[] = [];

	const stripFenceProbe = (ln: string) => {
		let s = String(ln || "");
		// 선행/후행 zero-width/format 문자 제거(닫힘 라인 끝에 끼는 경우가 실제로 있음)
		s = s.replace(/^\u2063[UN]\u2063/, "");
		s = s.replace(/^[\uFEFF\u180E\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\u202A-\u202E]+/g, "");
		s = s.replace(/[\uFEFF\u180E\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\u202A-\u202E]+$/g, "");
		// 따옴표로 감싸는 경우("```INFO" / '```text') 방어
		s = s.replace(/^\s*[\"“”'’]{0,3}\s*/, "");
		s = s.replace(/\s*[\"“”'’]{0,3}\s*$/, "");
		return s;
	};

	const matchFenceOpen = (ln: string) => {
		const probe = stripFenceProbe(ln).trimStart();
		const m = probe.match(/^([`~]{3,})(.*)$/);
		if (!m) return null;
		const fence = String(m[1] || "");
		const rest = String(m[2] || "").trim();
		const lang = (rest.split(/\s+/)[0] || "").trim();
		const ch = fence[0] === "~" ? "~" : "`";
		return { ch: ch as "`" | "~", len: fence.length, lang };
	};

	const isFenceClose = (ln: string) => {
		const probe = stripFenceProbe(ln).trimStart();
		if (!probe) return false;
		// fenceChar가 최소 fenceLen 이상 연속되면 닫힘으로 본다(뒤에 lang이 붙어도 허용)
		let i = 0;
		while (i < probe.length && probe[i] === fenceChar) i++;
		return i >= fenceLen;
	};

	const flushText = () => {
		if (!textBuf.length) return;
		out.push({ type: "text", value: textBuf.join("\n") });
		textBuf = [];
	};

	for (const line of lines) {
		if (!inFence) {
			const open = matchFenceOpen(line);
			if (open) {
				flushText();
				inFence = true;
				fenceChar = open.ch;
				fenceLen = Math.max(3, open.len);
				fenceLang = open.lang || "";
				fenceBody = [];
				continue;
			}
			textBuf.push(line);
			continue;
		}

		// in fence
		if (isFenceClose(line)) {
			const lang = (fenceLang || "text").trim() || "text";
			const body = fenceBody.join("\n");
			out.push({ type: "code", value: `\`\`\`${lang}\n${body}\n\`\`\`` });
			inFence = false;
			fenceLang = "";
			fenceBody = [];
			continue;
		}
		fenceBody.push(line);
	}

	if (inFence) {
		// (done) 시에는 메타펜스(STATUS/INFO/STREAM/TEXT 등) 위주로 자동 닫기를 시도하되,
		// 오프펜스로 인해 이후 본문이 통째로 먹히는 것을 막기 위해 '언제나 code로 밀지 않는다'.
			const autoClosable = true;
		if (allowAutoClose && autoClosable) {
			const lang = (fenceLang || "text").trim() || "text";
			const body = fenceBody.join("\n");
			out.push({ type: "code", value: `\`\`\`${lang}\n${body}\n\`\`\`` });
		} else {
			// 닫히지 않은 펜스는 "펜스 1개" 때문에 이후 본문을 먹어버렸을 가능성이 크므로 텍스트로 돌려준다.
			const lang = (fenceLang || "").trim();
			const head = fenceChar === "~" ? "~~~" : "```";
			const body = fenceBody.join("\n");
			textBuf.push(`${head}${lang ? lang : ""}`);
			if (body) textBuf.push(body);
			// 닫힘은 일부러 넣지 않는다(원문 보존)
		}
		inFence = false;
		fenceLang = "";
		fenceBody = [];
	}

	flushText();
	return out;
};
const normalizeNovelLine = (lineRaw: string) => {
            const raw = normalizeStarVariants(String(lineRaw || "")).trim();
            if (!raw) return { kind: "blank" as const, text: "" };

            // (fix) 일부 메시지 앞에는 보이지 않는 마커(\u2063U\u2063 / \u2063N\u2063 등)나
            // zero-width 문자가 붙거나(심지어 중간에 끼어들어) 커맨드/예시 판정이 실패할 수 있다.
            // - 선행 마커 제거는 화면 표시용(rawClean)으로 사용
            // - 커맨드 판정은 문자열 전체에서 zero-width를 제거한 정규화 버전으로 수행
            const stripLeadingMarkers = (s: string) => {
              let t = String(s || "");
              t = t.replace(/^\u2063[UN]\u2063/, "");
              t = t.replace(/^[\uFEFF\u200B\u200C\u200D\u2060\u2063]+/g, "");
              return t.trimStart();
            };

            const normalizeForCommandMatch = (s: string) => {
              let t = String(s || "");
              // 화자 마커/제로폭 문자는 문자열 어디에 있든 제거(특히 `{\u200B커스텀모드:...}` 같은 케이스)
              t = t.replace(/^\u2063[UN]\u2063/, "");
              t = t.replace(/[\uFEFF\u200B\u200C\u200D\u2060\u2063]/g, "");
              // 전각 괄호/콜론 등도 정규화
              t = t.replace(/[｛]/g, "{").replace(/[｝]/g, "}").replace(/[：]/g, ":");
              return t;
            };

            const isCustomModeLike = (s: string) => {
              const t = normalizeForCommandMatch(s).trim();
              return (
                /^\{\s*(?:\ucee4\uc2a4\ud140\s*\ubaa8\ub4dc|\ucee4\uc2a4\ud140\ubaa8\ub4dc)\s*:/i.test(t) ||
                /^\{\s*custom\s*mode\s*:/i.test(t)
              );
            };

            const rawClean = stripLeadingMarkers(raw);

            // (fix2) 대사 텍스트 정리:
            // - " 뒤 공백 제거
            // - 끝의 ""(중복 따옴표) 제거
            // - 대사 끝에 붙는 * (지문 닫기 잔상) 제거
            // - 스트리밍/모델 출력에서 누수된 *" 형태도 보정
            const stripLeakStarBeforeQuote = (line: string) => {
              let t = String(line || '');
				  // 선행 공백 뒤에 *가 있고 바로 따옴표가 오면( *" / *＂ / *“ ), 대사로 판단할 때는 *를 제거한다.
				  t = t.replace(/^\s*\*(?=\s*["＂“”‘’「『])/, '');
              return t;
            };

            const cleanDialogueText = (line: string) => {
              let t = String(line || '');

              // 선행 화자 마커/제로폭 제거(안전)
              t = t.replace(/^⁣[UN]⁣/, '');
              t = stripLeakStarBeforeQuote(t);

				  // 첫 따옴표 뒤 공백 제거: " ... -> "...
				  // (fix) 따옴표 뒤에 zero-width/format 문자가 섞인 경우(\u200B/\u2063/\u180E 등)도 같이 제거
				  // - 일부 모델/스트리밍 조각에서 \u180E 같은 '눈에는 공백처럼 보이는' 문자가 끼어 " 공백이 재발할 수 있음
				  t = t.replace(/^(\s*["＂“”‘’「『])[\s\u00A0\uFEFF\u180E\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\u202A-\u202E]+/, '$1');
              // 접두어(태그/화자) 뒤 따옴표도 정리: [태그] " ...
				  t = t.replace(/(\S\s*)(["＂“”‘’「『])[\s\u00A0\uFEFF\u180E\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\u202A-\u202E]+/, '$1$2');

              // 대사 끝에 붙는 지문 닫기 잔상(* / ** 등) 제거
              t = t.replace(/\s*\*+\s*$/, '');

              // 끝에 "" 같이 따옴표가 중복으로 붙는 케이스 정리
              // - """ -> "
              t = t.replace(/"{2,}\s*$/, '"');
              // - ”” / ’’ / 」」 / 』』 등 동일 문자 반복도 1개로 축약
              t = t.replace(/([”’」』])\1+\s*$/, '$1');
              // - " ” 처럼 섞여서 2개가 붙는 케이스도 1개만 남김(마지막 문자를 유지)
              t = t.replace(/(["”’」』])\s*(["”’」』])\s*$/, '$2');

              return t.trimEnd();
            };

            // {커스텀모드:...} 같은 커맨드/예시는 지문으로 강제 (따옴표로 감싸져도 지문)
            if (isCustomModeLike(rawClean)) {
              return { kind: "narration" as const, text: normalizeForCommandMatch(rawClean).trim() };
            }
            {
              const m = rawClean.match(/^("|“)([\s\S]*?)("|”)$/);
              if (m) {
                const inner = String(m[2] || "").trim();
                if (isCustomModeLike(inner)) {
                  return { kind: "narration" as const, text: normalizeForCommandMatch(inner).trim() };
                }
              }
            }

            // (fix) 마크다운 표(table) 라인은 '이름 | 대사' 포맷으로 오인되기 쉽다.
            // 예: | 시작 유형 | 설정 방법 | 시작 상태 |
            // 이런 라인을 대사로 감싸버리면("...") 시작가이드 같은 표가 줄줄이 '대사'로 렌더된다.
            // 표 라인은 그대로(지문/일반 텍스트) 유지한다.
            {
              const t = rawClean.trim();
              const pipeCount = (t.match(/\|/g) || []).length;
              const looksLikeMdTableRow = t.startsWith("|") && t.endsWith("|") && pipeCount >= 3;
              const looksLikeMdTableSep = t.startsWith("|") && pipeCount >= 2 && /^\|[\s\-:|]+\|$/.test(t.replace(/\s+/g, " "));
              if (looksLikeMdTableRow || looksLikeMdTableSep) {
                return { kind: "narration" as const, text: rawClean };
              }
            }

            // (fix) 제작 프롬프트/인트로에서 쓰는 Info 메타 라인은 '이름 | 대사'로 흡수되면 안 된다.
            // 예: Info
            //     📍위치|🕒시간|🗓9월22일
            //     🔧:💬|🌏:?
            //     ---
            // 위 라인들은 제작자가 명시적으로 따옴표로 감싸지 않는 한 전부 지문으로 취급한다.
            {
              const t = rawClean.trim();
              if (/^info$/i.test(t)) {
                return { kind: "narration" as const, text: rawClean };
              }
              // 구분선(인트로 구획)도 지문으로 유지
              if (/^---+$/.test(t)) {
                return { kind: "narration" as const, text: rawClean };
              }
              // 📍/🕒/🗓/🔧/🌏 등의 메타 라인은 pipe/colon 흡수를 금지
              const hasMetaEmoji = /[📍🕒🗓🔧🌏]/.test(t);
              const hasPipeOrColon = /\|/.test(t) || /[:：]/.test(t);
              if (hasMetaEmoji && hasPipeOrColon) {
                return { kind: "narration" as const, text: rawClean };
              }
            }

            // 일부 모델이 URL 확장자/구분자 찌꺼기만 따로 뱉는 경우가 있음 (스트리밍 분할 등)
            // 예: ".webp", "webp", "! !"
            if (/^\.?\s*(webp|png|jpe?g|gif)\s*$/i.test(raw)) return { kind: "blank" as const, text: "" };
            if (/^[!！]\s*[!！]$/.test(raw) || /^[!！]{1,3}$/.test(raw)) return { kind: "blank" as const, text: "" };

            // 과거 메시지에 남아 있는 '이름 | 대사' 포맷을 소설 포맷으로 흡수
            // 예: 임서원 | "..."  -> "..."  /  임서원 | 네, ... -> "네, ..."
            const pipe = raw.match(/^(.+?)\s*\|\s*(.+)$/);
            if (pipe) {
              const lhs = String(pipe[1] || "").trim();
              let rhs = (pipe[2] || "").trim();

              // 작품 제목 뒤에 같은 줄로 지문이 이어진 출력은 화자 대사가 아니다.
              // 예: "아일릿 신입 매니저 데뷔일지 | 2024년 3월 25일 ..."
              // 기존 로직은 모든 pipe 라인을 무조건 대사로 바꾸면서 지문 전체에
              // 따옴표와 대사 색상을 붙였다. 실제 따옴표 대사는 계속 허용하되,
              // 현재 작품 제목 또는 명백한 다단어 헤더 뒤의 긴 평문은 지문으로 유지한다.
              const normalizedLhs = lhs.replace(/^(?:\*{1,3}|_{1,3}|`{1,3})|(?:\*{1,3}|_{1,3}|`{1,3})$/g, "").trim();
              const currentPresetTitle = String(selectedPreset?.name || "").trim();
              const rhsStartsWithQuote = /^["“”＂'‘’「『]/.test(rhs);
              const lhsWordCount = normalizedLhs.split(/\s+/).filter(Boolean).length;
              const isPresetTitlePrefix = Boolean(currentPresetTitle && normalizedLhs === currentPresetTitle);
              const isObviousNarrationHeader = !rhsStartsWithQuote && lhsWordCount >= 4 && rhs.length >= 80;
              if (isPresetTitlePrefix || isObviousNarrationHeader) {
                return { kind: "narration" as const, text: rhs };
              }

              // (fix) **|** 처럼 구분자(|) 자체가 마크다운 강조로 감싸져 있으면,

              // split 이후 rhs가 "** ..." 로 시작하며, renderNovelInlineColored의 * 제거 로직이

              // 따옴표 쌍을 깨뜨려 `" ..."` 가 대사 하이라이트에서 빠질 수 있다.

              // rhs 선두의 '닫는' 마크다운 기호를 제거해 본문을 안정화한다.

              rhs = rhs.replace(/^(?:\*{1,3}|_{1,3}|`{1,3})+(?=\s|["“”＂'’「『…])/g, "").trimStart();

              const body = rhs.replace(/^(["“”＂])\s*/, "").replace(/\s*(["“”＂])$/, "");
              // {커스텀모드:...} 같은 시작설정 커맨드는 대사로 흡수하지 않는다.
              if (isCustomModeLike(rhs) || isCustomModeLike(body)) {
                return { kind: "narration" as const, text: normalizeForCommandMatch(body).trim() };
              }
              return { kind: "dialogue" as const, text: cleanDialogueText(`"${body}"`) };
            }

            // 과거 메시지에 남아 있는 '이름: 대사' 포맷도 소설 포맷으로 흡수
            // 예: 오지명: 말...  -> "말..."
            const colon = raw.match(/^([A-Za-z0-9가-힣_\-]{1,20})\s*[:：]\s*(.+)$/);
            if (colon) {
              let rhs = (colon[2] || "").trim();

              // (fix) '**:**' / '**: :' 같은 마크다운 잔재로 rhs가 '* ...' 로 시작하면

              // renderNovelInlineColored의 * 처리로 따옴표 쌍이 깨져 대사 하이라이트가 누락될 수 있다.

              rhs = rhs.replace(/^(?:\*{1,3}|_{1,3}|`{1,3})+(?=\s|["“”＂'’「『…])/g, "").trimStart();

              const body = rhs.replace(/^(["“”＂])\s*/, "").replace(/\s*(["“”＂])$/, "");
              // {커스텀모드:...} 같은 시작설정 커맨드는 대사로 흡수하지 않는다.
              if (isCustomModeLike(rhs) || isCustomModeLike(body)) {
                return { kind: "narration" as const, text: normalizeForCommandMatch(body).trim() };
              }
              return { kind: "dialogue" as const, text: cleanDialogueText(`"${body}"`) };
            }


						// (Option A) 지문은 반드시 *...* 로 감싸는 규칙.
						// - 스트리밍 중에는 닫는 * 가 늦게 올 수 있으므로, 시작 * 만 있는 경우도 지문으로 취급해
						//   화면에 불필요한 '*'가 튀지 않게 한다.
						const rawA = rawClean.trim();
						// (fix3) 지문 래퍼는 반드시 단일 '*'로 감싼 경우만 허용한다.
						// - '**...**' (볼드) 같은 마크다운 조각이 '*...*' 지문으로 오인되면, 후속 출력이 깨진다.
						const isWrappedNarration =
							rawA.startsWith("*") &&
							!rawA.startsWith("**") &&
							rawA.endsWith("*") &&
							!rawA.endsWith("**") &&
							rawA.length >= 2;
						if (isWrappedNarration) {
							const inner = rawA.slice(1, -1).trim();
							// 예외: *"대사"* 형태(규칙을 잘못 감싼 경우)도 대사로 분류해 막대/UI가 적용되게 한다.
							const innerNoWs = inner.replace(/^\u2063[UN]\u2063/, "").trimStart();
							const isQuoted =
								(innerNoWs.startsWith('"') && innerNoWs.endsWith('"')) ||
								(innerNoWs.startsWith("“") && innerNoWs.endsWith("”")) ||
								(innerNoWs.startsWith("‘") && innerNoWs.endsWith("’"));
							if (isQuoted) {
								// 따옴표는 표준 큰따옴표로 정규화(후속 로직 일관성)
								const body = inner.replace(/^[“”‘’]/, '"').replace(/[“”‘’]$/, '"');
								return { kind: "dialogue" as const, text: cleanDialogueText(body) };
							}
							return { kind: "narration" as const, text: inner };
						}

						const rawLS = raw.replace(/^[\uFEFF\u200B\u200C\u200D\u2060]+/g, "").trimStart();
						// 화자 마커(\u2063U\u2063 / \u2063N\u2063)가 앞에 붙은 경우에도 대사 판별이 깨지지 않도록 제거
							let rawLS2 = rawLS.replace(/^\u2063[UN]\u2063/, "");
                            rawLS2 = stripLeakStarBeforeQuote(rawLS2);
                            // (fix3) 대사 앞에 '**' 같은 마크다운 래퍼가 붙는 경우가 있어, 따옴표 판정을 위해 선행 포맷을 제거한다.
                            // 예: **"..."*  -> "..."* (뒤의 누수 '*'는 cleanDialogueText가 제거)
                            const stripLeadingMdForQuote = (s: string) =>
                            	String(s || "")
                            		.replace(/^(?:\*{1,3}|_{1,3}|`{1,3})+(?=\s*[\"＂“”‘’「『])/, "")
                            		.trimStart();
                            const rawProbe = stripLeadingMdForQuote(rawLS2);

						// "[낭인] \"...\"" 처럼 화자 태그 + 따옴표 대사를 한 줄에 쓰는 경우도
						// '대사'로 분류해서 막대(파란/빨간)가 적용되게 한다.
						// - 대사는 따옴표(" / “ / ”)로 시작하는 구간이 포함되면 대사로 본다.
						// - 기본 색/따옴표 렌더링은 renderInline이 처리.
						const bracketSpeaker = rawProbe.match(/^\[[^\]]+\]\s*(.*)$/);
						if (bracketSpeaker) {
							const rest = String(bracketSpeaker[1] || "").trimStart();
							const hasQuote = rest.startsWith('"') || rest.startsWith("“") || rest.startsWith("”");
							if (hasQuote) return { kind: "dialogue" as const, text: cleanDialogueText(rawProbe) };
						}
							const rawEnd = rawProbe.trimEnd();
							const isDialogue = introStrictQuotes
								? (() => {
										// 첫(인트로) 메시지는 '쌍따옴표로 감싼 문장만' 대사로 인정한다.
										// 단, 일부 프롬프트/템플릿에서 장식용 배너/명령어가 실수로 따옴표에 감싸져도
										// 그걸 대사 박스로 만들면 가독성이 크게 깨지므로 예외 처리한다.
									const hasOpenQuote =
										rawProbe.startsWith('"') ||
										rawProbe.startsWith("“") ||
										rawProbe.startsWith("‘") ||
										rawProbe.startsWith("「") ||
										rawProbe.startsWith("『");
									if (!hasOpenQuote) return false;

									// 인트로 구간이라도, 모델이 종종 닫는 따옴표를 누락/중복하는 케이스가 있어
									// '여는 따옴표로 시작하면' 우선 대사 후보로 보고(배너 예외는 아래에서 걸러냄)
									// 렌더링 단계에서 공백/중복 따옴표를 정리한다.
									const inner = rawEnd
										.replace(/^["“‘「『]/, "")
										.replace(/["”’」』]+$/, "")
										.trim();

									const innerClean = normalizeForCommandMatch(inner).trim();

									// 배너/구획선/시작 가이드/커스텀모드 같은 '지문/설명'은 따옴표가 있어도 지문 처리
									const looksLikeBanner =
										/you\s*are\s*now\s*entering/i.test(innerClean) ||
										/[\u{1F7E5}\u{1F7E6}\u{1F7E7}\u{1F7E8}\u{1F7E9}\u{1F7EA}\u{2B1B}\u{2B1C}]/u.test(innerClean) ||
										/^\{\s*\ucef4\uc2a4\ud140\ubaa8\ub4dc\s*:/i.test(innerClean) ||
										/^\{\s*custom\s*mode\s*:/i.test(innerClean) ||
										/^\{\s*\ucee4\uc2a4\ud140\ubaa8\ub4dc/i.test(innerClean) ||
										/^\s*---+\s*$/.test(innerClean);

									if (looksLikeBanner) {
										rawLS2 = innerClean;
										return false;
									}

										return true;
								})()
								: rawProbe.startsWith('"') || rawProbe.startsWith("“") || rawProbe.startsWith("”");
						return { kind: isDialogue ? ("dialogue" as const) : ("narration" as const), text: isDialogue ? cleanDialogueText(rawProbe) : rawProbe };     };

					
					// (MD) 소설 모드에서도 '문서형 마크다운'(헤딩/표/리스트/링크)을 예쁘게 렌더하기 위한 보조 함수들.
					// - 일반 대사/지문 톤은 유지하되, 마크다운 구조가 있는 문단은 ReactMarkdown(GFM)으로 렌더한다.
					const isMarkdownRichParagraph = (s: string) => {
						const t = String(s || "").trim();
						if (!t) return false;

						// 표(테이블): 헤더+구분선 조합이 있으면 거의 확실
						const hasTable = /^\s*\|.+\|\s*$/m.test(t) && /^\s*\|[\s\-:|]+\|\s*$/m.test(t);

						// 헤딩, 리스트, 링크(문서형)
						const hasHeading = /^\s{0,3}#{1,6}\s+\S+/m.test(t);
						const hasList = /^\s{0,3}(?:[-*+]|\d+\.)\s+\S+/m.test(t);
						const hasLink = /\[[^\]]+\]\([^\)\s]+\)/.test(t);

						return hasTable || hasHeading || hasList || hasLink;
					};

					// 과거 포맷: "화자 | \"...전체내용...\"" 처럼 메시지 전체를 따옴표로 감싼 케이스를 문서 렌더용으로 언랩한다.
					// - 마크다운 문단 렌더에만 사용(일반 대사/지문은 기존 규칙 유지)
					const unwrapPipeQuotedWrapperForMarkdown = (s: string) => {
						let t = String(s || "");
						// 1) 선행: "<화자> | " 제거
						t = t.replace(/^\s*[^\n|]{1,80}\s*\|\s*["“”]/, "");
						// 2) 후행: 마지막의 "|"" 또는 """ 제거
						t = t.replace(/\|\s*["“”]\s*$/m, "");
						t = t.replace(/\s*["“”]\s*$/m, "");
						return t.trim();
					};

      // 첫 메시지(인트로)에서만:
      // 과거 create API가 첫 메시지를 자동으로 `NPC | "..."` 형태로 저장(자동 감싸기)한 데이터가 존재한다.
      // 제작자가 의도적으로 따옴표로 감싸지 않은 인트로까지 대사로 보이는 문제가 생기므로,
      // 인트로 1번째 메시지에서는 이 자동 wrapper를 무조건 벗겨서 원문(따옴표 없는 본문)으로 복원한다.
      const unwrapPipeQuotedWrapperForIntro = (t: string) => {
        const raw = String(t || "");
        // 매칭: <prefix> | "..." (전체 감싸기)
        const m = raw.match(/^(.+?)\s*\|\s*(["“])([\s\S]*?)\2\s*$/);
        if (!m) return raw;
        const inner = String(m[3] || "");
        if (!inner) return raw;
        return inner.trim();
      };

					const renderMarkdownRich = (md: string) => {
						const markdown = String(md || "");
						return (
							<div
								style={{
									color: NOVEL_NARRATION,
									lineHeight: NOVEL_LINE_HEIGHT,
									fontSize: NOVEL_BASE_FONT_SIZE,
									whiteSpace: "normal",
								}}
							>
								<ReactMarkdown
									remarkPlugins={[remarkGfm]}
									components={{
										h1: ({ children }) => (
											<h1 style={{ margin: "14px 0 8px", fontSize: Math.round(NOVEL_BASE_FONT_SIZE * 1.35), fontWeight: 800 }}>
												{children}
											</h1>
										),
										h2: ({ children }) => (
											<h2 style={{ margin: "12px 0 6px", fontSize: Math.round(NOVEL_BASE_FONT_SIZE * 1.22), fontWeight: 800 }}>
												{children}
											</h2>
										),
										h3: ({ children }) => (
											<h3 style={{ margin: "10px 0 6px", fontSize: Math.round(NOVEL_BASE_FONT_SIZE * 1.1), fontWeight: 800 }}>
												{children}
											</h3>
										),
										p: ({ children }) => <p style={{ margin: "8px 0" }}>{children}</p>,
										ul: ({ children }) => <ul style={{ margin: "8px 0 8px 20px" }}>{children}</ul>,
										ol: ({ children }) => <ol style={{ margin: "8px 0 8px 20px" }}>{children}</ol>,
										li: ({ children }) => <li style={{ margin: "4px 0" }}>{children}</li>,
										a: ({ href, children }) => (
											<a
												href={href}
												target="_blank"
												rel="noreferrer"
												style={{ color: "#9bbcff", textDecoration: "underline", textUnderlineOffset: 2 }}
											>
												{children}
											</a>
										),
										table: ({ children }) => (
											<div style={{ overflowX: "auto", margin: "10px 0" }}>
												<table style={{ width: "100%", borderCollapse: "collapse", fontSize: NOVEL_BASE_FONT_SIZE }}>
													{children}
												</table>
											</div>
										),
										thead: ({ children }) => <thead style={{ background: "rgba(255,255,255,0.08)" }}>{children}</thead>,
										th: ({ children }) => (
											<th style={{ border: "1px solid rgba(255,255,255,0.18)", padding: "10px 10px", textAlign: "left", fontWeight: 800 }}>
												{children}
											</th>
										),
										td: ({ children }) => (
											<td style={{ border: "1px solid rgba(255,255,255,0.12)", padding: "10px 10px", verticalAlign: "top" }}>
												{children}
											</td>
										),
										
												code: ({ className, children, ...props }) => {
													// react-markdown v9: no `inline` prop; determine by className or newline.
													const text = Array.isArray(children) ? children.join("") : String(children ?? "");
													const isBlock = Boolean(className) || text.includes("\n");
    if (!isBlock) {
        return (
            <code
                {...props}
                style={{
                    background: "rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    padding: "2px 6px",
                    fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                    fontSize: Math.max(12, NOVEL_BASE_FONT_SIZE),
                }}
            >
                {children}
            </code>
        );
    }

    return (
        <pre
            style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 14,
                padding: "12px 12px",
                overflowX: "auto",
                margin: "10px 0",
            }}
        >
            <code
                className={className}
                style={{
                    fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                    fontSize: Math.max(12, NOVEL_BASE_FONT_SIZE),
                }}
            >
                {children}
            </code>
        </pre>
    );
},
										img: ({ src, alt }) => {
											if (!showImages) return null;
											const safe = String(src || "");
										return (
											<SmartImage
												src={safe}
												alt={String(alt || "")}
												theme={CHAT_THEME}
												style={{ maxWidth: "100%", borderRadius: 14, margin: "10px 0" }}
											/>
										);
										},
									}}
								>
									{markdown}
								</ReactMarkdown>
							</div>
						);
					};

					// (Option A) 지문 마커 '*'가 한쪽만 도착하거나(스트리밍), 모델이 마크다운을 덜 닫는 경우가 있다.
					// 텍스트 청크에서만(코드펜스 밖), "강조로 해석될 가능성이 높은 '*'" 개수가 홀수이면
					// 끝에 '*'를 하나 붙여 렌더가 깨지는(이후 텍스트까지 기울어지는 등) 현상을 줄인다.
					// - 목록 마커("* \n" 형태)는 제외한다.
					const stabilizeNarrationAsterisks = (textChunk: string) => {
						// (fix) 스트리밍 중 멀티라인 지문(`*...`)이 닫히지 않은 상태에서 다음 줄이 대사(")로 시작하면,
						// 청크 끝에 `*`를 붙이는 단순 보정은 `"..."*` 같은 찌꺼기를 만든다.
						// 여기서는 '멀티라인 지문 시작(*)'만 추적해서, 지문이 닫히기 전에 대사가 시작되면
						// 직전 지문 라인에만 닫는 `*`를 주입한다.
						const raw = String(textChunk || "");
						if (!raw) return raw;

						const lines = raw.replace(/\r\n/g, "\n").split("\n");
						let inNarr = false;
						let lastNarrIdx = -1;

						const isDialogueStartLine = (ln: string) => {
							const t = String(ln || "").trimStart();
							return (
								t.startsWith('"') ||
								t.startsWith("“") ||
								t.startsWith("”") ||
								t.startsWith("「") ||
								t.startsWith("『")
							);
						};

						const isNarrStartLine = (ln: string) => {
							const t = String(ln || "").trimStart();
							if (!t.startsWith("*")) return false;
							// 리스트 마커("* ")는 제외
							if (t.length >= 2 && /\s/.test(t[1])) return false;
							// "**"(볼드) 계열은 여기서 취급하지 않는다
							if (t.startsWith("**")) return false;
							// 한 줄 지문(*...*)은 이미 닫혔으므로 멀티라인 시작으로 보지 않는다
							const r = String(ln || "").trim();
							if (r.length >= 2 && r.startsWith("*") && r.endsWith("*")) return false;
							return true;
						};

						const ensureClosedAt = (idx: number) => {
							if (idx < 0 || idx >= lines.length) return;
							const cur = String(lines[idx] || "");
							const trimmedEnd = cur.trimEnd();
							if (!trimmedEnd) return;
							if (trimmedEnd.trim().endsWith("*")) return;
							lines[idx] = `${trimmedEnd}*`;
						};

						for (let i = 0; i < lines.length; i++) {
							const ln = String(lines[i] || "");
							const t = ln.trim();
							if (!t) continue;

							if (!inNarr) {
								if (isNarrStartLine(ln)) {
									inNarr = true;
									lastNarrIdx = i;
								}
								continue;
							}

							// inNarr === true
							if (isDialogueStartLine(ln)) {
								ensureClosedAt(lastNarrIdx);
								inNarr = false;
								lastNarrIdx = -1;
								continue;
							}

							lastNarrIdx = i;
							if (ln.trimEnd().endsWith("*")) {
								inNarr = false;
								lastNarrIdx = -1;
							}
						}

						// 청크 끝까지 지문이 닫히지 않았으면 마지막 지문 라인에만 닫는 별을 주입
						if (inNarr) ensureClosedAt(lastNarrIdx);
						return lines.join("\n");
					};

						const isStreamingMsg = message.id === streamTempAssistantIdRef.current;
									// done(비스트리밍)에서만 상태창 펜스 복구를 적용한다. (스트리밍 중엔 UX 안정성 우선)
									// (fix) 모델 출력이 JSON-escape된 문자열(\n, \t, \uXXXX 등) 형태로 섞여 들어오면
									// 줄 단위 분해/따옴표 대사 판정/펜스 분리 등이 무력화되어
									// "오프펜스( ```text/INFO ) 이후"부터 소설 렌더 규칙이 깨지는 현상이 발생할 수 있다.
									// → 렌더 직전에 항상 unescape를 적용해, 줄/펜스/대사 판정이 정상적으로 동작하게 한다.
									const txtFixed0 = maybeUnescapeJsonEscapes(String(txt || ""));
									let txtFixed = isStreamingMsg ? txtFixed0 : coerceStatusFenceIfMissing(txtFixed0);
						// (intro) 첫 assistant 메시지는 오프닝/가이드/표가 많아, 파이프("|")로 감싼 wrapper가 들어올 수 있다.
						// 이 경우엔 wrapper를 벗겨서 "따옴표로 감싼 줄만 대사" 규칙이 정상 동작하게 한다.
						if (introStrictQuotes) txtFixed = unwrapPipeQuotedWrapperForIntro(txtFixed);
					// (scroll-jitter fix) 스트리밍 중에는 "복구/보정" 정규화가 과하게 작동하면
					// (줄 이동/별표 닫힘/이미지 라인 정리 등) 델타마다 문단 구성이 흔들리며
					// 바닥에 붙어있는 자동스크롤이 8px 단위로 튀는 현상이 발생할 수 있다.
					// → 스트리밍에서는 최소 정규화만 적용하고, 완료된 메시지에서만 풀 정규화를 적용한다.
									const t0 = isStreamingMsg
										? stripLeadingTitleHeader(txtFixed).replace(/\r\n/g, "\n")
										: normalizeForNovelMarkdown(txtFixed);
					const chunksRaw = splitByFencedCode(t0, !isStreamingMsg);
					// INFO 트림은 '텍스트 청크'에만 적용해서 코드펜스(STATUS) 내부 내용은 보존한다.
					const chunks = chunksRaw.map((c) => {
						if (c.type !== "text") return c;
						let v = stripInfo(c.value);
						// (policy) 소설 모드에서는 '*' 표기가 화면에 절대 노출되지 않도록 전부 제거
						v = stripAllStarGlyphs(v);
						// (중요) 스트리밍 중에는 상태창/일지/요약(STATUS/INFO)이 화면에 끼어들면
						// UX가 크게 흔들린다. 서버에서 턴 끝으로 밀어내더라도, done 직전 델타로
						// 붙는 경우가 있으므로, 스트리밍 동안엔 해당 블록을 숨긴다.
						// (중요) 작품/제작자마다 fenced block 라벨(STATUS/INFO/HELLO 등)이 수백 가지가 될 수 있으므로,
						// 소설 모드에서는 라벨 기반으로 fenced block을 숨기지 않는다.
						// (scroll-jitter fix) 스트리밍 중에는 지문 닫힘(*)을 "주입"하지 않는다.
						// stabilizeNarrationAsterisks는 청크 말미에 `*`를 추가해 렌더 붕괴를 줄이지만,
						// 스트리밍 델타마다 문단 분할/병합 결과가 흔들리면(paraGapPx 단위로)
						// pinned auto-scroll이 위/아래로 튀어 "멀미"가 생길 수 있다.
						// 스트리밍 안정성은 groupNovelLines(isStreaming=true) 경로가 담당한다.
						if (!isStreamingMsg) v = stabilizeNarrationAsterisks(v);
																	// (novel) stabilize 과정에서 별표가 다시 추가되었을 수 있으므로 최종적으로 한 번 더 제거
																	v = stripAllStarGlyphs(v);
						return { ...c, value: v } as const;
					});
          return (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: paraGapPx,
                lineHeight: NOVEL_LINE_HEIGHT,
                whiteSpace: "pre-wrap",
                fontSize: NOVEL_BASE_FONT_SIZE,
								color: NOVEL_NARRATION,
								fontStyle: "normal",
								fontSynthesis: "none",
								wordBreak: "break-word",
								overflowWrap: "anywhere",
              }}
            >
							{chunks.map((chunk, ci) => {
								// 1) 코드펜스 블록은 마크다운 렌더러로 처리
								if (chunk.type === "code") {
									return (
										<div key={`code-${ci}`} style={{ color: NOVEL_NARRATION }}>
											{renderMarkdownLite(chunk.value)}
										</div>
									);
								}

								// 2) 텍스트 청크는 문단 단위로(기존 소설 렌더 유지)
								// (fix) 모델이 `*지문`을 한 줄만 찍고, 실제 닫는 `*`는 다음 문단(빈 줄 이후) 끝에 찍는 경우가 있다.
								// 기존의 `\n{2,}` 분리는 이런 케이스를 문단 경계에서 잘라버려 `*`가 화면에 그대로 남거나(지문이 깨짐)
								// 이후 라인 판정까지 흔들리는 문제가 있다.
								// 따라서 '열린 지문(*)'이 닫힐 때까지는 문단을 병합해, groupNovelLines가 멀티라인 지문으로 안정 처리하게 한다.
								const splitTextIntoNovelParts = (text: string) => {
									const raw = String(text || "").replace(/\r\n/g, "\n");
									const rawParts = raw.split(/\n{2,}/g);
									const out: string[] = [];
									let buf = "";
									let openNarr = false;

									const isNarrStartLine = (ln: string) => {
										const t = String(ln || "");
										const lt = t.trimStart();
										if (!lt.startsWith("*")) return false;
										if (lt.startsWith("**")) return false;
										if (lt.length < 2) return false;
										// `* item` 같은 불릿은 제외(지문 표식은 `*지문` 형태를 가정)
										if (/\s/.test(lt[1])) return false;
										return true;
									};
									const isNarrSingleLine = (ln: string) => {
										const t = String(ln || "").trim();
										if (!isNarrStartLine(t)) return false;
										if (t.endsWith("**")) return false;
										return t.endsWith("*") && t.length >= 2;
									};
									const isNarrCloseLine = (ln: string) => {
										const t = String(ln || "").trim();
										if (!t) return false;
										if (t.endsWith("**")) return false;
										// single-line `*...*`는 '닫힘'으로 보지 않는다(그 자체로 완결)
										if (isNarrSingleLine(t)) return false;
										return t.endsWith("*") && t.length >= 2;
									};
									const hasUnclosedNarrStart = (part: string) => {
										const lines = String(part || "").split("\n");
										for (let i = 0; i < lines.length; i++) {
											const ln = String(lines[i] || "");
											if (!isNarrStartLine(ln)) continue;
											if (isNarrSingleLine(ln)) continue;
											// 같은 문단 내에서 닫힘이 있는지 확인
											let closed = false;
											for (let j = i + 1; j < lines.length; j++) {
												if (isNarrCloseLine(lines[j])) {
													closed = true;
													break;
												}
											}
											if (!closed) return true;
										}
										return false;
									};
									const hasNarrClose = (part: string) => {
										const lines = String(part || "").split("\n");
										for (const ln of lines) {
											if (isNarrCloseLine(ln)) return true;
										}
										return false;
									};

									for (const part of rawParts) {
										const p = String(part ?? "");
										buf = buf ? `${buf}\n\n${p}` : p;

										if (!openNarr) {
											openNarr = hasUnclosedNarrStart(p);
											if (!openNarr) {
												out.push(buf);
												buf = "";
											}
										} else {
											if (hasNarrClose(p)) {
												openNarr = false;
												out.push(buf);
												buf = "";
											}
										}
									}
									if (buf) out.push(buf);
									return out;
								};
								// (HTML) 테이블 블록은 토큰으로 치환해 별도 렌더하고,
								// 나머지 텍스트는 기존 소설 렌더(대사/지문/이미지 토큰/정책) 경로를 유지한다.
								const extractedHtml = extractHtmlTablesToTokens(String(chunk.value || ""));
								const htmlTables = extractedHtml.tables;
								const parts = splitTextIntoNovelParts(extractedHtml.text);
								return parts.map((p, idx) => {
									const pRaw = String(p || "");
									const allowMarkdownRichInThisMode = String(effectiveRenderMode) === 'chat';
												if (allowMarkdownRichInThisMode && isMarkdownRichParagraph(pRaw)) {
										const cleaned = unwrapPipeQuotedWrapperForMarkdown(pRaw);
										return (
											<div key={`mdp-${ci}-${idx}`} style={{ color: NOVEL_NARRATION }}>
												{renderMarkdownRich(cleaned)}
											</div>
										);
									}

									// (fix) 문단 전체 마크다운 렌더를 제거하고, "라인 단위"로 이미지/링크 라인만 마크다운 렌더한다.
// - 이미지/링크 라인은 토글(showImages) OFF 시 숨김
// - 나머지 라인은 기존 소설 렌더(대사/지문/막대)로 처리
											const allLines = String(p || "").split("\n");

										// (Option A) 지문은 *...* 로 감싸되, 한 줄/여러 줄 모두 허용한다.
										// - 여러 줄 지문: 첫 줄에만 시작 '*', 마지막 줄에만 종료 '*'가 오는 케이스를 지원
										// - 스트리밍 중에는 종료 '*'가 늦게 도착할 수 있으므로, 끝까지 지문으로 묶어 표시한다.
										const groupNovelLines = (ls: string[]) => {
											const sanitizeLead = (s: string) =>
												String(s || "")
													.replace(/^[\uFEFF\u180E\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\u202A-\u202E]+/g, "")
													.replace(/^\u2063[UN]\u2063/, "")
													.trimStart();

									// (fix) '*나비의' 같은 짧은 라벨 라인은 멀티라인 지문 시작으로 오인하면
									// 이후 대사/지문 판정이 전부 꼬인다. (별표만 제거하고 일반 라인으로 처리)


											const out: { kind: "blank" | "skip" | "dialogue" | "narration"; text: string }[] = [];
											let i = 0;
											while (i < ls.length) {
												const rawLine = String(ls[i] ?? "");
												const trimmedEnd = rawLine.trimEnd();
												if (!trimmedEnd.trim()) {
													out.push({ kind: "blank", text: "" });
													i++;
													continue;
												}

												// 멀티라인 지문 시작: 첫 줄에 시작 '*'
												const leftTrim = normalizeStarVariants(sanitizeLead(trimmedEnd));
												const startsNarr = leftTrim.startsWith("*") && !leftTrim.startsWith("**");
												const endsNarrSameLine = startsNarr && leftTrim.endsWith("*") && !leftTrim.endsWith("**") && leftTrim.length >= 2;

												if (startsNarr && !endsNarrSameLine) {
														// (fix) '*나비의' 같은 라벨 라인은 멀티라인 지문으로 묶지 않는다.
														if (isLikelyStarLabel(leftTrim)) {
															out.push({ kind: "narration", text: leftTrim.slice(1).trimStart() });
															i++;
															continue;
														}

													// 시작 '*' 제거(첫 줄)
													const first = leftTrim.slice(1).trimStart();
													const buf: string[] = [first];
													i++;
													let closed = false;
													while (i < ls.length) {
														const r = String(ls[i] ?? "").trimEnd();
														if (!r.trim()) {
															// 빈 줄을 만났는데 아직 닫히지 않았다면, 스트리밍 중(혹은 모델 실수)로 보고 지문을 계속 이어간다.
															buf.push("");
															i++;
															continue;
														}
														const rTrim = normalizeStarVariants(r.trim());
														if (rTrim.endsWith("*") && !rTrim.endsWith("**") && rTrim.length >= 2) {
															// 마지막 줄의 종료 '*' 제거
															buf.push(rTrim.slice(0, -1));
															closed = true;
															i++;
															break;
														}
														buf.push(r);
														i++;
													}

													// 닫히지 않았더라도(스트리밍 중) 지문으로 렌더
													out.push({ kind: "narration", text: buf.join("\n").trimEnd() });
													// closed 플래그는 현재는 사용하지 않지만, 디버그 확장 여지가 있어 남겨둔다.
													void closed;
													continue;
												}

												// 그 외는 기존 normalizeNovelLine 규칙으로 처리
												const norm = normalizeNovelLine(trimmedEnd);
												out.push({ kind: norm.kind, text: norm.text });
												i++;
											}
											return out;
										};

										
												// (UI) assistant 출력 안에 "내 대사"가 인용되어 나오는 경우(오타 교정 등),
												// 실제 user 대사로 보이면 파란 막대(=user)로 렌더링한다.
												// (규약) 보이지 않는 화자 마커로 주인공/상대를 확정한다.
												//  - 주인공 대사: "\u2063U\u2063..." (따옴표 안 맨 앞)
												//  - 상대 대사:   "\u2063N\u2063..."
												const INV = "\u2063";
												const USER_MARK = `${INV}U${INV}`;
												const NPC_MARK = `${INV}N${INV}`;
													const stripSpeakerMarks = (s: string) => String(s || "").split(USER_MARK).join("").split(NPC_MARK).join("");
// (fix) 이미지/링크 라인이 섞여도 "대사"는 기존 대사 스타일(막대/색)이 먹도록,
// 라인 단위로 마크다운 라인만 분리 렌더링한다.
const renderGrouped = (grouped: ReturnType<typeof groupNovelLines>, suffix: string) => (
  <div key={`p-${ci}-${idx}-${suffix}`} style={{ display: "flex", flexDirection: "column", gap: 8, fontWeight: NOVEL_TEXT_WEIGHT }}>
    {grouped.map((g, j) => {
      if (g.kind === "skip") return null;
      if (g.kind === "blank") return <div key={j} style={{ height: 6 }} />;

      const isDialogue = g.kind === "dialogue";
      const textLine = stripAllStarGlyphs(g.text);

      // (UI) 막대/박스 제거: 대사/속마음은 색상으로만 구분한다.

      if (isDialogue) {
        return (
          <div
            key={j}
            // 한 줄이 대사로 시작해도 닫는 따옴표 뒤의 지문은 기본 지문색을 상속해야 한다.
            // 실제 대사 구간만 renderNovelInlineColored의 span이 주황색으로 덮는다.
            style={{ color: NOVEL_NARRATION, lineHeight: NOVEL_LINE_HEIGHT }}
          >
            {renderNovelInlineColored(stripSpeakerMarks(textLine))}
          </div>
        );
      }

      return (
        <div key={j} style={{ color: NOVEL_NARRATION, lineHeight: NOVEL_LINE_HEIGHT }}>
          {renderNovelInlineColored(textLine)}
        </div>
      );
    })}
  </div>
);

const outNodes: React.ReactNode[] = [];
let buf: string[] = [];

const flush = (suffix: string) => {
  if (!buf.length) return;
  outNodes.push(renderGrouped(groupNovelLines(buf), suffix));
  buf = [];
};

for (let li = 0; li < allLines.length; li++) {
  const line = allLines[li] ?? "";
  const tr = String(line).trim();

  // (HTML) 테이블 토큰은 별도 렌더한다.
  // - 테이블은 block 단위로만 온전하게 렌더링 가능(라인 단위 마크다운 렌더로s) 이므로,
  //   extractHtmlTablesToTokens()에서 {{htmltbl:N}}로 치환한 뒤 여기서 다시 복원한다.
  // - 이렇게 하면 테이블 이후 텍스트도 기존 소설 렌더 규칙(대사/지문/이미지 토큰)이 계속 적용된다.
  const _tblm = tr.match(/^\{\{htmltbl:(\d+)\}\}$/);
  if (_tblm) {
    const tIndex = Number(_tblm[1]);
    const html = htmlTables[tIndex] || "";
    if (html) {
      flush(`t-${li}-htmltbl`);
      outNodes.push(
        <div key={`htmltbl-${ci}-${idx}-${li}`} style={{ color: NOVEL_NARRATION }}>
          {renderMarkdownLite(html)}
        </div>
      );
      flush(`t-${li}-htmltbl-end`);
      continue;
    }
  }

  const hasImgToken = /\{\{img:[^}]+\}\}/.test(tr);

  // (fix) 작품 갤러리 참조키(예: {{img:QsnPtw}})는 URL이 아니라 토큰이다.
  // 기존에는 소설 모드 정규화에서 {{img:...}}를 마크다운 이미지로 바꿔버려
  // <img src="QsnPtw"> 같은 상대 경로 요청(404)이 발생했다.
  // 여기서 토큰을 직접 처리하여 갤러리/외부 URL 모두 안정적으로 렌더한다.
  if (hasImgToken) {
    flush(`t-${li}-imgtok`);

    if (!showImages) {
      const stripped = line.replace(/\{\{img:[^}]+\}\}/g, "");
      if (stripped.trim()) buf.push(stripped);
      continue;
    }

    const tokenBlocks = splitByImgToken(line);
    for (let bi = 0; bi < tokenBlocks.length; bi++) {
      const b = tokenBlocks[bi] as any;
      if (b.type === "text") {
        const t = String(b.text || "");
        if (t.trim()) buf.push(t);
      } else {
        flush(`t-${li}-imgtok-${bi}`);
        outNodes.push(renderImageCut(b.key, `img-novel-${ci}-${idx}-${li}-${bi}`));
      }
    }

    flush(`t-${li}-imgtok-end`);
    continue;
  }

  const hasMdImage = /!\[[^\]]*\]\([^\)]+\)/.test(tr);
  const isMdLinkOnly = /^\[[^\]]+\]\([^\)]+\)\s*$/.test(tr);

  // (fix) 이미지 마크다운은 "전용 라인"뿐 아니라 문장과 함께 섞여도 렌더해야 한다.
  // 그렇지 않으면 스트리밍 분할로 인해 `...![](url)` 형태가 텍스트로 그대로 남는다.
  if (hasMdImage || isMdLinkOnly) {
    flush(`t-${li}`);

    // 이미지 표시 OFF면 이미지 마크다운만 제거하고 나머지 텍스트는 소설 렌더로 계속 처리
    if (hasMdImage && !showImages) {
      const stripped = line.replace(/!\[[^\]]*\]\([^\)]+\)/g, "");
      if (stripped.trim()) buf.push(stripped);
      continue;
    }

    // 이미지 표시 ON이면 라인 전체를 마크다운 라이트 렌더
    outNodes.push(
      <div key={`md-${ci}-${idx}-${li}`} style={{ color: NOVEL_NARRATION }}>
        {renderMarkdownLite(line)}
      </div>
    );
    continue;
  }

  buf.push(line);
}

flush("end");

return (
  <div key={`blk-${ci}-${idx}`} style={{ display: "flex", flexDirection: "column", gap: 8, fontWeight: NOVEL_TEXT_WEIGHT }}>
    {outNodes}
  </div>
);
								});
							})}
            </div>
          );
        }

        // (chat) 채팅 모드에서도 마크다운(코드블록/외부 이미지)을 렌더링한다.
        // - 소설 모드(renderNovel)는 그대로 유지
        // - {{img:...}} 토큰은 기존과 동일하게 갤러리 이미지로 렌더링
        const blocks = splitByImgToken(txt);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {blocks.map((b, bi) => {
              if (b.type === "img") return renderImageCut(b.key, `img-chat-${bi}`);
              return <div key={`blk-${bi}`}>{renderMarkdownLite(String(b.text || ""))}</div>;
            })}
          </div>
        );
      }

      // --- user message rendering ---
      // (요구사항) 입력창 미리보기와 동일 규칙:
      //   *...* / **...** 는 지문(흰색), 그 외는 대사(주황)
      // - 출력(assistant) 소설 렌더 기준선은 유지 (여기는 user 전용)
      const rawUser = String(message.content || "");
      const effectiveRenderMode: "chat" | "novel" =
        (settings as any)?.renderMode === "chat" || (settings as any)?.renderMode === "novel"
          ? ((settings as any).renderMode as "chat" | "novel")
          : "novel";

      


      // (HTML) user 메시지라도 소설 모드에서 <table>...</table> (sim-card 포함)은 안전 렌더(표/카드 변환)한다.
      if (effectiveRenderMode === "novel" && /<table[\s>]/i.test(rawUser)) {
        return (
          <div style={{ lineHeight: 1.6, whiteSpace: "pre-wrap", fontWeight: NOVEL_TEXT_WEIGHT }}>
            {renderMarkdownLite(rawUser)}
          </div>
        );
      }
      if (effectiveRenderMode === "novel") {
        const ls = String(rawUser || "").replace(/\r\n/g, "\n").split("\n");

        // user(내 메시지) 소설 모드 규칙
        // - 지문(*...* / **...**) => 회색 + italic
        // - 대사 => 흰색 (막대/박스 없음)
        const userDialogueStyle: React.CSSProperties = { color: "#ffffff", lineHeight: 1.85, fontStyle: "normal" };

        // 멀티라인 지문도 지원(*로 시작해서 *로 닫힐 때까지)
        const out: { kind: "blank" | "narration" | "dialogue"; text: string }[] = [];
        for (let i = 0; i < ls.length; ) {
          const raw = String(ls[i] ?? "").trimEnd();
          if (!raw.trim()) {
            out.push({ kind: "blank", text: "" });
            i++;
            continue;
          }
          const leftTrim = raw.trimStart();
          const startsNarr = leftTrim.startsWith("*");
          const endsNarrSameLine = startsNarr && leftTrim.endsWith("*") && leftTrim.length >= 2;


          // (fix) "*지문* 대사" 한 줄 입력 지원: 같은 줄에서 닫는 *가 있으면 지문/대사로 분리한다.
          if (startsNarr) {
            const closeStar = leftTrim.indexOf("*", 1);
            if (closeStar > 1) {
              const narr = leftTrim.slice(1, closeStar).trim();
              const rest = leftTrim.slice(closeStar + 1).trimStart();
              if (narr) out.push({ kind: "narration", text: narr });
              if (rest) out.push({ kind: "dialogue", text: rest });
              i++;
              continue;
            }
          }

          if (startsNarr && !endsNarrSameLine) {
														// (fix) '*나비의' 같은 라벨 라인은 멀티라인 지문으로 묶지 않는다.
														if (isLikelyStarLabel(leftTrim)) {
															out.push({ kind: "narration", text: leftTrim.slice(1).trimStart() });
															i++;
															continue;
														}

            const first = leftTrim.slice(1).trimStart();
            const buf: string[] = [first];
            i++;
            while (i < ls.length) {
              const r = String(ls[i] ?? "").trimEnd();
              if (!r.trim()) {
                buf.push("");
                i++;
                continue;
              }
              const rTrim = normalizeStarVariants(r.trim());
              if (rTrim.endsWith("*") && rTrim.length >= 2) {
                buf.push(rTrim.slice(0, -1));
                i++;
                break;
              }
              buf.push(r);
              i++;
            }
            out.push({ kind: "narration", text: buf.join("\n").trimEnd() });
            continue;
          }

          // 단일 라인 지문(*...* / **...**)
          if ((leftTrim.startsWith("**") && leftTrim.endsWith("**") && leftTrim.length >= 4) || endsNarrSameLine) {
            const inner = leftTrim.startsWith("**") ? leftTrim.slice(2, -2) : leftTrim.slice(1, -1);
            out.push({ kind: "narration", text: inner });
            i++;
            continue;
          }

          out.push({ kind: "dialogue", text: raw });
          i++;
        }

        return (
          <div style={{ fontSize: Math.max(12, Math.min(24, Number(chatFontSizePx || 18))), lineHeight: 1.85, whiteSpace: "pre-wrap", fontWeight: NOVEL_TEXT_WEIGHT }}>
            {out.map((g, j) => {
              if (g.kind === "blank") return <div key={j} style={{ height: 6 }} />;
              if (g.kind === "narration") {
                return (
                  <div key={j} style={{ color: "rgba(229,231,235,0.72)", lineHeight: 1.85, fontStyle: "italic" }}>
                    {renderInline(g.text)}
                  </div>
                );
              }
              return (
                <div key={j} style={userDialogueStyle}>
                  {renderInline(g.text)}
                </div>
              );
            })}
          </div>
        );
      }


      return (
        <div style={{ lineHeight: 1.6, whiteSpace: "pre-wrap", fontWeight: NOVEL_TEXT_WEIGHT }}>
          {renderMarkdownLite(rawUser)}
        </div>
      );
    },
	    // (성능) messages는 본문에서 쓰지 않는다. deps에 남겨두면 스트리밍 델타마다
	    // MessageContent가 새로 만들어져 렌더된 메시지 전부가 재파싱된다.
	    [CHAT_THEME, galleryMap, renderInline, renderNovelInlineColored, renderNovel, renderMarkdownLite, buildInputPreviewNodes, (settings as any)?.renderMode, selectedProfile, selectedPreset?.name, showImages, firstAssistantId, chatFontSizePx, paraSpacing, paraGapPx]
  );

  // (성능) 토큰 팝업 오픈 핸들러를 안정화해서, 입력창 타이핑마다 MessageList가 재렌더되는 것을 줄인다.
  const openTokenInfo = useCallback((m: Msg, anchorEl?: HTMLElement | null) => {
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      setTokenPopupAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    } else {
      setTokenPopupAnchor(null);
    }

    const usageNow = m?.usage ?? null;
    tokenPopupMessageIdRef.current = String(m?.id || "");
    setTokenPopup({ open: true, title: "토큰 사용량", usage: usageNow });

    // history는 경량 usage로 내려오므로, 상세 정보가 없으면 단건 hydrate로 보강한다.
    const needHydrate =
      !!m?.id &&
      (!usageNow ||
        typeof usageNow.promptTokens !== "number" ||
        typeof usageNow.outputTokens !== "number" ||
        typeof usageNow.reasoningTokens !== "number" ||
        !usageNow.tokenBreakdown);

    if (!needHydrate) return;
    hydrateUsageForMessage(String(m.id))
      .then((fullUsage) => {
        if (!fullUsage) return;
        if (tokenPopupMessageIdRef.current !== String(m.id)) return;
        setTokenPopup((prev) => (prev.open ? { ...prev, usage: fullUsage } : prev));
      })
      .catch(() => {});
  }, [hydrateUsageForMessage]);


  async function loadProfile() {
    const res = await fetch(`/api/profile`);
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json?.error || "프로필 불러오기 실패");
    const list = (json.profiles || []) as any[];
    setProfiles(list);
    // 기본 선택: 기존 선택 유지, 아니면 최신 1개
    if (list.length > 0) {
      setSelectedProfileId((prev) => prev || String(list[0].id));
    } else {
      setSelectedProfileId("");
    }
  }

  async function saveProfile(next: { id?: string; personaName: string; personaAge: number; personaGender: string; personaInfo: string }) {
    const res = await fetch(`/api/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json?.error || "프로필 저장 실패");
    await loadProfile();
    if (json.id) setSelectedProfileId(String(json.id));
  }

  async function deleteProfile(id: string) {
    const res = await fetch(`/api/profile?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json?.error || "프로필 삭제 실패");
    await loadProfile();
  }

  // 최초 1회: 전역 페르소나 불러오기
  useEffect(() => {
    loadProfile().catch(() => {});
  }, []);

  async function createChat(replaceExisting: boolean = false, confirmed: boolean = false) {
    if (!presetId) return alert("작품을 먼저 선택해 주세요.");

    // 새로 시작(replaceExisting=true)일 때는 최신 3개만 유지하고 오래된 대화를 정리한다.
    if (replaceExisting && chatList.length > 0 && !confirmed) {
      openConfirm({
        title: "새 대화 시작",
        desc: "새 대화를 시작합니다. 이어하기는 최신 3개까지 유지되고, 더 오래된 대화는 정리됩니다. 계속할까요?",
        confirmText: "새 대화 시작",
        danger: true,
        action: "newChat",
      });
      return;
    }
    if (createChatInFlightRef.current) return;
    createChatInFlightRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId, replaceExisting }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "채팅 생성 실패");
      setChatId(json.chatId);
      setMessages([]);

      oldestCreatedAtRef.current = null;

      setHasMoreOlder(false);
      // 고정 windowing: 새 채팅은 항상 tail window(=0)로 리셋
      pinnedToBottomRef.current = true;
      setWindowStart(0);
      setInput("");
      // 새 채팅 시작 시 이전 추천답변이 남아있지 않도록 초기화
      setSuggestions([]);
      loadChatList(presetId).catch(() => {});
    } catch (e: any) {
      showToast("설정 저장 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      createChatInFlightRef.current = false;
      setBusy(false);
    }
  }


  async function deleteChatAndExit(confirmed: boolean = false) {
    if (!chatId) return;
    if (!confirmed) {
      openConfirm({
        title: "채팅 삭제",
        desc: "이 채팅을 즉시 삭제하고 나갈까요? (히스토리/설정/요약도 함께 삭제됩니다.)",
        confirmText: "삭제",
        danger: true,
        action: "deleteChat",
      });
      return;
    }
    // 모델 생성 중 삭제를 누르면 즉시 중단 후 삭제를 진행한다.
    cancelInFlightSend("delete-chat");
    setBusy(true);
    try {
      const res = await fetch("/api/chat/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "채팅 삭제 실패");

      // UI 초기화
      const pid = presetId;
      setChatId("");
      setMessages([]);

      oldestCreatedAtRef.current = null;

      setHasMoreOlder(false);
      // 고정 windowing: 채팅 삭제 후 상태를 tail window로 리셋
      pinnedToBottomRef.current = true;
      setWindowStart(0);
      setSettings(null);
      setInput("");
      setSuggestions([]);
      if (pid) await loadChatList(pid);
    } catch (e: any) {
      showToast("설정 저장 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory(targetChatId: string) {
    const targetGeneration = chatContextGenerationRef.current;
    const res = await fetch(
      `/api/chat/history?chatId=${encodeURIComponent(targetChatId)}&limit=${HISTORY_INITIAL_PAGE_SIZE}&includeUsage=0`
    );
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json?.error || "히스토리 불러오기 실패");
    if (
      activeChatIdRef.current !== targetChatId ||
      chatContextGenerationRef.current !== targetGeneration
    ) return;
    const msgs: Msg[] = Array.isArray(json?.messages) ? (json.messages as Msg[]) : [];
    setMessages(msgs);
    oldestCreatedAtRef.current = (msgs[0] as any)?.createdAt ?? null;
    newestCreatedAtRef.current = (msgs[msgs.length - 1] as any)?.createdAt ?? null;
    setHasMoreOlder(!!json?.hasMoreOlder);
    setHasMoreNewer(false);
    // 고정 windowing: 히스토리 로드 후에는 기본적으로 최신 tail window로 시작
    pinnedToBottomRef.current = true;
    setWindowStart(Math.max(0, msgs.length - WINDOW_RENDER_SIZE));
    // 다른 채팅으로 이동 시, 이전 채팅의 추천답변이 남아있지 않도록 초기화
    setSuggestions([]);
  }


  async function loadSettings(targetChatId: string) {
    const targetGeneration = chatContextGenerationRef.current;
    const res = await fetch(`/api/chat/settings?chatId=${encodeURIComponent(targetChatId)}`);
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json?.error || "설정 불러오기 실패");
    if (
      activeChatIdRef.current !== targetChatId ||
      chatContextGenerationRef.current !== targetGeneration
    ) return;
    const s = json.settings as any;
    s.model = coerceChatModelId(String(s?.model || ""));
    // 기본 모드: 소설 (채팅 모드 임시 비활성화)
    s.renderMode = "novel";

	    // 최근 원문(유저 입력) 참고는 고정 7턴
	    s.memoryFrom = 7;

	    // 장기 기억 요약 주기: 고정 5턴
	    s.summaryEvery = 5;

    // summaryLength = 장기기억 요약 "턴당 글자수" (30~200, step 10)
	    const sl = Number(s?.summaryLength ?? 40);
	    if (!Number.isFinite(sl)) s.summaryLength = 40;
    else {
      const snapped = Math.round(sl / 10) * 10;
      s.summaryLength = Math.max(30, Math.min(200, snapped));
    }

    setSettings(s);
  }

  async function loadChatList(pid: string) {
    try {
      const res = await fetch(`/api/chat/list?presetId=${encodeURIComponent(pid)}&limit=20`);
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "채팅 목록 불러오기 실패");
      setChatList(json.chats || []);
    } catch {
      setChatList([]);
    }
  }

  async function saveSettings() {
    if (!chatId) {
      showToast("채팅이 없습니다", "먼저 채팅을 생성해 주세요.", "error");
      return;
    }
    if (!settings) return;

    setSaving(true);
    try {
      const res = await fetch("/api/chat/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, chatId }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "설정 저장 실패");

      // 저장 후에는 서버가 보정한 값을 그대로 사용한다.
      if (json?.settings) {
        const ss = { ...(json.settings as any) };
        ss.model = coerceChatModelId(String(ss?.model || ""));
        setSettings(ss);
      }
      showToast("설정 저장 완료", undefined, "success");
    } catch (e: any) {
      showToast("설정 저장 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      setSaving(false);
    }
  }

  // 일부 UI(색상 등)에서 즉시 반영이 필요할 때, 알림 없이 조용히 저장합니다.
  async function saveSettingsSilent(partial: Partial<Settings>) {
    if (!chatId) return;
    if (!settings) return;
    const merged = { ...settings, ...partial } as Settings;
    try {
      const res = await fetch("/api/chat/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...merged, chatId }),
      });
      const json = await safeJson(res);
      if (res.ok && json?.settings) {
        const ss = { ...(json.settings as any) };
        ss.model = coerceChatModelId(String(ss?.model || ""));
        setSettings(ss);
      }
    } catch {
      // ignore
    }
  }

  // (리팩터링) ChatArea.tsx의 거대한 스트리밍 pacer/프리버퍼 로직을 훅으로 분리.
  // - 기능 삭제 없이, 파일 의존도를 낮추고 컴파일/리뷰 난이도를 줄이기 위한 목적.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const {
    prebufferUiActive,
    prebufferSec,
    prebufferDots,
    stallUiActive,
    setStallUiActive,
    streamTargetRef,
    streamShownRef,
    streamTempAssistantIdRef,
    streamLastDeltaAtRef,
    streamLastPingAtRef,
    streamHasDeltaRef,
    startStreamPacer,
    stopStreamPacer,
  } = useChatStreamPacer<Msg>({
    setMessages,
    scrollToBottomIfAllowed,
    getRenderMode: () => (settingsRef.current as any)?.renderMode,
  });

  // (UX) When "재생성(리롤)" is clicked during generation, abort the current request
  // and ignore any late-arriving stream chunks from the cancelled request.
  const bumpSendSeq = useCallback(() => {
    const next = sendSeqGenRef.current + 1;
    sendSeqGenRef.current = next;
    sendActiveSeqRef.current = next;
    return next;
  }, []);

  const cancelInFlightSend = useCallback(
    (_reason: string = "user") => {
      void _reason;
      const hadActiveRequest = !!sendAbortRef.current;
      // 1) Invalidate any pending stream writers first
      bumpSendSeq();

      // 2) Abort fetch (client-side). Server may continue, but UI will stop consuming.
      const ctl = sendAbortRef.current;
      if (ctl && !ctl.signal.aborted) {
        try {
          ctl.abort();
        } catch {}
      }
      sendAbortRef.current = null;

      // 3) Stop UI pacer to avoid trailing flush from the cancelled request
      try {
        stopStreamPacer({ flush: true });
      } catch {}
      setStallUiActive(false);
      setManualThinkingTargetId("");
      // Abort-only 경로(새 요청 없이 취소)에서는 busy를 직접 해제해야 입력이 잠기지 않는다.
      if (hadActiveRequest) setBusy(false);
    },
    [bumpSendSeq, stopStreamPacer, setStallUiActive]
  );

  // Switching chats or leaving the chat view also cancels the server-side model request.
  useEffect(() => {
    return () => cancelInFlightSend("chat-context-change");
  }, [chatId, presetId, cancelInFlightSend]);

  // 생성 중 Esc = 중단. 입력창은 busy일 때 disabled라 keydown을 못 받으므로 window에 건다.
  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancelInFlightSend("user-stop-esc");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, cancelInFlightSend]);


  // 최신 추천 생성용(ref): 스트리밍 완료본을 state 레이스 없이 사용
  const lastAssistantForSuggestRef = useRef<string>("");
  const lastUserForSuggestRef = useRef<string>("");

const lastAssistantSuggestSummaryRef = useRef<string>("");
  const lastAssistantLastNpcLineRef = useRef<string>("");

  // 추천답변은 "방금 출력된 본문"을 스캔해야 한다.
  // - assistant 출력 끝의 ```INFO```/```STATUS``` 메타가 섞이면 문맥이 틀어진다.
  // - 채팅 이동 시 ref가 남으면 다른 채팅의 문맥으로 추천이 생성될 수 있다.
  const cleanTextForSuggest = (t: string) => {
    let s = stripEndMarkerClient(String(t || ""));
    // Remove meta fences entirely (keep only story text)
    s = s.replace(/```\s*(INFO|STATUS)[\s\S]*?```/gi, "").trim();
    // Remove obvious markdown image/link lines that often appear in outputs
    s = s.replace(/!\[[^\]]*\]\([^\)]+\)/g, " ").trim();
    s = s.replace(/\[[^\]]*\]\([^\)]+\)/g, " ").trim();
    // collapse whitespace
    s = s.replace(/\s+/g, " ").trim();
    return s;
  };
  const buildSuggestBundle = (assistantRaw: string) => {
    // Make suggestion context more stable by extracting a short scene brief + last NPC quote.
    const cleaned = cleanTextForSuggest(assistantRaw || "");
    const stripInvis = (s: string) => s.replace(/[\u200B-\u200D\uFEFF\u2063]/g, "");
    const t = stripInvis(cleaned);

    const takeLastMatch = (re: RegExp) => {
      let last = "";
      let m: RegExpExecArray | null;
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((m = r.exec(t))) {
        const v = String(m[1] || "").trim();
        if (v) last = v;
      }
      return last;
    };

    // last quoted dialogue (most likely NPC)
    const q1 = takeLastMatch(/"([^"\n]{1,220})"/g);
    const q2 = takeLastMatch(/“([^”\n]{1,220})”/g);
    const q3 = takeLastMatch(/”([^”\n]{1,220})”/g);
    const lastNpcLine = [q1, q2, q3].filter(Boolean).slice(-1)[0] || "";

    // scene brief: remove quoted lines and take tail
    let narrative = t
      .replace(/"[^"\n]{1,220}"/g, " ")
      .replace(/“[^”\n]{1,220}”/g, " ")
      .replace(/”[^”\n]{1,220}”/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (narrative.length > 420) narrative = narrative.slice(-420).trim();
    // Prefer last 1~2 sentences
    const parts = narrative.split(/(?<=[\.\!\?\。\！\？])\s+|\s+(?=이제,|\s*이제\s)/).filter(Boolean);
    let brief = parts.slice(-2).join(" ").trim();
    if (!brief) brief = narrative;
    if (brief.length > 260) brief = brief.slice(-260).trim();

    return { brief, lastNpcLine };
  };


  // 채팅 전환 시 추천 ref가 남아있으면, 다른 채팅의 "방금 출력"을 스캔하는 것처럼 동작할 수 있다.
  useEffect(() => {
    suggestChatIdRef.current = String(chatId || "");
    // 이전 방에서 날아오던 추천 응답을 폐기한다.
    suggestReqSeqRef.current += 1;
    setSuggestLoading(false);
    lastAssistantForSuggestRef.current = "";
    lastUserForSuggestRef.current = "";
    lastAssistantSuggestSummaryRef.current = "";
    lastAssistantLastNpcLineRef.current = "";
  }, [chatId]);

  const triggerMemoryRefresh = useCallback(
    (memoryRefresh: any) => {
      try {
        const shouldDoRefresh = !!(memoryRefresh?.shouldRefresh || memoryRefresh?.mode);
        if (!shouldDoRefresh || !chatId) return;

        const mode = String(memoryRefresh?.mode || "all");
        const refreshChatId = String(chatId);
        const runtimeForRefresh = memoryRefresh?.runtime || null;

        // 한 번에 3턴 블록 하나만 처리하는 API이므로 밀린 블록을 순서대로 따라잡는다.
        // 탭 전환이나 일시적인 네트워크 오류로 요청 하나가 빠져도 최대 3회 재시도한다.
        void (async () => {
          const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
          let lastRefreshError = "";
          const refreshOnce = async () => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                const res = await fetch("/api/chat/memory/refresh", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chatId: refreshChatId,
                    runtime: runtimeForRefresh,
                    mode,
                    repairCorrupted: true,
                    allowBadOutputSave: false,
                  }),
                  keepalive: true,
                });
                if (!res.ok) throw new Error(`장기기억 갱신 HTTP ${res.status}`);
                const body = (await res.json().catch(() => null)) as any;
                if (!body || body.ok === false) {
                  throw new Error(String(body?.error || "장기기억 갱신 응답이 올바르지 않습니다."));
                }
                lastRefreshError = "";
                return body;
              } catch (cause: any) {
                lastRefreshError = String(cause?.message || "장기기억 갱신에 실패했습니다.");
                if (attempt >= 2) return null;
                await wait(600 * (attempt + 1));
              }
            }
            return null;
          };

          for (let windowIndex = 0; windowIndex < 8; windowIndex += 1) {
            const body = await refreshOnce();
            if (!body) {
              try {
                window.dispatchEvent(
                  new CustomEvent("mate:memory-refreshed", {
                    detail: { chatId: refreshChatId, kind: "summary", error: lastRefreshError },
                  })
                );
              } catch {}
              break;
            }
            try {
              window.dispatchEvent(
                new CustomEvent("mate:memory-refreshed", {
                  detail: {
                    chatId: refreshChatId,
                    kind: "summary",
                    refreshed: !!body?.refreshed,
                    skipped: !!body?.skipped,
                    reason: String(body?.reason || ""),
                  },
                })
              );
            } catch {}
            if (!body?.morePending) break;
            await wait(80);
          }
        })();
      } catch {}
    },
    [chatId]
  );

  const triggerCharacterMemoryRefresh = useCallback(
    (assistantMessageId?: string) => {
      try {
        if (!chatId) return;
        const mid = String(assistantMessageId || "").trim();
        if (!mid) return;
        const refreshChatId = String(chatId);
        fetch("/api/chat/characters/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: refreshChatId, assistantMessageId: mid }),
          keepalive: true,
        })
          .then(async (response) => {
            const body = (await response.json().catch(() => null)) as any;
            if (!response.ok || !body || body.ok === false) {
              throw new Error(String(body?.error || `개별 기억 갱신 HTTP ${response.status}`));
            }
            try {
              window.dispatchEvent(
                new CustomEvent("mate:memory-refreshed", {
                  detail: {
                    chatId: refreshChatId,
                    kind: "character",
                    saved: Math.max(0, Number(body?.saved || 0)),
                    evaluated: Math.max(0, Number(body?.evaluated || 0)),
                    reason: String(body?.reason || ""),
                  },
                })
              );
            } catch {}
          })
          .catch((cause: any) => {
            try {
              window.dispatchEvent(
                new CustomEvent("mate:memory-refreshed", {
                  detail: {
                    chatId: refreshChatId,
                    kind: "character",
                    error: String(cause?.message || "개별 기억 갱신에 실패했습니다."),
                  },
                })
              );
            } catch {}
          });
      } catch {}
    },
    [chatId]
  );

async function send(overrideText?: unknown) {
  if (busy) return;
  let reqSeq = 0;
  let abortCtl: AbortController | null = null;

	  if (!LOCAL_POINTS_DISABLED) {
	    // 친구비가 0이면 전송을 막고, 충전 유도 팝업을 띄운다.
	    // (서버 주입/DB 연동 전 단계: 로컬 잔액 기준)
	    try {
	      const bal = readFriendFeeBalance();
	      if (bal <= 0) {
	        friendFeeEmptyShownRef.current = true;
	        openFriendFeeEmptyPopup();
	        return;
	      }
	    } catch {
	      // ignore
	    }
	  }

	  const override = typeof overrideText === "string" ? overrideText : undefined;
  const shouldClearInput = override === undefined;
  const text = (override ?? input).trim();
	  if (!text) return;
  // 추천답변 문맥 정확도를 위해: 방금 보낸 user 텍스트를 ref에 저장(React state 레이스 방지)
  lastUserForSuggestRef.current = text;

  setBusy(true);
  setSendError(null);

  const tempUserId = `temp-u-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempAssistantId = `temp-a-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const now = Date.now();
  const tempUser: Msg = { id: tempUserId, chatId, role: "user", content: text, createdAt: now };
  const tempAssistant: Msg = { id: tempAssistantId, chatId, role: "assistant", content: "", createdAt: now + 1 };

  const willExceedWindow = messages.length + 2 > WINDOW_HARD_CAP;
  if (willExceedWindow) setHasMoreOlder(true);

  // ✅ windowing/UX: 사용자가 전송한 순간에는 항상 최신 tail window로 고정한다.
  // - 사용자가 과거 구간을 보고 있더라도, 전송 후 "내가 쓴 곳"으로 즉시 돌아가야 함
  pinnedToBottomRef.current = true;
  const nextLen = Math.min(messages.length + 2, WINDOW_HARD_CAP);
  const nextStart = Math.max(0, nextLen - WINDOW_RENDER_SIZE);
  setWindowStart(nextStart);

  setMessages((prev) => {
    const merged = [...prev, tempUser, tempAssistant];
    // chatting 중에는 최신 구간 유지(TAIL)
    return merged.length > WINDOW_HARD_CAP ? merged.slice(merged.length - WINDOW_HARD_CAP) : merged;
  });

  // ✅ UX: 사용자가 "전송(Enter)"한 순간에는 항상 맨 아래로 점프한다.
  // (완료(done) 시점 자동 스크롤은 금지 — 읽던 위치를 보호)
  nearBottomRef.current = true;
  requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottomForce()));

  startStreamPacer(tempAssistantId);
  if (shouldClearInput) setInput("");
  // (요구사항) 추천답변은 "직전 assistant(마지막 지문)" 기준으로 매번 새로 갱신되어야 한다.
  // 기존 suggestions가 남아있으면 자동 생성 useEffect가 동작하지 않으므로, 새 요청 시작 시 항상 초기화한다.
  setSuggestions([]);


  try {
    // (중요) 서버 프롬프트/요약 로직은 persona/runtime 값에 의존한다.
    // - personaOverride가 없으면 서버는 주인공 이름을 기본값("주인공")으로 사용해 출력에 반영될 수 있다.
    // - runtime이 없으면 요약/컨텍스트 구성 파라미터가 DB 저장값과 어긋나거나(특히 UI 슬라이더) 기본값으로 떨어질 수 있다.
      const personaOverride = {
        personaName: (settings?.personaName || selectedProfile?.personaName || "").trim(),
        personaAge: Number(settings?.personaAge || selectedProfile?.personaAge || 0),
        personaGender: String(settings?.personaGender || selectedProfile?.personaGender || "").trim(),
        personaInfo: String(settings?.personaInfo || selectedProfile?.personaInfo || "").trim(),
      };

    const modelName = String(settings?.model || "");
    // Gemini 3 Pro: use NDJSON streaming transport for keep-alive stability,
    // but the server will still send a single final "done" payload (no deltas).
    // This prevents common 120s proxy timeouts while keeping the UI "one-shot".
    const wantStream = /gemini-3(?:\.\d+)?-pro/i.test(modelName);

    const payload = {
      chatId,
      userText: text,
      personaOverride,
      runtime: {
        model: settings?.model,
        maxOutputTokens: settings?.maxOutputTokens,
        maxReasoningTokens: settings?.maxReasoningTokens,
        keepUserTurns: settings?.memoryFrom,
        perTurnChars: settings?.summaryLength,
      },
      currentMsgId: selectedMsgIdForRegenerate || null,
      rewriteFromMsgId: selectedMsgIdForRewrite || null,
      includeSuggestions: false,
      stream: wantStream,
    };

      const dbgId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      devDebug(`[ui][send][${dbgId}] POST /api/chat/send`, payload);

      reqSeq = bumpSendSeq();
      abortCtl = new AbortController();
      sendAbortRef.current = abortCtl;

      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortCtl!.signal,
        body: JSON.stringify(payload),
      });

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      devDebug(`[ui][send][${dbgId}] status=${res.status} ct=${ct}`);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        devError(`[ui][send][${dbgId}] non-OK response`, errText);
        throw new Error(errText || `HTTP ${res.status}`);
      }


    
    // ---- NDJSON streaming ----
    if (ct.includes("application/x-ndjson")) {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream body");

      const dec = new TextDecoder();
      let buf = "";
      let realUser: Msg | null = null;
      let realAssistant: Msg | null = null;
      // stream stall diagnostics (helps distinguish "app stalled" vs "proxy timeout")
      const STALL_WARN_MS = 15000;
      let lastStallWarnAt = 0;
      const stallTimer = window.setInterval(() => {
        const last = streamLastDeltaAtRef.current;
        const lastPing = streamLastPingAtRef.current;
        if (!last && !lastPing) return;
        const now = Date.now();
        const gap = last ? now - last : Number.POSITIVE_INFINITY;
        const pingGap = lastPing ? now - lastPing : Number.POSITIVE_INFINITY;

        // UI: If pings are coming in but deltas are not, show an on-screen "generating" indicator
        // to reduce the "stuck" feeling (Gemini 3 Pro can be silent for long stretches).
        if (pingGap < 20000 && gap > 5000) {
          setStallUiActive(true);
        } else {
          setStallUiActive(false);
        }

        if (last && gap >= STALL_WARN_MS && now - lastStallWarnAt >= STALL_WARN_MS) {
          lastStallWarnAt = now;
          devWarn(
            `[ui][stream][${dbgId}] stalled gap=${gap}ms (targetLen=${streamTargetRef.current.length} shownLen=${streamShownRef.current.length})`
          );
        }
      }, 2000);

      try {
        while (true) {
        if (sendActiveSeqRef.current !== reqSeq) {
          try { await reader.cancel(); } catch {}
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);

          if (!line) continue;

          let obj: any = null;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }

          if (obj.type === "delta") {
            const d = String(obj.text || "");
            if (!d) continue;

            streamHasDeltaRef.current = true;
            streamLastDeltaAtRef.current = Date.now();

            // 델타는 버퍼에만 누적하고, 화면 반영은 pacer가 담당
            streamTargetRef.current = stripEndMarkerClient(streamTargetRef.current + d);
            continue;
          }

          if (obj.type === "ping") {
            // keep-alive (Gemini 3 Pro can be silent for a while)
            streamLastPingAtRef.current = Date.now();
            devDebug(`[ui][stream][${dbgId}] ping recv`);
            continue;
          }

          if (obj.type === "done") {
            if (sendActiveSeqRef.current !== reqSeq) {
              return;
            }
            // 스트리밍 종료: 남은 버퍼를 즉시 flush하고 맨 아래로 이동
            stopStreamPacer({ flush: true });
            // 완료 시 자동 스크롤 금지(읽던 위치 유지)
            // scrollToBottomForce();
            nearBottomRef.current = false;

            realUser = obj.user || null;
            realAssistant = obj.assistant || null;
            const doneUsage = (obj as any)?.usage ?? null;

            setMessages((prev) => {
              return prev.map((m) => {
                if (m.id === tempUserId && realUser) return realUser;
                if (m.id === tempAssistantId && realAssistant) {
	                    const buffered0 = stripEndMarkerClient(String(streamTargetRef.current || ""));
	                    const fromServer0 = stripEndMarkerClient(String(realAssistant.content || ""));

	                    // Meta fence labels may be defined by the creator preset (INFO/STATUS/other).
	                    // Server echoes the derived label list in done.usage.metaFenceLabels.
	                    const _normMetaLabels = (labels: any): string[] => {
	                      if (!Array.isArray(labels)) return [];
	                      const set = new Set<string>();
	                      for (const x of labels) {
	                        const v = String(x ?? "").trim();
	                        if (!v) continue;
	                        set.add(v.toUpperCase());
	                      }
	                      return Array.from(set);
	                    };
	                    const metaLabels = _normMetaLabels((doneUsage as any)?.metaFenceLabels);
	                    const metaAllowed = metaLabels.length ? metaLabels : [];

	                    const buffered = buffered0;
	                    const fromServer = fromServer0;

	                    	                    // Trailing meta fences can have arbitrary labels (INFO/STATUS/custom).
	                    // If the server didn't provide a label list, treat ANY trailing fenced block as meta.
	                    const _splitForMeta = (s: string) => splitTrailingMetaFenceBlocksAtEndClient(s, metaAllowed);

	                  // (fidelity) 스트림(delta)로 이미 보여준 내용이 done에서 "삭제"(축소)되면 안 됩니다.
	                  // - 해결: buffered(스트림 누적)와 fromServer(done 최종) 간 차이가 있어도, append-only로 병합합니다.
	                  let picked = mergeStreamFinalContent({ buffered, fromServer, metaLabels }).content;
	                  let pickedSource: "server" | "buffered" | "merged" =
	                    picked === buffered ? "buffered" : picked === fromServer ? "server" : "merged";

	                  // Ensure trailing meta fences from the server survive even if merging failed to keep them.
	                  const _hasMetaFence = (s: string) => Boolean(_splitForMeta(s).meta.trim());
	                  if (_hasMetaFence(fromServer) && !_hasMetaFence(picked)) {
	                    const meta = _splitForMeta(fromServer).meta.trimEnd();
	                    if (meta) {
	                      picked = String(picked || "").replace(/\s*$/g, "") + `\n\n${meta}\n`;
	                      pickedSource = "merged";
	                    }
	                  }

		                  const _targetChars =
		                    typeof doneUsage?.outputTargetChars === "number" && Number.isFinite(doneUsage.outputTargetChars)
		                      ? Math.max(200, Math.floor(doneUsage.outputTargetChars))
                      : typeof settings?.maxOutputTokens === "number"
                        ? settings?.maxOutputTokens
                        : 1300;

	                  // done 시에는 스트림로 이미 출력된 문자를 다시 자르면 안 된다.
	                  // - 현상: 오프펜스(메타 펜스)가 스트림 중엔 보였다가 done에서 없어짐(삭제) -> 토큰 낭비.
	                  // - 이유: target+300 상한이 server 출력 전체(본문+tailBudget)보다 작아서 done 후처리에서 잘려버림.
	                  // 그래서 done에서는 "출력된 길이 이하로 절대 줄이지 않게" 상한을 잡는다.
		                  const promptMaxCharsRaw =
		                    (doneUsage as any)?.promptMaxChars ?? (doneUsage as any)?.promptMax ?? (doneUsage as any)?.maxChars ?? null;
// (fidelity) Do not reorder or truncate assistant output on the client.
                  // (fidelity) No client-side truncation.
// (디버그용) 본문/메타 길이 분리(STATUS/INFO 펜스는 메타로 본다)
                                    const { body: _bodyLog, meta: _metaLog } = _splitForMeta(picked);

	                  devDebug(
	                    `[ui][done] pickedSource=${pickedSource} targetChars=${_targetChars} bodyChars=${_bodyLog.length} metaChars=${_metaLog.length} totalChars=${picked.length} promptMaxChars=${promptMaxCharsRaw ?? "?"} (bufferedLen=${buffered.length}, serverLen=${fromServer.length})`
	                  );

// 추천 생성은 이 텍스트를 1순위로 사용(메타/잡음 제거본)
                    lastAssistantForSuggestRef.current = cleanTextForSuggest(picked);
                    const sb = buildSuggestBundle(picked);
                    lastAssistantSuggestSummaryRef.current = sb.brief;
                    lastAssistantLastNpcLineRef.current = sb.lastNpcLine;
                    return {
                      ...realAssistant,
                      content: picked,
                      // (토큰/비용) done 패킷에 usage가 있으면 즉시 주입해 "계산중"을 방지
                      // - 없으면 기존/서버값을 유지하고, 이후 history hydration으로 보강
                      usage: doneUsage ?? (realAssistant as any).usage ?? (m as any).usage ?? null,
                    };
                }
                return m;
              });
            });

			// (가독성 우선) 출력 완료 후 자동으로 맨 아래로 강제 이동하지 않는다.
			// requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottomForce()));

            // usage/cost 메타데이터는 서버 DB에 저장되므로, done 이후 history에서 한번 더 하이드레이션
            if (realAssistant?.id) hydrateUsageForMessage(realAssistant.id);

            // (memory refresh) 스트리밍 경로에서도 별도 refresh를 fire-and-forget로 트리거한다.
            // server가 내려준 memoryRefresh 신호가 있으면 refresh를 호출한다.
            triggerMemoryRefresh((obj as any)?.memoryRefresh);
            if (realAssistant?.id) triggerCharacterMemoryRefresh(realAssistant.id);

	            // FriendFee: refresh balance once after the send is fully done.
	            // (AuthControls avoids server fetch on every update event.)
	            refreshFriendFeeStateOnce().catch(() => {});
            // 서버 스트리밍 응답에는 suggestions를 넣지 않음(별도 /api/chat/suggest 호출 흐름 유지)
            break;
          }

          if (obj.type === "error") {
            throw new Error(String(obj.error || "Streaming error"));
          }
        }
      }

      } finally {
        window.clearInterval(stallTimer);
      }

      if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
      if (sendActiveSeqRef.current === reqSeq) setBusy(false);
      return;
    }

    // ---- JSON fallback ----
    let json: any = null;
    try {
      json = await safeJson(res);
    } catch {
      const textBody = await res.text().catch(() => "");
      throw new Error(textBody || `Request failed (${res.status})`);
    }

    if (!res.ok) throw new Error(json?.error || "Request failed");

    const userMsg: Msg = json.user;
    const assistantMsg: Msg = json.assistant;

    if (sendActiveSeqRef.current !== reqSeq) return;

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === tempUserId) return userMsg;
        if (m.id === tempAssistantId) return assistantMsg;
        return m;
      })
    );

    // 완료 시 자동 스크롤 금지(읽던 위치 유지)
    // scrollToBottomForce();
    nearBottomRef.current = false;

    // 추천은 자동으로 생성/표시하지 않는다.
    // (사용자가 버튼을 눌렀을 때만 /api/chat/suggest를 호출해 표시)
    setSuggestions([]);

    // FriendFee: refresh balance once after the send is fully done.
    refreshFriendFeeStateOnce().catch(() => {});

    // (memory refresh) send는 읽기만 하고, 요약/스토리메모리 갱신은 별도 엔드포인트에서 수행한다.
    // - send 응답을 절대 기다리게 하지 않기 위해 fire-and-forget (await 금지)
    triggerMemoryRefresh((json as any)?.memoryRefresh);
    if (assistantMsg?.id) triggerCharacterMemoryRefresh(assistantMsg.id);
    if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
    if (sendActiveSeqRef.current === reqSeq) setBusy(false);
  } catch (err: any) {
    const isAbort = abortCtl?.signal?.aborted || err?.name === "AbortError";
    if (isAbort) {
      if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
      return;
    }

    if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
    if (sendActiveSeqRef.current === reqSeq) setBusy(false);

    // 스트림이 중간에 끊겨도(타임아웃/네트워크) 이미 출력된 내용은 유지한다.
    try {
      stopStreamPacer({ flush: true });
    } catch {}

    const partial = stripEndMarkerClient(streamShownRef.current || streamTargetRef.current || "");
    const partialBody = splitTrailingMetaFenceBlocksAtEndClient(partial, []).body;
    const cleanedPartial = cleanTextForSuggest(partialBody);
    const hasRenderablePartial = /[A-Za-z0-9가-힣]/.test(cleanedPartial);
    if (hasRenderablePartial) {
      devError(`[ui][stream] aborted-but-keep-partial`, err);
      setMessages((prev) =>
        prev.map((m) => (m.id === tempAssistantId ? { ...m, content: partial } : m))
      );
    } else {
      // temp 메시지 제거(기존 동작 유지)
      setMessages((prev) => prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId));
    }

    setSendError(err?.message || "요청 처리 중 오류가 발생했습니다.");
    alert(`요청 처리 중 오류가 발생했습니다.\n${err?.message ? `(${err.message})` : ""}`);
  } finally {
    stopStreamPacer();

    // 리셋(기존 동작 유지)
    setSelectedMsgIdForRegenerate(null);
    setSelectedMsgIdForRewrite(null);

    // (요구사항) 답변이 모두 출력되면 입력창으로 포커스를 복귀
    // - rAF로 한 번 미뤄 렌더 완료 후 포커스
    try {
      if (!editingAssistantId && !profileModalOpen ) {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } catch {}
  }
}

  // 삭제(브라우저 confirm 대신 UI 팝업으로 톤 통일)
  async function onDeleteMessageConfirmed(messageId: string, pairedUserId?: string) {
    if (!chatId) return;
    const id = String(messageId || "").trim();
    if (!id) return;

    // 모델 생성 중 삭제를 누르면 즉시 중단 후 삭제를 진행한다.
    cancelInFlightSend("delete-message");

    try {
      // 서버는 "한 문단" 삭제 규칙(assistant<->user)을 내부에서 처리한다.
      // UI는 1회만 DELETE를 호출하고, 응답의 deleted[]로 로컬 상태를 동기화한다.
      const res = await fetch(`/api/chat/message?messageId=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "삭제 실패");

      const fromServer = Array.isArray(json?.deleted) ? json.deleted.map((x: any) => String(x)).filter(Boolean) : [];
      const fallbackLocal = Array.from(
        new Set([id, String(pairedUserId || "").trim()].filter(Boolean))
      );
      // temp 메시지 등으로 서버 deleted[]가 비어도, 사용자가 누른 항목은 로컬에서 즉시 반영한다.
      const deletedIds: string[] = fromServer.length > 0 ? fromServer : fallbackLocal;
      setMessages((prev) => prev.filter((m) => !deletedIds.includes(m.id)));
    } catch (e: any) {
      alert(e?.message || "오류");
    }
  }

  // UI에서 메시지 객체를 넘기는 형태를 유지하기 위한 래퍼
  function requestDeleteMessage(m: Msg) {
    if (!m?.id) return;
    // 요구사항: '휴지통(삭제)'은 한 문단 단위(사용자 입력 + 그에 대한 AI 답변)를 같이 지운다.
    // - assistant를 지우면, 바로 직전 user가 있으면 함께 삭제
    let pairedUserId: string | undefined;
    if (isAssistantLikeRole(m.role)) {
      const idx = messages.findIndex((x) => x.id === m.id);
      if (idx > 0) {
        const prev = messages[idx - 1];
        if (prev?.role === "user" && prev?.id) pairedUserId = prev.id;
      }
    }
    setDeletePopup({ open: true, messageId: m.id, pairedUserId });
  }


  function startEditLastAssistant() {
    if (!lastAssistantId) return;
    const target = messages.find((m) => m.id === lastAssistantId && isAssistantLikeRole(m.role));
    if (!target) return;
    setEditingAssistantId(target.id);
    setAssistantDraft(target.content);
  }

  // (버그픽스) 버튼 onClick이 startAssistantEdit를 호출하고 있는데,
  // 리팩터링 과정에서 startEditLastAssistant로 이름이 바뀌며 참조가 끊긴 상태였다.
  // 요구사항: "최근 AI 답변 1개만" 수정 가능해야 하므로, 마지막 assistant만 열리도록 보장한다.
  function startAssistantEdit(messageOrId: any) {
    const id = String((typeof messageOrId === "string" ? messageOrId : messageOrId?.id) || "").trim();
    if (!id) return;
    // 안전장치: 마지막 assistant가 아니면 무시
    if (!lastAssistantId || id !== lastAssistantId) return;
    startEditLastAssistant();
  }

  function startUserEdit(m: Msg) {
    if (!m?.id) return;
    if (editingAssistantId) return;
    setEditingUserId(m.id);
    setUserDraft(m.content || "");
  }

  function cancelUserEdit() {
    setEditingUserId("");
    setUserDraft("");
  }

  async function saveUserEdit() {
    if (!chatId) return;
    if (!editingUserId) return;
    const content = String(userDraft || "").trim();
    if (!content) return alert("내용이 비어있습니다.");

    setBusy(true);
    try {
      // 1) 유저 메시지 DB/로컬 수정
      const res = await fetch(`/api/chat/message`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: editingUserId, content }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "수정 실패");

      setMessages((prev) => prev.map((m) => (m.id === editingUserId ? { ...m, content } : m)));

      // 2) 해당 유저 메시지 다음의 첫 assistant가 있으면 그 assistant를 재생성
      const idx = messages.findIndex((m) => m.id === editingUserId);
      const nextAssistant = idx >= 0 ? messages.slice(idx + 1).find((m) => isAssistantLikeRole(m.role)) : null;
      cancelUserEdit();
      if (nextAssistant?.id) {
        await onRegenerate(nextAssistant.id);
      }
    } catch (e: any) {
      showToast("수정 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function cancelAssistantEdit() {
    setEditingAssistantId("");
    setAssistantDraft("");
  }

  async function saveAssistantEdit() {
    if (!chatId) return;
    if (!editingAssistantId) return;
    const content = String(assistantDraft || "").trim();
    if (!content) return alert("내용이 비어있습니다.");

    setBusy(true);
    try {
      const res = await fetch(`/api/chat/message`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: editingAssistantId, content }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || "수정 실패");

      setMessages((prev) => prev.map((m) => (m.id === editingAssistantId ? { ...m, content } : m)));
      cancelAssistantEdit();
    } catch (e: any) {
      showToast("수정 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      setBusy(false);
    }
  }

  async function onRegenerate(assistantMessageId: string) {
    let reqSeq = 0;
    let abortCtl: AbortController | null = null;
    if (!chatId) return;
    // If a generation is already running, abort it first.
    cancelInFlightSend("regenerate");
    // assistant 바로 이전의 user 메시지를 찾아서 그 입력으로 재생성
    const idx = messages.findIndex((m) => m.id === assistantMessageId);
    if (idx <= 0) return alert("재생성할 기준 메시지를 찾지 못했습니다.");
    const prevUser = [...messages].slice(0, idx).reverse().find((m) => m.role === "user");
    if (!prevUser) return alert("직전 유저 메시지를 찾지 못했습니다.");

    setBusy(true);
    setSendError(null);

    // 재생성은 "덮어쓰기 A" (해당 assistant 메시지를 스트리밍으로 교체)
    setSuggestions([]);
    setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? { ...m, content: "" } : m)));

    // 사용자가 버튼을 눌렀을 때는 즉시 화면 하단으로(완료 시 자동 스크롤은 금지)
    nearBottomRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottomForce()));

    startStreamPacer(assistantMessageId);
    streamLastPingAtRef.current = Date.now();

    try {
      const personaOverride = {
        personaName: (settings?.personaName || selectedProfile?.personaName || "").trim(),
        personaAge: Number(settings?.personaAge || selectedProfile?.personaAge || 0),
        personaGender: String(settings?.personaGender || selectedProfile?.personaGender || "").trim(),
        personaInfo: String(settings?.personaInfo || selectedProfile?.personaInfo || "").trim(),
      };

      const payload = {
        chatId,
        userText: String(prevUser.content || "").trim(),
        personaOverride,
        runtime: {
          model: settings?.model,
          maxOutputTokens: settings?.maxOutputTokens,
          maxReasoningTokens: settings?.maxReasoningTokens,
          keepUserTurns: settings?.memoryFrom,
          perTurnChars: settings?.summaryLength,
        },
        regenerate: true,
        userMessageId: prevUser.id,
        replaceAssistantId: assistantMessageId,
        includeSuggestions: false,
        stream: false,
      };

      const dbgId = `regen-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      devDebug(`[ui][regen][${dbgId}] POST /api/chat/send`, payload);

      reqSeq = bumpSendSeq();
      abortCtl = new AbortController();
      sendAbortRef.current = abortCtl;

      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortCtl!.signal,
        body: JSON.stringify(payload),
      });

      const ct = (res.headers.get("content-type") || "").toLowerCase();

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        devError(`[ui][regen][${dbgId}] non-OK response`, errText);
        throw new Error(errText || `HTTP ${res.status}`);
      }

      // ---- NDJSON streaming ----
      if (ct.includes("application/x-ndjson")) {
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream body");

        const dec = new TextDecoder();
        let buf = "";
        let realAssistant: Msg | null = null;

        // stream stall diagnostics
        const STALL_WARN_MS = 15000;
        let lastStallWarnAt = 0;
        const stallTimer = window.setInterval(() => {
          const last = streamLastDeltaAtRef.current;
          if (!last) return;
          const now = Date.now();
          const idle = now - last;
          if (idle >= STALL_WARN_MS && now - lastStallWarnAt >= STALL_WARN_MS) {
            lastStallWarnAt = now;
            devWarn(`[ui][regen][${dbgId}] stream idle ${idle}ms`);
            setStallUiActive(true);
          }
        }, 1500);

        try {
          while (true) {
        if (sendActiveSeqRef.current !== reqSeq) {
          try { await reader.cancel(); } catch {}
          return;
        }
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            buf += dec.decode(value, { stream: true });

            // NDJSON: 한 줄씩 처리
            while (true) {
              const nl = buf.indexOf("\n");
              if (nl < 0) break;
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;

              let obj: any;
              try {
                obj = JSON.parse(line);
              } catch {
                continue;
              }

              if (obj.type === "delta") {
                const d = String(obj.text || "");
                if (!d) continue;

                streamHasDeltaRef.current = true;
                streamLastDeltaAtRef.current = Date.now();

                // 델타는 버퍼에만 누적하고, 화면 반영은 pacer가 담당
                streamTargetRef.current = stripEndMarkerClient(streamTargetRef.current + d);
                continue;
              }

              if (obj.type === "ping") {
                streamLastPingAtRef.current = Date.now();
                continue;
              }

              if (obj.type === "done") {
            if (sendActiveSeqRef.current !== reqSeq) {
              return;
            }
                stopStreamPacer({ flush: true });
                nearBottomRef.current = false;

                realAssistant = obj.assistant || null;

                // 서버가 assistant를 내려주면, 스트림 버퍼 vs 서버 텍스트 중 더 긴 쪽을 최종 채택(덮어쓰기 A)
                if (realAssistant?.id) {
                  clearFriendFeeBilledMark(realAssistant.id);
	                  const buffered = stripEndMarkerClient(String(streamTargetRef.current || ""));
	                  const fromServer = stripEndMarkerClient(String(realAssistant.content || ""));

                    const picked = mergeStreamFinalContent({
                      buffered,
                      fromServer,
                      metaLabels: (obj as any)?.usage?.metaFenceLabels,
                    }).content;
// (fidelity) Do not reorder or truncate assistant output on the client.
                  // (fidelity) No client-side truncation.
setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMessageId
                        ? {
                            // Msg 타입 보장(필수 필드 유지) + 내용/usage만 덮어쓰기
                            ...m,
                            content: picked,
                            usage: (obj as any)?.usage ?? (realAssistant as any)?.usage ?? (m as any)?.usage,
                          }
                        : m
                    )
                  );
                  // usage/cost 메타데이터는 서버 DB에 저장되므로, done 이후 history에서 한번 더 하이드레이션
                  hydrateUsageForMessage(realAssistant.id);
                  triggerCharacterMemoryRefresh(realAssistant.id);
                }
                break;
              }

              if (obj.type === "error") {
                throw new Error(String(obj.error || "Streaming error"));
              }
            }
          }
        } finally {
          window.clearInterval(stallTimer);
        }

        return;
      }

      // ---- JSON fallback ----
      const json = await safeJson(res);
      if (!res.ok) {
        const base = String(json?.error || "재생성 실패");
        const detail = String(json?.detail || "").trim();
        throw new Error(detail ? `${base}\n(${detail})` : base);
      }
      if (json?.assistant) {
        if (sendActiveSeqRef.current !== reqSeq) return;
        clearFriendFeeBilledMark(String(json.assistant?.id || assistantMessageId));
        setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? json.assistant : m)));
        triggerCharacterMemoryRefresh(String(json.assistant?.id || assistantMessageId));
      }
    } catch (e: any) {
      const isAbort = abortCtl?.signal?.aborted || e?.name === "AbortError";
      if (isAbort) {
        if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
        return;
      }
      // 스트림이 중간에 끊겨도 이미 출력된 내용은 유지한다.
      try {
        stopStreamPacer({ flush: true });
      } catch {}
      showToast("재생성 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
      if (sendActiveSeqRef.current === reqSeq) setBusy(false);
    }
  }


  async function onContinue(assistantMessageId: string) {
    let reqSeq = 0;
    let abortCtl: AbortController | null = null;
    if (!chatId) return;

    cancelInFlightSend("continue");

    const target = messages.find((m) => m.id === assistantMessageId && isAssistantLikeRole(m.role));
    if (!target) return alert("이어쓰기할 답변을 찾지 못했습니다.");

    const baseText = stripEndMarkerClient(String(target.content || "")).trim();
    if (!baseText) return alert("이어쓰기할 본문이 비어 있습니다.");

    setBusy(true);
    setSendError(null);
    setSuggestions([]);
    // JSON 응답 대기 구간(이어쓰기)도 동일하게 "생각 중" 배지를 노출한다.
    setManualThinkingTargetId(assistantMessageId);
    setStallUiActive(true);

    // 사용자가 버튼을 눌렀을 때는 즉시 화면 하단으로(완료 시 자동 스크롤은 금지)
    nearBottomRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottomForce()));

    try {
      const personaOverride = {
        personaName: (settings?.personaName || selectedProfile?.personaName || "").trim(),
        personaAge: Number(settings?.personaAge || selectedProfile?.personaAge || 0),
        personaGender: String(settings?.personaGender || selectedProfile?.personaGender || "").trim(),
        personaInfo: String(settings?.personaInfo || selectedProfile?.personaInfo || "").trim(),
      };

      const tailForGuide = cleanTextForSuggest(baseText).slice(-900);
      const continueInstruction = [
        "직전 답변의 마지막 문장 다음부터 그대로 이어서 작성해줘.",
        "이미 작성한 문장/표현은 반복하지 말고, 이어지는 본문만 출력해.",
        "메타/INFO/STATUS/코드블록은 출력하지 마.",
        "",
        "[직전 출력 끝부분]",
        tailForGuide,
      ].join("\n");

      const payload = {
        chatId,
        userText: continueInstruction,
        personaOverride,
        runtime: {
          model: settings?.model,
          maxOutputTokens: settings?.maxOutputTokens,
          maxReasoningTokens: settings?.maxReasoningTokens,
          keepUserTurns: settings?.memoryFrom,
          perTurnChars: settings?.summaryLength,
        },
        regenerate: true,
        replaceAssistantId: assistantMessageId,
        continueFromAssistantId: assistantMessageId,
        includeSuggestions: false,
        stream: false,
      };

      const dbgId = `continue-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      devDebug(`[ui][continue][${dbgId}] POST /api/chat/send`, payload);

      reqSeq = bumpSendSeq();
      abortCtl = new AbortController();
      sendAbortRef.current = abortCtl;

      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortCtl!.signal,
        body: JSON.stringify(payload),
      });

      const json = await safeJson(res);
      if (!res.ok) {
        const base = String(json?.error || "이어쓰기 실패");
        const detail = String(json?.detail || "").trim();
        throw new Error(detail ? `${base}\n(${detail})` : base);
      }

      if (json?.assistant) {
        if (sendActiveSeqRef.current !== reqSeq) return;
        clearFriendFeeBilledMark(String(json.assistant?.id || assistantMessageId));
        setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? json.assistant : m)));
        hydrateUsageForMessage(String(json.assistant?.id || assistantMessageId)).catch(() => {});
      }

      triggerMemoryRefresh((json as any)?.memoryRefresh);
      triggerCharacterMemoryRefresh(String(json.assistant?.id || assistantMessageId));
      refreshFriendFeeStateOnce().catch(() => {});
    } catch (e: any) {
      const isAbort = abortCtl?.signal?.aborted || e?.name === "AbortError";
      if (isAbort) {
        if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
        return;
      }
      showToast("이어쓰기 실패", (e?.message || "오류"), "error", 3500);
    } finally {
      setStallUiActive(false);
      setManualThinkingTargetId("");
      if (sendAbortRef.current === abortCtl) sendAbortRef.current = null;
      if (sendActiveSeqRef.current === reqSeq) setBusy(false);
    }
  }

  // UI에서 assistant 메시지 객체를 넘기는 형태를 유지하기 위한 래퍼
  function regenerateFromUser(m: Msg) {
    if (!m?.id) return;
    cancelInFlightSend("regenerate-click");
    void onRegenerate(m.id);
  }

  function continueFromAssistant(m: Msg) {
    if (!m?.id) return;
    cancelInFlightSend("continue-click");
    void onContinue(m.id);
  }

  // (성능 핵심) MessageList에 내려보낼 핸들러들을 "영구 stable reference"로 고정한다.
  //
  // 배경:
  // - MessageList / MessageItem 은 React.memo 로 감싸져 있다. props가 같은 reference면 re-render 생략.
  // - 그런데 위 9개 핸들러는 일반 function 선언이라 ChatArea 의 매 re-render마다 새 함수 객체가 만들어진다.
  // - 그 결과 prebufferSec 처럼 매초 변하는 state 하나만으로도 visible 메시지 40개 전부가 다시 검토/렌더된다.
  //   소설 모드의 정규식 파싱 비용이 더해지면 채팅이 길어진 느낌으로 lag가 누적된다.
  //
  // 해결:
  // - latest closure는 매 render 갱신되는 `messageHandlersRef` 에 보관
  // - MessageList에는 ref를 호출만 하는 빈 껍데기 useCallback (deps=[]) 만 넘김 → 영구 stable
  // - 본문 함수는 그대로 두므로 회귀 위험 최소
  const messageHandlersRef = useRef({
    regenerateFromUser,
    continueFromAssistant,
    requestDeleteMessage,
    startAssistantEdit,
    startUserEdit,
    openTokenInfo,
    cancelAssistantEdit,
    saveAssistantEdit,
    cancelUserEdit,
    saveUserEdit,
  });
  // 매 render마다 ref에 최신 closure 주입. 매우 가벼움(10개 대입).
  messageHandlersRef.current.regenerateFromUser = regenerateFromUser;
  messageHandlersRef.current.continueFromAssistant = continueFromAssistant;
  messageHandlersRef.current.requestDeleteMessage = requestDeleteMessage;
  messageHandlersRef.current.startAssistantEdit = startAssistantEdit;
  messageHandlersRef.current.startUserEdit = startUserEdit;
  messageHandlersRef.current.openTokenInfo = openTokenInfo;
  messageHandlersRef.current.cancelAssistantEdit = cancelAssistantEdit;
  messageHandlersRef.current.saveAssistantEdit = saveAssistantEdit;
  messageHandlersRef.current.cancelUserEdit = cancelUserEdit;
  messageHandlersRef.current.saveUserEdit = saveUserEdit;

  // 영구 stable wrapper들 — deps=[] 이라 reference가 절대 안 바뀐다.
  const stableRegenerateFromAssistant = useCallback(
    (m: Msg) => messageHandlersRef.current.regenerateFromUser(m),
    []
  );
  const stableContinueFromAssistant = useCallback(
    (m: Msg) => messageHandlersRef.current.continueFromAssistant(m),
    []
  );
  const stableRequestDeleteMessage = useCallback(
    (m: Msg) => messageHandlersRef.current.requestDeleteMessage(m),
    []
  );
  const stableStartAssistantEdit = useCallback(
    (m: Msg) => messageHandlersRef.current.startAssistantEdit(m),
    []
  );
  const stableStartUserEdit = useCallback(
    (m: Msg) => messageHandlersRef.current.startUserEdit(m),
    []
  );
  const stableOpenTokenInfo = useCallback(
    (m: Msg, el?: HTMLElement | null) => messageHandlersRef.current.openTokenInfo(m, el),
    []
  );
  const stableCancelAssistantEdit = useCallback(
    () => messageHandlersRef.current.cancelAssistantEdit(),
    []
  );
  const stableSaveAssistantEdit = useCallback(
    () => messageHandlersRef.current.saveAssistantEdit(),
    []
  );
  const stableCancelUserEdit = useCallback(
    () => messageHandlersRef.current.cancelUserEdit(),
    []
  );
  const stableSaveUserEdit = useCallback(
    () => messageHandlersRef.current.saveUserEdit(),
    []
  );

  // inline arrow `() => resetWindowToTail(true)` 대신 안정 reference 사용.
  const stableResetWindowToTail = useCallback(
    () => resetWindowToTail(true),
    [resetWindowToTail]
  );

  // chatId 바뀌면: 히스토리 + 설정 로드
  useEffect(() => {
    if (!chatId) return;
    loadHistory(chatId).catch(() => {});
    loadSettings(chatId).catch(() => {});
  }, [chatId]);

  // (요구) 추천답변은 자동 생성하지 않고, 사용자가 버튼을 눌렀을 때만 생성한다.
  const requestSuggestionsOnDemand = useCallback(async () => {
    if (!chatId) return;
    if (suggestLoading) return;
    suggestChatIdRef.current = String(chatId || "");
    const requestChatId = String(chatId || "");
    const reqSeq = suggestReqSeqRef.current + 1;
    suggestReqSeqRef.current = reqSeq;
    const isLatestSuggestReq = () =>
      suggestReqSeqRef.current === reqSeq && suggestChatIdRef.current === requestChatId;

    // 스트리밍/전송 중에는 "방금 출력된 문맥"이 완성되지 않아 엉뚱한 추천이 나올 수 있으므로 차단
    if (busy) {
      showToast("추천답변", "답변 생성이 끝난 뒤에 눌러주세요.", "info", 2400);
      return;
    }

    // 1) 방금 스트리밍으로 완성된 텍스트(ref)가 있으면 1순위로 사용
    //    (단, 채팅 이동/수정 등으로 ref가 stale일 수 있어 아래에서 검증한다.)
    const refAssistantRaw = String(lastAssistantForSuggestRef.current || "").trim();

    // 2) 없으면, 마지막 완성된 assistant 메시지(temporal/temp 제외)
    let lastAssistant: Msg | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as any;
      if (isAssistantLikeRole(m?.role) && !String(m?.id || "").startsWith("temp-")) {
        const c = String(m?.content || "").trim();
        if (c.length > 0) {
          lastAssistant = m as Msg;
          break;
        }
      }
    }

    const lastAssistantText = cleanTextForSuggest(String((lastAssistant as any)?.content || "").trim());
    let refAssistant = cleanTextForSuggest(refAssistantRaw);

    // ref가 있는데, 현재 마지막 assistant와 전혀 다른 텍스트면(=다른 채팅/이전 메시지)
    // ref를 버리고 state 기반으로 만든다.
    if (refAssistant && lastAssistantText) {
      const a = refAssistant;
      const b = lastAssistantText;
      const looksSame = a === b || a.includes(b) || b.includes(a);
      if (!looksSame) refAssistant = "";
    }

    const assistantContent = (refAssistant || lastAssistantText).trim();
    if (!assistantContent) {
      showToast("추천답변", "추천을 만들 수 있는 답변이 아직 없어요.", "info", 2400);
      return;
    }

    // Use a short, stable context for suggestions (generated at output time when possible)
    let assistantSummary = String(lastAssistantSuggestSummaryRef.current || "").trim();
    let lastNpcLine = String(lastAssistantLastNpcLineRef.current || "").trim();
    if (!assistantSummary || !lastNpcLine) {
      const sb = buildSuggestBundle(assistantContent);
      if (!assistantSummary) assistantSummary = sb.brief;
      if (!lastNpcLine) lastNpcLine = sb.lastNpcLine;
    }

    // 직전 user 메시지 (ref 우선)
    let userContent = String(lastUserForSuggestRef.current || "").trim();
    if (!userContent) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (m?.role === "user" && !String(m?.id || "").startsWith("temp-")) {
          userContent = String(m?.content || "").trim();
          if (userContent) break;
        }
      }
    }

    const personaOverride = {
      personaName: (settings?.personaName || selectedProfile?.personaName || "").trim(),
      personaAge: Number(settings?.personaAge || selectedProfile?.personaAge || 0),
      personaGender: String(settings?.personaGender || selectedProfile?.personaGender || "").trim(),
      personaInfo: String(settings?.personaInfo || selectedProfile?.personaInfo || "").trim(),
    };

    // 최근 메시지(요약용) - 상태가 살짝 늦어도 ref 텍스트를 주입해서 최신 문맥을 보장
    const recentMessages = (() => {
      const arr = (Array.isArray(messages) ? messages : [])
        .filter((m: any) => m && (m.role === "user" || isAssistantLikeRole(m.role)) && !String(m.id || "").startsWith("temp-"))
        .slice(-18)
        .map((m: any) => ({ role: toPromptRole(m.role), content: String(m.content || "").slice(0, 5000) }));
      if (arr.length > 0) {
        const lastIdx = arr.length - 1;
        if (arr[lastIdx].role === "assistant") {
          arr[lastIdx].content = assistantContent;
        }
      }
      return arr;
    })();

    // 새로 만들 때는 기존 추천을 비우고 로딩 표시
    setSuggestions([]);
    setSuggestLoading(true);

    try {
      const res = await fetch("/api/chat/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          personaOverride,
          assistantContent,
          assistantSummary,
          lastNpcLine,
          userContent,
          recentMessages,
          previousSuggestions: suggestions,
        }),
      });
      const json = await safeJson(res);
      if (!isLatestSuggestReq()) return;
      if (!res.ok) throw new Error(json?.error || "추천답변 생성 실패");
      const next = Array.isArray(json?.suggestions) ? json.suggestions : [];
      if (!next || next.length < 2) throw new Error("추천답변이 비어있음");
      setSuggestions(next.slice(0, 2));
    } catch (e: any) {
      if (!isLatestSuggestReq()) return;
      devWarn("[ui][suggest][manual] failed", e);
      // 서버/네트워크 실패 시에도 "대사만" 2개는 보이게 한다.
      setSuggestions([
        "…좋아. 그럼 네가 원하는 게 뭔지 똑바로 말해.",
        "한 번만 더 그 말 해봐. 내가 어디까지 참아야 하지?",
      ]);
      showToast("추천답변 생성 실패", String(e?.message || "오류"), "error", 3000);
    } finally {
      if (isLatestSuggestReq()) setSuggestLoading(false);
    }
  }, [chatId, busy, messages, settings, selectedProfile, safeJson, suggestions, devWarn, suggestLoading]);

const insertNarrationMarkers = useCallback(() => {
    const open = "*";
    const close = "*";
    const el = inputRef.current;

    // textarea ref가 아직 없으면 단순 append
    if (!el) {
      setInput((prev) => String(prev || "") + open + close);
      return;
    }

    const start = typeof el.selectionStart === "number" ? el.selectionStart : input.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : input.length;
    const selected = input.slice(start, end);

    // 선택 영역이 있으면 감싸고, 없으면 **|** 형태로 삽입
    const next = input.slice(0, start) + open + selected + close + input.slice(end);
    setInput(next);

    requestAnimationFrame(() => {
      try {
        el.focus();
        // 커서를 마커 사이로
        const caret = start + open.length;
        el.setSelectionRange(caret, caret + (selected ? selected.length : 0));
      } catch {}
    });
  }, [input]);


  useEffect(() => {
    scrollToBottomIfAllowed();
  }, [messages.length, scrollToBottomIfAllowed]);

  // (버그픽스) assistant 메시지 내부 지문이 길어지며 DOM 높이가 변해도
  // messages.length가 변하지 않으면 스크롤이 따라가지 못한다.
  // ResizeObserver로 content height 변화를 감지해, 사용자가 바닥을 보고 있을 때만 자동 스크롤한다.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    // 초기값 계산
    updateNearBottom();

    const ro = new ResizeObserver(() => {
      // content 높이 변화(스트리밍/이미지 로드/줄바꿈)로 scrollTop clamp가 튈 수 있어
      // 짧은 시간 동안 사용자 스크롤로 오인하지 않게 한다.
      markIgnoreUserScroll(200);
      // coalesced auto-scroll (안정화 로직은 scheduleAutoScrollToBottom 내부에서 처리)
      scheduleAutoScrollToBottom(false);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [updateNearBottom, scheduleAutoScrollToBottom]);

  // 프리셋 변경되면: 채팅 컨텍스트 초기화(고정 문제 방지)
  useEffect(() => {
    let cancelled = false;
    if (forceNewChatIntentRef.current && forceNewChatIntentRef.current !== presetId) {
      forceNewChatIntentRef.current = "";
      forceNewChatStartedRef.current = "";
    }
    if (forceOpenChatIntentRef.current?.presetId !== presetId) {
      forceOpenChatIntentRef.current = null;
      forceOpenChatAppliedRef.current = "";
    }
    // 프리셋 바뀌면: 해당 프리셋의 최근 채팅을 자동으로 불러오고(이어하기),
    // 없으면 새로 만들기 상태로 둔다.
    setMessages([]);

    oldestCreatedAtRef.current = null;

    setHasMoreOlder(false);
    // 고정 windowing: 프리셋 변경 시에도 항상 tail window로 리셋
    pinnedToBottomRef.current = true;
    setWindowStart(0);
    setSettings(null);
    setInput("");
    setSuggestions([]);
    
    if (!presetId) {
      setChatId("");
      setChatList([]);
      return;
    }

    loadChatList(presetId).catch(() => {});

    (async () => {
      try {
        // 작품 탭에서 "새 대화 시작"을 눌러 들어온 경우: 강제 새 채팅
        if (consumeForceNewChatFlag(presetId)) {
          // Strict Mode의 두 번째 effect는 첫 요청이 끝날 때까지 /latest로 빠지지 않고 대기한다.
          if (forceNewChatStartedRef.current === presetId) return;
          forceNewChatStartedRef.current = presetId;
          setChatId("");
          // createChat() 내부에서 presetId 확인
          await createChat(true);
          return;
        }
        const forcedChatId = consumeForceOpenChatId(presetId);
        if (forcedChatId) {
          const forcedKey = `${presetId}:${forcedChatId}`;
          if (forceOpenChatAppliedRef.current === forcedKey) return;
          forceOpenChatAppliedRef.current = forcedKey;
          setChatId(forcedChatId);
          return;
        }
        const res = await fetch(`/api/chat/latest?presetId=${encodeURIComponent(presetId)}`);
        const json = await safeJson(res);
        if (!res.ok) throw new Error(json?.error || "최근 채팅 조회 실패");
        if (cancelled) return;
        if (json?.chat) {
          setChatId(json.chat.id);
        } else {
          setChatId("");
        }
      } catch {
        if (cancelled) return;
        setChatId("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [presetId, consumeForceNewChatFlag, consumeForceOpenChatId]);

  const rootViewportHeight = isMobile && viewportHeightPx > 0 ? `${viewportHeightPx}px` : "100dvh";
  const inputBarBottomPx = isMobile ? Math.max(0, keyboardInsetPx) : 0;
  const mobileBottomInset = bottomInset + (isMobile ? Math.max(0, keyboardInsetPx) : 0);
  const thinkingTargetId = manualThinkingTargetId || streamTempAssistantIdRef.current;

  return (
    <div
      style={{
        display: isMemoryDock ? "grid" : settingsUiMode === "drawer" ? "block" : "grid",
        // 장기기억 도킹은 우측 패널을 충분히 넓게 잡고, 채팅 영역/입력창과 겹치지 않게 한다.
        // (환경에 따라 settingsUiMode가 drawer가 아니어도 도킹이 켜지므로 폭은 확실히 확보)
        gridTemplateColumns: isRelationshipFocus
          ? "minmax(0, 1fr)"
          : isMemoryDock
          ? "minmax(360px, 1fr) minmax(520px, 1040px)"
          : (settingsUiMode === "drawer" ? "1fr" : (effectiveSettingsOpen ? "360px 1fr" : "0px 1fr")),
        gap: isRelationshipFocus ? 0 : isMemoryDock ? 16 : (settingsUiMode === "drawer" ? 0 : 16),
        height: rootViewportHeight,
        minHeight: rootViewportHeight,
        minWidth: 0,
        gridTemplateRows: "minmax(0, 1fr)",
        paddingTop: isMobile ? 8 : 56,
        boxSizing: "border-box",
        overflow: "hidden",
        transition: "grid-template-columns 180ms ease",
        background: CHAT_THEME.bg,
        color: CHAT_THEME.text,
      }}
>
  {settingsUiMode === "drawer" && effectiveSettingsOpen && !isMemoryDock ? (
    <div
      onClick={() => setUiSettingsOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 70,
      }}
    />
  ) : null}

  {toast ? (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 14,
        right: 14,
        zIndex: 9999,
        maxWidth: 360,
      }}
    >
      <div
        style={{
          background: "rgba(20, 20, 22, 0.88)",
          border: `1px solid ${CHAT_THEME.borderStrong}`,
          boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
          backdropFilter: "blur(10px)",
          borderRadius: 14,
          padding: "12px 12px",
          color: CHAT_THEME.text,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              marginTop: 6,
              background:
                toast.variant === "success"
                  ? "rgba(115, 255, 165, 0.85)"
                  : toast.variant === "error"
                    ? "rgba(255, 120, 120, 0.9)"
                    : "rgba(140, 180, 255, 0.85)",
            }}
          />
          <div style={{ flex: 1 }}
          >
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: toast.message ? 4 : 0 }}
            >
              {toast.title}
            </div>
            {toast.message ? (
              <div style={{ fontSize: 12, opacity: 0.86, lineHeight: 1.4, whiteSpace: "pre-wrap" }}
              >
                {toast.message}
              </div>
            ) : null}
          </div>
          <button
            onClick={() => {
              try {
                if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              } catch {}
              toastTimerRef.current = null;
              setToast(null);
            }}
            title="닫기"
            style={{
              border: `1px solid ${CHAT_THEME.borderStrong}`,
              background: "rgba(255,255,255,0.06)",
              color: CHAT_THEME.text,
              borderRadius: 999,
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  ) : null}
  {/* LEFT settings (접기/펼치기) */}

      <div
        style={{
          position: isMemoryDock ? ("relative" as const) : settingsUiMode === "drawer" ? ("fixed" as const) : ("relative" as const),
          gridColumn: isRelationshipFocus ? 1 : isMemoryDock ? 2 : undefined,
          top: isMemoryDock ? undefined : settingsUiMode === "drawer" ? 64 : undefined,
          right: isMemoryDock ? undefined : settingsUiMode === "drawer" ? 12 : undefined,
          bottom: isMemoryDock ? undefined : settingsUiMode === "drawer" ? 12 : undefined,
          width: isMemoryDock ? undefined : settingsUiMode === "drawer" ? 360 : undefined,
          maxWidth: isMemoryDock ? undefined : settingsUiMode === "drawer" ? "calc(100vw - 24px)" : undefined,
          zIndex: settingsUiMode === "drawer" && !isMemoryDock ? 80 : undefined,
          // 도킹 모드에서는 상단바(56px)를 제외한 전체 높이를 사용해 "작은 창"처럼 보이지 않도록 한다.
          height: isMemoryDock ? "calc(100dvh - 56px)" : undefined,
          maxHeight: isMemoryDock ? "calc(100dvh - 56px)" : undefined,
          boxSizing: "border-box",

          border: effectiveSettingsOpen ? `1px solid ${CHAT_THEME.borderStrong}` : "1px solid transparent",
          borderRadius: 16,
          padding: effectiveSettingsOpen
            ? isRelationshipFocus
              ? "14px 20px 24px"
              : isMemoryDock
                ? "12px 12px 18px"
                : 14
            : 0,
          overflow: effectiveSettingsOpen ? "auto" : "hidden",
          overscrollBehavior: "contain" as any,
          scrollbarGutter: "stable" as any,
          opacity: effectiveSettingsOpen ? 1 : 0,
          transform: effectiveSettingsOpen
            ? "translateX(0)"
            : settingsUiMode === "drawer"
              ? "translateX(10px)"
              : "translateX(-8px)",
          transition: "opacity 160ms ease, transform 160ms ease, padding 160ms ease",
          pointerEvents: effectiveSettingsOpen ? ("auto" as const) : ("none" as const),
          background: isMemoryDock ? CHAT_THEME.panel : (settingsUiMode === "drawer" ? "var(--app-bg)" : "transparent"),
          boxShadow: settingsUiMode === "drawer" ? "0 10px 30px rgba(0,0,0,0.45)" : "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {settingsUiMode === "drawer" && settingsView !== "home" ? (
              <button
                type="button"
                onClick={() => setSettingsView("home")}
                title="뒤로"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 12,
                  border: "none",
                  background: CHAT_THEME.iconBg,
                  color: CHAT_THEME.text,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <SettingsIcon name="chevronLeft" />
              </button>
            ) : null}

            <div style={{ fontSize: 16, fontWeight: 900 }}>
              {settingsView === "home"
                ? "설정"
                : settingsView === "persona"
                  ? "페르소나 설정"
                  : settingsView === "userNote"
                    ? "유저 노트"
                    : settingsView === "room"
                      ? "채팅방 설정"
                      : settingsView === "relations"
                        ? "관계도"
                        : settingsView === "memory"
                          ? "장기기억"
                          : "출력/추론"}
            </div>
          </div>

          {settingsUiMode === "drawer" ? (
            <button
              type="button"
              onClick={() => setUiSettingsOpen(false)}
              title="닫기"
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                border: "none",
                background: CHAT_THEME.iconBg,
                color: CHAT_THEME.text,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 900,
              }}
            >
              ✕
            </button>
          ) : null}
        </div>

        {settingsView === "home" ? (
          <div style={{}}>
            {/* 채팅방 이름(수정 가능) */}
            <div style={{ marginBottom: 10 }}>
              {!editingChatTitle ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 900,
                        lineHeight: 1.2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={effectiveChatTitle}
                    >
                      {effectiveChatTitle}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>채팅창 이름</div>
                  </div>
                  <button
                    type="button"
                    onClick={beginEditChatTitle}
                    title="이름 수정"
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 12,
                      border: "none",
                      background: CHAT_THEME.iconBg,
                      color: CHAT_THEME.text,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <SettingsIcon name="pencil" />
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    ref={chatTitleInputRef}
                    value={chatTitleDraft}
                    onChange={(e) => setChatTitleDraft(e.target.value)}
                    placeholder="채팅 이름"
                    style={{
                      flex: 1,
                      padding: 10,
                      borderRadius: 12,
                      border: "none",
                      background: CHAT_THEME.bg,
                      color: CHAT_THEME.text,
                      fontSize: 13,
                    }}
                  />
                  <button
                    type="button"
                    onClick={cancelEditChatTitle}
                    title="취소"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      border: "none",
                      background: CHAT_THEME.iconBg,
                      color: CHAT_THEME.text,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="close" />
                  </button>
                  <button
                    type="button"
                    onClick={saveEditChatTitle}
                    title="저장"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      border: `1px solid ${CHAT_THEME.borderStrong}`,
                      background: CHAT_THEME.bg2,
                      color: "#fff",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="check" />
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={() => createChat(true)}
              disabled={busy || !presetId}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 12,
                border: "none",
                background: busy ? "rgba(255,255,255,0.06)" : CHAT_THEME.bg2,
                color: busy ? "rgba(229,231,235,0.45)" : "#fff",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              새 대화 시작
            </button>

            <div style={{ height: 12 }} />

            {/* 설정 메뉴 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {(
                [
                  { k: "persona", label: "페르소나 설정", icon: "persona", sub: "주인공" },
                  { k: "userNote", label: "유저 노트", icon: "note", sub: "메모" },
                  { k: "memory", label: "장기기억", icon: "memory", sub: "인물/저장" },
                  { k: "relations", label: "관계도", icon: "relations", sub: "관계·호감도" },
                  { k: "model", label: "출력/추론", icon: "sliders", sub: "옵션" },
                ] as const
              ).map((it) => (
                <button
                  key={it.k}
                  type="button"
                  disabled={!settings}
                  onClick={() => setSettingsView(it.k as any)}
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border: "none",
                    background: CHAT_THEME.panel,
                    color: CHAT_THEME.text,
                    cursor: !settings ? "not-allowed" : "pointer",
                    opacity: !settings ? 0.5 : 1,
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    textAlign: "left",
                  }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 12,
                      border: "none",
                      background: CHAT_THEME.iconBg,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "0 0 auto",
                    }}
                  >
                    <SettingsIcon name={it.icon as any} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 900, lineHeight: 1.2 }}>{it.label}</div>
                    <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{it.sub}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* 채팅방 설정 (장기기억 아래) */}
            <div style={{ height: 14 }} />
            <button
              type="button"
              disabled={!settings}
              onClick={() => setSettingsView("room")}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 14,
                border: "none",
                background: CHAT_THEME.panel,
                color: CHAT_THEME.text,
                cursor: !settings ? "not-allowed" : "pointer",
                opacity: !settings ? 0.5 : 1,
                display: "flex",
                gap: 10,
                alignItems: "center",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 12,
                  border: "none",
                  background: CHAT_THEME.iconBg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flex: "0 0 auto",
                }}
              >
                <SettingsIcon name={"sliders" as any} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 900, lineHeight: 1.2 }}>채팅방 설정</div>
                <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, lineHeight: 1.2 }}>
                  배경·글자 크기·문단 간격
                </div>
              </div>
            </button>

            {!settings ? (
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 10 }}>
                채팅을 만든 후 설정을 편집할 수 있어요.
              </div>
            ) : null}
          </div>
        ) : !settings ? (
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            채팅을 만든 후 설정을 편집할 수 있어요.
          </div>
        ) : (
          <div style={{}}>
            

              {settingsView === "memory" && settings && chatId ? (
                <div style={{ maxWidth: isMemoryDock ? "100%" : 1180, margin: isMemoryDock ? 0 : "0 auto" }}>
                  <div
                    style={{
                      borderRadius: 16,
                      border: isMemoryDock ? "none" : `1px solid ${CHAT_THEME.borderStrong}`,
                      background: isMemoryDock ? "transparent" : CHAT_THEME.panel,
                      padding: isMemoryDock ? 0 : 14,
                      minWidth: 0,
                    }}
                  >
                    <MemoryPanel key={memoryUiKey} theme={CHAT_THEME as any} chatId={chatId} embed />
                  </div>
                </div>
              ) : null}
              {settingsView === "relations" && settings && chatId ? (
                <div style={{ maxWidth: isMemoryDock ? "100%" : 1180, margin: isMemoryDock ? 0 : "0 auto" }}>
                  <div
                    style={{
                      borderRadius: 16,
                      border: isMemoryDock ? "none" : `1px solid ${CHAT_THEME.borderStrong}`,
                      background: isMemoryDock ? "transparent" : CHAT_THEME.panel,
                      padding: isMemoryDock ? 0 : 14,
                      minWidth: 0,
                    }}
                  >
                    <RelationshipGraphPanel
                      key={`relations-${memoryUiKey}`}
                      theme={CHAT_THEME as any}
                      chatId={chatId}
                      turnKey={memoryUiKey}
                    />
                  </div>
                </div>
              ) : null}
{settingsView === "persona" && (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.4 }}>
        현재 적용: <strong>{settings?.personaName || selectedProfile?.personaName || "(미설정)"}</strong>
        {settings?.personaAge ? ` / ${settings.personaAge}세` : ""}
        {settings?.personaGender ? ` / ${settings.personaGender}` : ""}
      </div>
      {personaApplyMsg ? <div style={{ fontSize: 12, color: CHAT_THEME.muted }}>{personaApplyMsg}</div> : null}
    </div>

    {/* 프로필 선택 + 삭제 */}
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select
        value={selectedProfileId}
        onChange={(e) => {
          const id = e.target.value;
          setSelectedProfileId(id);
          const p = profiles.find((x) => x.id === id);
          if (p) {
            setProfileDraft({
              id: p.id,
              personaName: p.personaName,
              personaAge: p.personaAge,
              personaGender: p.personaGender || "남",
              personaInfo: p.personaInfo,
            });
          }
        }}
        style={{
          flex: 1,
          padding: 10,
          borderRadius: 12,
          border: `1px solid ${CHAT_THEME.borderStrong}`,
          background: CHAT_THEME.panel2,
          color: CHAT_THEME.text,
          outline: "none",
        }}
      >
        {profiles.length === 0 ? <option value="">(프로필 없음)</option> : null}
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.personaName}
          </option>
        ))}
      </select>

      <button
        type="button"
        title="프로필 삭제"
        onClick={() => {
          if (!profileDraft.id) return;
          openConfirm({
            title: "프로필 삭제",
            desc: "이 프로필을 삭제할까요? 삭제 후에는 복구할 수 없습니다.",
            confirmText: "삭제",
            danger: true,
            action: "deleteProfile",
            profileId: profileDraft.id,
          });
        }}
        disabled={!profileDraft.id}
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          border: `1px solid ${CHAT_THEME.borderStrong}`,
          background: CHAT_THEME.iconBg,
          color: CHAT_THEME.text,
          cursor: !profileDraft.id ? "not-allowed" : "pointer",
          opacity: !profileDraft.id ? 0.35 : 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="trash" />
      </button>
    </div>

    {/* 편집 */}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ fontSize: 12, fontWeight: 800 }}>이름</div>
        <input
          value={profileDraft.personaName}
          onChange={(e) => setProfileDraft((p) => ({ ...p, personaName: e.target.value }))}
          placeholder="프로필 이름"
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 12,
            border: `1px solid ${CHAT_THEME.borderStrong}`,
            background: CHAT_THEME.panel2,
            color: CHAT_THEME.text,
          }}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, fontWeight: 800 }}>나이</div>
        <input
          value={String(profileDraft.personaAge || 0)}
          onChange={(e) => setProfileDraft((p) => ({ ...p, personaAge: Number(e.target.value || 0) }))}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 12,
            border: `1px solid ${CHAT_THEME.borderStrong}`,
            background: CHAT_THEME.panel2,
            color: CHAT_THEME.text,
          }}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, fontWeight: 800 }}>성별</div>
        <select
          value={profileDraft.personaGender || "남"}
          onChange={(e) => setProfileDraft((p) => ({ ...p, personaGender: e.target.value }))}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 12,
            border: `1px solid ${CHAT_THEME.borderStrong}`,
            background: CHAT_THEME.panel2,
            color: CHAT_THEME.text,
          }}
        >
          <option value="남">남</option>
          <option value="여">여</option>
        </select>
      </div>
    </div>

    <div>
      <div style={{ fontSize: 12, fontWeight: 800 }}>상세</div>
      <textarea
        value={profileDraft.personaInfo}
        onChange={(e) => setProfileDraft((p) => ({ ...p, personaInfo: e.target.value }))}
        placeholder="(선택) 배경/성격/말투 등"
        style={{
          width: "100%",
          minHeight: 160,
          padding: 10,
          borderRadius: 12,
          border: `1px solid ${CHAT_THEME.borderStrong}`,
          background: CHAT_THEME.panel2,
          color: CHAT_THEME.text,
          outline: "none",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          resize: "vertical",
        }}
      />
    </div>

    {/* 저장 & 적용: (1) 프로필 저장/신규 생성 (2) 채팅 설정 즉시 저장/반영 (3) 닫기 */}
    <button
      type="button"
      disabled={!chatId || saving}
      onClick={async () => {
        if (!chatId || !settings) return;
        const name = (profileDraft.personaName || "").trim();
        if (!name) {
          showToast("이름이 필요합니다", "프로필 이름을 입력해 주세요.", "error");
          return;
        }

        // 이름을 바꾸면 '신규 프로필'로 저장되도록: (선택된 프로필과 이름이 다르면 id 제거)
        const selected = profiles.find((x) => String(x.id) === String(selectedProfileId));
        const shouldCreateNew = !!profileDraft.id && !!selected && name !== String(selected.personaName || "").trim();
        const savePayload = {
          ...(shouldCreateNew ? {} : { id: profileDraft.id }),
          personaName: name,
          personaAge: Number(profileDraft.personaAge || 0),
          personaGender: (profileDraft.personaGender || "남") as any,
          personaInfo: String(profileDraft.personaInfo || ""),
        };

        setSaving(true);
        try {
          // 1) 프로필 저장/생성
          await saveProfile(savePayload as any);

          // 2) 채팅에 즉시 적용 + 저장(조용히)
          const partial = {
            personaName: savePayload.personaName,
            personaAge: savePayload.personaAge,
            personaGender: savePayload.personaGender,
            personaInfo: savePayload.personaInfo,
          } as Partial<Settings>;
          setSettings((s) => (s ? ({ ...s, ...partial } as any) : s));
          await saveSettingsSilent(partial);

          // 3) 닫기
          setPersonaApplyMsg("");
          setUiSettingsOpen(false);
          setSettingsView("home");
        } catch (e: any) {
          showToast("저장 실패", (e?.message || "오류"), "error", 3500);
        } finally {
          setSaving(false);
        }
      }}
      style={{
        width: "100%",
        padding: 12,
        borderRadius: 12,
        border: `1px solid ${CHAT_THEME.borderStrong}`,
        background: CHAT_THEME.accent,
        color: "#fff",
        cursor: "pointer",
        fontWeight: 900,
        opacity: saving ? 0.7 : 1,
      }}
    >
      {saving ? "저장 중..." : "저장 & 적용"}
    </button>
  </div>
)}

{settingsView === "userNote" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <textarea
                  value={settings.userNote}
                  onChange={(e) => setSettings({ ...settings, userNote: e.target.value })}
                  style={{ width: "100%", padding: 10, borderRadius: 12, border: `1px solid ${CHAT_THEME.borderStrong}`, minHeight: 140, background: CHAT_THEME.panel2, color: CHAT_THEME.text, fontSize: 12, resize: "vertical", outline: "none", lineHeight: 1.6, whiteSpace: "pre-wrap" }}
                  placeholder="AI가 답변 생성 시 참조할 노트"
                />
                <button
                  onClick={saveSettings}
                  disabled={saving}
                  type="button"
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: `1px solid ${CHAT_THEME.borderStrong}`, background: CHAT_THEME.panel2, color: CHAT_THEME.text, cursor: "pointer", fontWeight: 900, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? "저장 중..." : "유저노트 저장"}
                </button>
              </div>
            )}

            


{settingsView === "model" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>출력길이</div>

                  {(() => {
                    // 서버(route.ts)는 settings.maxOutputTokens 값을 "목표 글자수"(targetChars)로 해석합니다.
                    // 따라서 UI도 토큰이 아닌 "글자수 프리셋"으로 노출합니다.
                    // (요구) 1200/1700/2500자 프리셋
                    type OutputLevel = "low" | "middle" | "high";
                    const presets: Record<OutputLevel, number> = { low: 1200, middle: 1700, high: 2500 };
                    const v = Number(settings.maxOutputTokens || presets.low);
                    const level: OutputLevel = v <= (presets.low + presets.middle) / 2 ? "low" : v <= (presets.middle + presets.high) / 2 ? "middle" : "high";
                    const btnStyle = (active: boolean): React.CSSProperties => ({
                      flex: 1,
                      padding: "10px 0",
                      borderRadius: 12,
                      border: `1px solid ${active ? CHAT_THEME.accent : CHAT_THEME.borderStrong}`,
                      background: active ? "rgba(255,255,255,0.06)" : CHAT_THEME.panel2,
                      color: CHAT_THEME.text,
                      cursor: "pointer",
                      fontWeight: 900,
                    });
                    const label: Record<OutputLevel, string> = { low: "LOW", middle: "MID", high: "HIGH" };
                    return (
                      <>
                        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                          {(Object.keys(presets) as OutputLevel[]).map((k) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => setSettings({ ...settings, maxOutputTokens: presets[k] })}
                              style={btnStyle(level === k)}
                            >
                              {label[k]}
                            </button>
                          ))}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                          현재: {label[level]} (목표 {presets[level]}자)
                        </div>
                      </>
                    );
                  })()}
                </div>

                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{/^gemini-3(?:\.|-)/i.test(String(settings.model || "")) ? "사고 수준 (Gemini 3)" : "추론길이"}</div>

                  {(() => {
                    const presets = getReasoningPresets(settings.model);
                    const levelOptions = getReasoningLevelOptions(settings.model);
                    const level = inferReasoningLevel(settings.model, Number(settings.maxReasoningTokens));
                    const btnStyle = (active: boolean): React.CSSProperties => ({
                      flex: 1,
                      padding: "10px 0",
                      borderRadius: 12,
                      border: `1px solid ${active ? CHAT_THEME.accent : CHAT_THEME.borderStrong}`,
                      background: active ? "rgba(255,255,255,0.06)" : CHAT_THEME.panel2,
                      color: CHAT_THEME.text,
                      cursor: "pointer",
                      fontWeight: 900,
                    });
                    const isG3ProModel = /gemini-3(?:\.\d+)?-pro/i.test(String(settings.model || ""));
                    const label: Record<ReasoningLevel, string> = {
                      zero: isG3ProModel ? "FAST" : "ZERO",
                      low: "LOW",
                      middle: "MID",
                      high: "HIGH",
                    };
                    return (
                      <>
                        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                          {levelOptions.map((k) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => setSettings({ ...settings, maxReasoningTokens: presets[k] })}
                              style={btnStyle(level === k)}
                            >
                              {label[k]}
                            </button>
                          ))}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                          {(() => {
                            const modelName = String(settings.model || "");
                            const isG3 = /^gemini-3(?:\.|-)/i.test(modelName);
                            const isG3Pro = /gemini-3(?:\.\d+)?-pro/i.test(modelName);
                            const actualReasoning = Number(settings.maxReasoningTokens ?? presets[level]);

                            // (2026-08-15) 표시 레벨은 저장값에서 직접 계산한다.
                            // 이전에는 반올림된 `level`에서 역산해서, 저장값이 384인데도
                            // "MID (thinking: medium)"라고 적혀 있었다. 실제 서버 전송은 low였다.
                            // 서버(lib/ai.ts buildThinkingConfig)와 같은 임계값을 쓴다.
                            const g3Level = isG3Pro
                              ? actualReasoning >= 1280
                                ? "high"
                                : "medium"
                              : actualReasoning >= 1024
                                ? "high"
                                : actualReasoning >= 640
                                  ? "medium"
                                  : "low";

                            // 어느 버튼으로도 만들 수 없는 값이면(예: 모델 교체 후 남은 값)
                            // 버튼 상태만 보고 오해하지 않도록 실제 저장값을 함께 노출한다.
                            const orphan = !isReasoningPresetTokens(modelName, actualReasoning);
                            const suffix = isG3
                              ? ` (thinking: ${g3Level})`
                              : ` (${actualReasoning} tokens)`;
                            return `현재: ${label[level]}${suffix}${
                              orphan ? ` ⚠ 저장값 ${actualReasoning} — 버튼을 다시 눌러 저장하세요` : ""
                            }`;
                          })()}
                        </div>
                      </>
                    );
                  })()}
                </div>

                <button
                  onClick={saveSettings}
                  disabled={!chatId || saving}
                  type="button"
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: `1px solid ${CHAT_THEME.borderStrong}`, background: CHAT_THEME.panel2, color: CHAT_THEME.text, cursor: "pointer", fontWeight: 900, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? "저장 중..." : "출력/추론 저장"}
                </button>
              </div>
            )}

{settingsView === "room" && (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {/* 이미지 표시 */}
    <div
      style={{
        width: "100%",
        padding: 12,
        borderRadius: 14,
        border: "none",
        background: CHAT_THEME.panel,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 900, lineHeight: 1.2 }}>이미지 표시</div>
        <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.2 }}>대화 중 이미지/이미지 URL을 표시합니다.</div>
      </div>
      <button
        type="button"
        onClick={() => setShowImages((v) => !v)}
        style={{
          width: 44,
          height: 24,
          borderRadius: 999,
          border: "none",
          background: showImages ? "#ef4444" : "rgba(255,255,255,0.12)",
          position: "relative",
          cursor: "pointer",
          flex: "0 0 auto",
        }}
        aria-label="이미지 표시 토글"
      >
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 999,
            background: "#fff",
            position: "absolute",
            top: 2,
            left: showImages ? 22 : 2,
            transition: "left 140ms ease",
          }}
        />
      </button>
    </div>

    {/* 텍스트 설정 */}
    <div
      style={{
        width: "100%",
        padding: 12,
        borderRadius: 14,
        border: "none",
        background: CHAT_THEME.panel,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 900, opacity: 0.9 }}>텍스트 설정</div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>글자 크기</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>{Math.round(chatFontSizePx)}px</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setChatFontSizePx((v) => Math.max(12, Math.min(24, v - 1)))}
            style={{ width: 34, height: 34, borderRadius: 12, border: "none", background: CHAT_THEME.iconBg, color: CHAT_THEME.text, cursor: "pointer", fontWeight: 900 }}
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setChatFontSizePx((v) => Math.max(12, Math.min(24, v + 1)))}
            style={{ width: 34, height: 34, borderRadius: 12, border: "none", background: CHAT_THEME.iconBg, color: CHAT_THEME.text, cursor: "pointer", fontWeight: 900 }}
          >
            +
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>문단 간격</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>문단 사이 여백</div>
        </div>
        <select
          value={paraSpacing}
          onChange={(e) => setParaSpacing(e.target.value as any)}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: `1px solid ${CHAT_THEME.borderStrong}`,
            background: CHAT_THEME.panel2,
            color: CHAT_THEME.text,
            outline: "none",
            fontWeight: 800,
          }}
        >
          <option value="veryTight">매우좁게</option>
          <option value="tight">좁게</option>
          <option value="normal">보통</option>
          <option value="wide">넓게</option>
          <option value="veryWide">매우넓게</option>
        </select>
      </div>

      <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.35 }}>
        설정은 채팅별로 저장되며(로컬), 새로고침 후에도 유지됩니다.
      </div>
    </div>
  </div>
)}
          </div>
        )}
      </div>

      {/* RIGHT chat */}
      {/* 메인 채팅 영역: 테두리/카드 제거(영상처럼 자연스럽게) */}
      <div
        style={{

          gridColumn: isMemoryDock ? 1 : undefined,
          border: "none",
          background: "transparent",
          borderRadius: 16,
          padding: 0,
          overflow: "hidden",
          color: CHAT_THEME.text,
          display: isRelationshipFocus ? "none" : "flex",
          flexDirection: "column",
          // 부모 컨테이너 높이를 그대로 따르게 해서 모바일/키보드 환경에서 과대 높이로 잘리지 않게 한다.
          height: "100%",
          minHeight: 0,
        }}
      >
        <div
          ref={scrollRef}
          onScroll={onChatScroll}
          onWheelCapture={onChatWheelCapture}
          className="chatScroll"
		      	  style={{
		      	    // Desktop: 영상 느낌을 위해 66vh 제한 유지
		      	    // Mobile: 화면이 작아서 66vh 고정은 답답함 → 남는 영역을 더 활용
		      	    flex: ((isMobile || isMemoryDock) ? "1 1 auto" : "0 0 auto") as any,
            height: (isMobile || isMemoryDock) ? "auto" : "66vh",
            maxHeight: (isMobile || isMemoryDock) ? "none" : "66vh",
            minHeight: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch" as any,
            overscrollBehavior: "contain" as any,
            border: "none",
            borderRadius: 0,
	          padding: "4px 0",
            background: "transparent",
	          // 스크롤 영역을 '채팅 컬럼 폭'으로 제한해, 페이지(오른쪽 끝) 스크롤과 분리된 느낌을 준다.
	          // (중요) 하단 입력창은 fixed라서, Mobile/도킹 모드에서는 스크롤 영역이 입력창 뒤로 깔릴 수 있다.
	          // → paddingBottom으로 "스크롤 가능한 빈 공간"을 만들기보다, 실제로 스크롤 영역 높이를 줄여 겹침을 방지한다.
	          width: "100%",
	          maxWidth: CHAT_COLUMN_MAX + 40,
	          margin: "0 auto",
	          marginBottom: isMemoryDock ? bottomInset : (isMobile ? mobileBottomInset : 0),
	          scrollPaddingBottom: 24,
scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.12) transparent",
          }}
        >
          <div
            ref={contentRef}
            style={{
              width: "100%",
              maxWidth: CHAT_COLUMN_MAX,
	            // 우측에 살짝 여유를 줘서(스크롤바/가장자리) 텍스트가 너무 붙지 않게 한다.
	            paddingLeft: 14,
	            paddingRight: 26,
	            paddingTop: 0,
	            paddingBottom: 24,
              fontSize: Math.max(12, Math.min(24, Number(chatFontSizePx || 18))),
              // 하단 고정 입력창과 절대 겹치지 않도록 입력창 높이 기반으로 하단 여백을 확보
boxSizing: "border-box",
            }}
          >
            <MessageList
  messagesLength={messages.length}
  visibleMessages={visibleMessages}
  modelName={settings?.model || ""}
  getModelBadge={getModelBadge}
  stripLeadingTitleForDisplay={stripLeadingTitleForDisplay}
  hiddenMessageCount={hiddenMessageCount}
  hiddenNewerMessageCount={hiddenNewerMessageCount}
  windowStep={WINDOW_STEP}
  hasMoreOlder={hasMoreOlder}
  loadingOlder={loadingOlder}
  requestLoadOlder={loadOlder}
  moveWindowUp={moveWindowUp}
  resetWindowToTail={stableResetWindowToTail}
  userName={userName}
  npcName={npcName}
  theme={CHAT_THEME as ChatTheme}
  iconButtonStyle={iconButtonStyle}
  MessageContent={MessageContent}
  effectiveRenderMode={((settings as any)?.renderMode === "chat" ? "chat" : "novel")}
	  // 프리버퍼 UI: 스트리밍 초반 2초 동안 임시 assistant 말풍선(대사 옆)에 "✨ N초 동안 생각 중..." 표시
	  // - 실제 글자(공백 제외) 1자라도 출력되면 즉시 사라진다.
	  prebufferUiActive={prebufferUiActive}
	  prebufferSec={prebufferSec}
	  prebufferDots={prebufferDots}
	  streamTempAssistantId={streamTempAssistantIdRef.current}
		  stallUiActive={stallUiActive}
		  streamTargetId={thinkingTargetId}
  editingAssistantId={editingAssistantId}
  editingUserId={editingUserId}
  assistantDraft={assistantDraft}
  userDraft={userDraft}
  onChangeAssistantDraft={onChangeAssistantDraft}
  onChangeUserDraft={onChangeUserDraft}
  onRegenerateFromAssistant={stableRegenerateFromAssistant}
  onContinueFromAssistant={stableContinueFromAssistant}
  onRequestDeleteMessage={stableRequestDeleteMessage}
  onStartAssistantEdit={stableStartAssistantEdit}
  onStartUserEdit={stableStartUserEdit}
  onOpenTokenInfo={stableOpenTokenInfo}
  onCancelAssistantEdit={stableCancelAssistantEdit}
  onSaveAssistantEdit={stableSaveAssistantEdit}
  onCancelUserEdit={stableCancelUserEdit}
  onSaveUserEdit={stableSaveUserEdit}
  bottomRef={bottomRef}
/>
          </div>
        </div>
        {/* 토큰 팝업 (UI 톤 통일) */}
        
        {/* 공통 확인 모달 (새 대화 시작 / 채팅 삭제 / 프로필 삭제) */}
        {confirmModal.open && (
          <div
            onClick={() => setConfirmModal((p) => ({ ...p, open: false }))}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 95,
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(4px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(520px, calc(100vw - 24px))",
                border: `1px solid ${CHAT_THEME.borderStrong}`,
                borderRadius: 20,
                padding: 16,
                background: "linear-gradient(180deg, rgba(18,18,22,0.98), rgba(10,10,12,0.92))",
                color: CHAT_THEME.text,
                boxShadow: "0 22px 70px rgba(0,0,0,0.65)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: confirmModal.danger ? "rgba(255,90,90,0.14)" : "rgba(255,255,255,0.10)",
                      border: `1px solid ${confirmModal.danger ? "rgba(255,90,90,0.35)" : CHAT_THEME.border}`,
                      color: confirmModal.danger ? "#ff8a8a" : CHAT_THEME.text,
                    }}
                  >
                    <Icon name={confirmModal.danger ? "trash" : "info"} size={18} />
                  </div>
                  <div style={{ fontWeight: 900, fontSize: 14 }}>{confirmModal.title}</div>
                </div>

                <button
                  type="button"
                  onClick={() => setConfirmModal((p) => ({ ...p, open: false }))}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 12,
                    border: "none",
                    background: "rgba(255,255,255,0.06)",
                    color: CHAT_THEME.text,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>

              <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, opacity: 0.85, whiteSpace: "pre-wrap" }}>
                {confirmModal.desc}
              </div>

              <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setConfirmModal((p) => ({ ...p, open: false }))}
                  style={{
                    border: "none",
                    background: "rgba(255,255,255,0.06)",
                    color: CHAT_THEME.text,
                    borderRadius: 14,
                    padding: "10px 14px",
                    fontWeight: 900,
                    cursor: "pointer",
                  }}
                >
                  취소
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    const action = confirmModal.action;
                    const profileId = confirmModal.profileId;
                    setConfirmModal((p) => ({ ...p, open: false }));
                    // NOTE: 기존 기능 로직 유지 (UI에서만 확인 모달 처리)
                    if (action === "newChat") {
                      await createChat(true, true);
                    } else if (action === "deleteChat") {
                      await deleteChatAndExit(true);
                    } else if (action === "deleteProfile") {
                      if (!profileId) return;
                      try {
                        await deleteProfile(profileId);
                        setProfileDraft({ personaName: "", personaAge: 0, personaGender: "남", personaInfo: "" });
                        setSelectedProfileId("");
                        setPersonaApplyMsg("프로필 삭제 완료");
                        window.setTimeout(() => setPersonaApplyMsg(""), 2000);
                      } catch (e: any) {
                        alert(e?.message || "오류");
                      }
                    }
                  }}
                  style={{
                    border: `1px solid ${confirmModal.danger ? "rgba(255,90,90,0.55)" : CHAT_THEME.borderStrong}`,
                    background: confirmModal.danger ? "rgba(255,90,90,0.16)" : `rgba(93, 154, 255, 0.18)`,
                    color: CHAT_THEME.text,
                    borderRadius: 14,
                    padding: "10px 14px",
                    fontWeight: 900,
                    cursor: "pointer",
                  }}
                >
                  {confirmModal.confirmText}
                </button>
              </div>
            </div>
          </div>
        )}

{tokenPopup.open && (
          <div
            onClick={() => {
              setTokenPopup((p) => ({ ...p, open: false }));
              setTokenPopupAnchor(null);
            }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 120,
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(4px)",
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              padding: "18px 12px",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(560px, calc(100vw - 24px))",
                position: "fixed",
                left: tokenPopupAnchor
                  ? `clamp(12px, ${tokenPopupAnchor.left + tokenPopupAnchor.width / 2}px, calc(100vw - 12px))`
                  : "50%",
                top: tokenPopupAnchor
                  ? tokenPopupAnchor.top < 180
                    ? `clamp(12px, ${tokenPopupAnchor.bottom + 10}px, calc(100dvh - 12px))`
                    : `clamp(12px, ${tokenPopupAnchor.top - 10}px, calc(100dvh - 12px))`
                  : "50%",
                transform: tokenPopupAnchor
                  ? tokenPopupAnchor.top < 180
                    ? "translate(-50%, 0)"
                    : "translate(-50%, -100%)"
                  : "translate(-50%, -50%)",
                maxHeight: "82vh",
                overflowY: "auto",
                border: `1px solid ${CHAT_THEME.borderStrong}`,
                borderRadius: 16,
                padding: 14,
                background: "rgba(12,12,14,0.92)",
                color: CHAT_THEME.text,
                boxShadow: "0 18px 50px rgba(0,0,0,0.60)",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(255,255,255,0.10)",
                      border: "none",
                      color: CHAT_THEME.text,
                    }}
                  >
                    <Icon name="info" size={18} />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ fontWeight: 900, fontSize: 14 }}>{tokenPopup.title}</div>

{!tokenPopup.usage && (
  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75, lineHeight: 1.4 }}>
    이 메시지에는 사용량 메타데이터가 저장되어 있지 않습니다. (보통 유저 메시지이거나, 응답 저장 중 오류가 있었던 경우입니다.)
  </div>
)}
                    <div style={{ fontSize: 12, opacity: 0.65 }}>사용량 메타데이터</div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setTokenPopup((p) => ({ ...p, open: false }));
                    setTokenPopupAnchor(null);
                  }}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 12,
                    border: "none",
                    background: "rgba(255,255,255,0.06)",
                    color: CHAT_THEME.text,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>

              <div style={{ height: 12 }} />

              {!LOCAL_POINTS_DISABLED && (() => {
                // (A) 이번 응답 비용
                const totalTokens = Number(tokenPopup.usage?.totalTokens);
                const model = (tokenPopup.usage?.model as string | undefined) ?? settings?.model;

                const hasUsage = Number.isFinite(totalTokens) && totalTokens > 0;
                const fee = hasUsage ? calcFriendFee(totalTokens, model) : NaN;
                const feeUi = hasUsage ? roundFriendFeeUi(fee) : NaN;
                const krwUi = hasUsage ? formatKrwUi(fee * KRW_PER_FRIENDFEE) : "";

                // (B) 이 채팅 누적 비용
                  const sum = (() => {
                  let feeRaw = 0;
                  for (const m of messages) {
                    if (m.role !== "assistant") continue;
                    const t = Number(m.usage?.totalTokens);
                    if (!Number.isFinite(t) || t <= 0) continue;
                    const mm = (m.usage?.model as string | undefined) ?? settings?.model;
                    feeRaw += calcFriendFee(t, mm);
                  }
                  return { feeRaw };
                })();
                const sumFeeUi = roundFriendFeeUi(sum.feeRaw);
                const sumKrwUi = formatKrwUi(sum.feeRaw * KRW_PER_FRIENDFEE);

                return (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ opacity: 0.7, fontWeight: 900 }}>이번 응답 비용(실제 과금)</span>
                      <strong>
                        {hasUsage ? `${feeUi.toLocaleString()} 친구비 · ${krwUi}` : "계산 중…"}
                      </strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ opacity: 0.7, fontWeight: 900 }}>현재 화면 누적</span>
                      <strong>
                        {`${sumFeeUi.toLocaleString()} 친구비 · ${sumKrwUi}`}
                      </strong>
                    </div>
                    <div style={{ height: 10 }} />
                    <div style={{ height: 1, background: "rgba(255,255,255,0.10)" }} />
                    <div style={{ height: 10 }} />
                  </>
                );
              })()}

              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ opacity: 0.7 }}>입력 토큰(실측)</span>
                <strong>{tokenPopup.usage ? tokenPopup.usage.promptTokens ?? 0 : "—"}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ opacity: 0.7 }}>출력 토큰(실측)</span>
                <strong>{tokenPopup.usage ? tokenPopup.usage.outputTokens ?? 0 : "—"}</strong>
              </div>
              {tokenPopup.usage && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.7 }}>추론 토큰(실측)</span>
                  <strong>
                    {typeof tokenPopup.usage.reasoningTokens === "number"
                      ? tokenPopup.usage.reasoningTokens
                      : "미제공"}
                  </strong>
                </div>
              )}
              {tokenPopup.usage && typeof tokenPopup.usage.reasoningTokens !== "number" && (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6, lineHeight: 1.3 }}>
                  * 이 응답은 API에서 추론 토큰(thoughtsTokenCount)을 별도로 제공하지 않아 표시할 수 없습니다.
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ opacity: 0.7 }}>총 토큰(실측)</span>
                <strong>{tokenPopup.usage ? tokenPopup.usage.totalTokens ?? 0 : "—"}</strong>
              </div>
              {tokenPopup.usage?.finishReason && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.7 }}>종료 사유(finishReason)</span>
                  <strong>{String(tokenPopup.usage.finishReason)}</strong>
                </div>
              )}
              {typeof tokenPopup.usage?.effectiveMaxOutputTokens === "number" && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.7 }}>호출 출력 예산</span>
                  <strong>{tokenPopup.usage.effectiveMaxOutputTokens}</strong>
                </div>
              )}
              {tokenPopup.usage?.thinkingLevel && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.7 }}>추론 레벨</span>
                  <strong>{String(tokenPopup.usage.thinkingLevel)}</strong>
                </div>
              )}

              {Array.isArray(tokenPopup.usage?.debugReasons) && tokenPopup.usage.debugReasons.length > 0 && (
                <div style={{ marginTop: 8, opacity: 0.85, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 900, marginBottom: 4 }}>중단/트림 원인(서버 진단)</div>
                  <div>{tokenPopup.usage.debugReasons.join(" · ")}</div>
                </div>
              )}

              {tokenPopup.usage?.tokenBreakdown && (
                <>
                  <div style={{ height: 12 }} />
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>입력 토큰 구성(실측 합계 기반 추정 배분)</div>
                  {(() => {
                    const promptMeasured = Number(tokenPopup.usage?.promptTokens ?? 0) || 0;
                    const breakdown = tokenPopup.usage!.tokenBreakdown!;
                    const order = [
                      "presetPrompt",
                      "lorebookPrompt",
                      "persona",
                      "userNote",
                      "longMemorySummary",
                      "recentTurns",
                      "userInput",
                      "systemAndRules",
                    ];
                    const entries = Object.entries(breakdown);
                    entries.sort((a, b) => {
                      const ia = order.indexOf(a[0]);
                      const ib = order.indexOf(b[0]);
                      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
                    });
                    return entries.map(([k, v]) => {
                      const n = Number(v) || 0;
                      const pct = promptMeasured > 0 ? Math.round((n / promptMeasured) * 100) : 0;
                      return (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                          <span style={{ opacity: 0.75 }}>
                            {labelTokenKey(k)}
                            {promptMeasured > 0 && (
                              <span style={{ opacity: 0.55, marginLeft: 8 }}>{pct}%</span>
                            )}
                          </span>
                          <strong>{n}</strong>
                        </div>
                      );
                    });
                  })()}
                  <div style={{ height: 8 }} />
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ opacity: 0.75 }}>추정 합계(출력/추론 실측 + 입력 배분)</span>
                    <strong>
                      {(
                        Number(tokenPopup.usage.outputTokens ?? 0) +
                        Number(tokenPopup.usage.reasoningTokens ?? 0) +
                        Number(tokenPopup.usage.estPromptTotal ?? 0)
                      )}
                    </strong>
                  </div>
                  <div style={{ marginTop: 8, opacity: 0.6 }}>* 각 항목은 입력 토큰(실측)을 구성요소별로 배분한 값입니다.</div>
                </>
              )}
            </div>
          </div>
        )}

        {/* 삭제 확인 팝업 (UI 톤 통일) */}
        {deletePopup.open && (
          <div
            onClick={() => setDeletePopup({ open: false, messageId: "" })}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 120,
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(4px)",
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              padding: "18px 12px",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(560px, calc(100vw - 24px))",
                border: `1px solid ${CHAT_THEME.borderStrong}`,
                borderRadius: 20,
                padding: 16,
                background: "linear-gradient(180deg, rgba(18,18,22,0.98), rgba(10,10,12,0.92))",
                color: CHAT_THEME.text,
                boxShadow: "0 22px 70px rgba(0,0,0,0.65)",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(255,90,90,0.14)",
                      border: `1px solid rgba(255,90,90,0.35)`,
                      color: "#ff8a8a",
                    }}
                  >
                    <Icon name="trash" size={18} />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ fontWeight: 900, fontSize: 15 }}>메시지 삭제</div>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>삭제 후에는 복구할 수 없습니다</div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setDeletePopup({ open: false, messageId: "" })}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 12,
                    border: "none",
                    background: "rgba(255,255,255,0.06)",
                    color: CHAT_THEME.text,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>

              <div
                style={{
                  marginTop: 12,
                  padding: "12px 12px",
                  borderRadius: 16,
                  border: "none",
                  background: "rgba(255,255,255,0.06)",
                  opacity: 0.9,
                  lineHeight: 1.6,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                }}
              >
	                {deletePopup.pairedUserId ? "이 문단(사용자 입력 + AI 답변)을 삭제할까요?" : "이 메시지를 삭제할까요?"}
		{deletePopup.pairedUserId ? "삭제하면 해당 사용자 입력과 AI 답변이 함께 삭제됩니다." : "삭제하면 복구할 수 없습니다."}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => setDeletePopup({ open: false, messageId: "" })}
                  style={{
                    border: "none",
                    background: "rgba(255,255,255,0.06)",
                    cursor: "pointer",
                    fontSize: 12,
                    color: CHAT_THEME.text,
                    borderRadius: 12,
                    padding: "10px 14px",
                    fontWeight: 900,
                  }}
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const id = deletePopup.messageId;
                    const pairedId = deletePopup.pairedUserId;
                    setDeletePopup({ open: false, messageId: "" });
                    if (id) await onDeleteMessageConfirmed(id, pairedId);
                  }}
                  style={{
                    border: `1px solid ${CHAT_THEME.borderStrong}`,
                    background: "rgba(255,60,60,0.20)",
                    cursor: "pointer",
                    fontSize: 12,
                    color: CHAT_THEME.text,
                    borderRadius: 12,
                    padding: "10px 14px",
                    fontWeight: 900,
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 입력창 내부에 '추천 답변(2개)'을 노출 + 전송/모델 선택을 input 안에 배치 */}
	        <div
	          ref={inputBarRef}
		          style={{
		            position: "fixed",
            left: "var(--chatDockLeft, 0px)",
            right: "auto",
            bottom: inputBarBottomPx,
            width: "var(--chatDockWidth, 100vw)",
		            display: "flex",
		            justifyContent: "center",
	            // 아래 고정 입력창. iOS 홈바(safe-area)까지 고려해 padding-bottom을 보정
	            padding: "14px 0 calc(env(safe-area-inset-bottom, 0px) + 16px)",
	            background: "rgba(26,27,27,0.90)",
	            borderTop: "1px solid rgba(255,255,255,0.06)",
	            pointerEvents: "none",
	          }}
	        >
	          <div style={{ width: "100%", maxWidth: CHAT_COLUMN_MAX, padding: "0 14px", pointerEvents: "auto" }}>
	            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
	          <div
	            style={{
	              flex: 1,
	              borderRadius: 24,
	              border: "none",
	              // 입력창 뒤로 대사/지문이 비치지 않도록 불투명도↑
	              background: "rgba(45,45,45,0.96)",
	              padding: "8px 10px",
	              position: "relative",
	            }}
	          >
	            {/* 전송/중단 아이콘(메시지 박스 내부 우측 상단) */}
	            {busy ? (
	              // 생성 중에는 같은 자리를 '중단' 버튼으로 바꾼다.
	              // (이전에는 취소 수단이 '채팅 전환'뿐이라 모델이 멈추면 빠져나갈 길이 없었다.)
	              <button
	                type="button"
	                onClick={() => cancelInFlightSend("user-stop")}
	                title="생성 중단 (Esc)"
	                aria-label="생성 중단"
	                style={{
	                  position: "absolute",
	                  top: 8,
	                  right: 8,
	                  width: 34,
	                  height: 34,
	                  borderRadius: 10,
	                  border: "none",
	                  background: "rgba(239,68,68,0.18)",
	                  color: "#fca5a5",
	                  cursor: "pointer",
	                  display: "flex",
	                  alignItems: "center",
	                  justifyContent: "center",
	                }}
	              >
	                <Icon name="stop" size={14} />
	              </button>
	            ) : (
	              <button
	                type="button"
	                onClick={send}
	                disabled={!!editingAssistantId || !chatId}
	                title={messages.length === 0 ? "시작" : "전송"}
	                aria-label={messages.length === 0 ? "시작" : "전송"}
	                style={{
	                  position: "absolute",
	                  top: 8,
	                  right: 8,
	                  width: 34,
	                  height: 34,
	                  borderRadius: 10,
	                  border: "none",
	                  background: editingAssistantId ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.06)",
	                  color: editingAssistantId ? "rgba(255,255,255,0.35)" : CHAT_THEME.text,
	                  cursor: editingAssistantId ? "not-allowed" : "pointer",
	                  display: "flex",
	                  alignItems: "center",
	                  justifyContent: "center",
	                }}
	              >
	                <Icon name="paperPlane" size={16} />
	              </button>
	            )}

	            {(suggestions.length > 0 || suggestLoading) && (
	            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8, paddingRight: 44 }}>
		              {suggestions.length > 0 ? (
		                suggestions.slice(0, 2).map((s, i) => (
                  <button
                    key={`${i}-${s}`}
                    type="button"
                    onClick={() => {
                      setInput(s);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                    style={{
                      maxWidth: "100%",
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: "none",
                      background: getModelBadge(settings?.model || "").bg,
                      color: CHAT_THEME.text,
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 700,
                      opacity: 0.9,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={s}
                  >
                    {s}
                  </button>
	              ))
	              ) : (
	                <div
	                  style={{
	                    padding: "6px 10px",
	                    borderRadius: 999,
	                    border: "none",
	                    background: "rgba(255,255,255,0.03)",
	                    color: CHAT_THEME.muted,
	                    fontSize: 12,
	                    fontWeight: 700,
	                    opacity: 0.9,
	                  }}
	                >
	                  추천 생성 중…
	                </div>
	              )}
              </div>
            )}
              <textarea
	              ref={inputRef}
	              value={input}
	              onChange={(e) => setInput(e.target.value)}
	              placeholder={editingAssistantId ? "수정 중... (저장/취소 후 전송)" : busy ? "채팅 입력중..." : "대사를 입력하세요. 예) 반가워!"}
	              disabled={busy || !!editingAssistantId}
	              onKeyDown={(e) => {
                // Enter: send (unless Shift+Enter for newline, or IME composition)
                if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as any)?.isComposing) {
                  e.preventDefault();
                  if (!busy && !editingAssistantId) send();
                }
              }}
	              rows={1}
	              style={{
	                width: "100%",
	                padding: "6px 44px 34px 0",
	                borderRadius: 0,
	                border: "none",
	                outline: "none",
	                background: "transparent",
	                color: "#ffffff",
	                caretColor: "#ffffff",
	                resize: "none",
	                minHeight: 44,
	                maxHeight: 160,
	                overflowY: "auto",
	                lineHeight: 1.45,
	                fontSize: Math.max(12, Math.min(24, Number(chatFontSizePx || 18))),
	              }}
	            />

	            {/* 하단: 좌측(지문) / 우측(모델) */}
	            <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div />

	              <div style={{ position: "relative", marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
	                
	                <div
	                  style={{
	                    display: "none",
	                    borderRadius: 999,
	                    overflow: "hidden",
	                    border: "none",
	                    background: "rgba(255,255,255,0.03)",
	                  }}
	                >
	                  <button
	                    type="button"
	                    disabled={!chatId || !settings}
	                    onClick={() => {
	                      if (!settings) return;
	                      if (settings.renderMode === "chat") return;
	                      setSettings({ ...settings, renderMode: "chat" });
	                      saveSettingsSilent({ renderMode: "chat" as any });
	                    }}
	                    style={{
	                      padding: "6px 10px",
	                      fontSize: 12,
	                      fontWeight: 800,
	                      lineHeight: 1,
	                      border: "none",
	                      background: settings?.renderMode === "chat" ? "rgba(255,255,255,0.10)" : "transparent",
	                      color:
	                        !chatId || !settings
	                          ? "rgba(255,255,255,0.35)"
	                          : settings?.renderMode === "chat"
	                            ? CHAT_THEME.text
	                            : "rgba(255,255,255,0.65)",
	                      cursor: !chatId || !settings ? "not-allowed" : "pointer",
	                    }}
	                    title="채팅 모드"
	                  >
	                    채팅
	                  </button>
	                  <button
	                    type="button"
	                    disabled={!chatId || !settings}
	                    onClick={() => {
	                      if (!settings) return;
	                      if (settings.renderMode === "novel") return;
	                      setSettings({ ...settings, renderMode: "novel" });
	                      saveSettingsSilent({ renderMode: "novel" as any });
	                    }}
	                    style={{
	                      padding: "6px 10px",
	                      fontSize: 12,
	                      fontWeight: 800,
	                      lineHeight: 1,
	                      border: "none",
	                      background: settings?.renderMode === "novel" ? "rgba(255,255,255,0.10)" : "transparent",
	                      color:
	                        !chatId || !settings
	                          ? "rgba(255,255,255,0.35)"
	                          : settings?.renderMode === "novel"
	                            ? CHAT_THEME.text
	                            : "rgba(255,255,255,0.65)",
	                      cursor: !chatId || !settings ? "not-allowed" : "pointer",
	                    }}
	                    title="소설 모드"
	                  >
	                    소설
	                  </button>
	                </div>

                {/* 입력 도우미: 지문(*) / 추천(✨) */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    onClick={insertNarrationMarkers}
                    disabled={busy || !!editingAssistantId}
                    title="지문 마커(* * ) 삽입"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 10,
                      border: "none",
                      background: busy || editingAssistantId ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)",
                      color: busy || editingAssistantId ? "rgba(255,255,255,0.35)" : CHAT_THEME.text,
                      cursor: busy || editingAssistantId ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="narration" size={16} />
                  </button>

                  <button
                    type="button"
                    onClick={requestSuggestionsOnDemand}
                    disabled={busy || suggestLoading || !!editingAssistantId || !chatId}
                    title={suggestLoading ? "추천답변 생성 중" : "추천답변 생성"}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 10,
                      border: "none",
                      background: busy || suggestLoading || editingAssistantId ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)",
                      color: busy || suggestLoading || editingAssistantId ? "rgba(255,255,255,0.35)" : CHAT_THEME.text,
                      cursor: busy || suggestLoading || editingAssistantId ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="magic" size={16} />
                  </button>
                </div>


<button
	                  ref={modelBtnRef}
	                  type="button"
	                  disabled={!chatId || !settings}
	                  onClick={() => setModelMenuOpen((v) => !v)}
	                  title={settings?.model || ""}
	                  style={{
	                    display: "flex",
	                    alignItems: "center",
	                    gap: 8,
	                    maxWidth: "min(360px, 64vw)",
	                    padding: "6px 10px",
	                    borderRadius: 999,
	                    border: "none",
	                    background: getModelBadge(settings?.model || "").bg,
	                    color: !chatId || !settings ? "rgba(255,255,255,0.35)" : getModelBadge(settings?.model || "").fg,
	                    cursor: !chatId || !settings ? "not-allowed" : "pointer",
	                    fontSize: 12,
	                    fontWeight: 800,
	                    lineHeight: 1,
	                    whiteSpace: "nowrap",
	                    overflow: "hidden",
	                    textOverflow: "ellipsis",
	                  }}
	                >
	                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{getModelBadge(settings?.model || "").label}</span>
	                  <Icon name="chevronDown" size={14} />
	                </button>

	                {modelMenuOpen && settings && (
	                  <div
	                    ref={modelMenuRef}
	                    style={{
	                      position: "absolute",
	                      right: 0,
	                      bottom: 40,
	                      width: "min(360px, 72vw)",
	                      borderRadius: 14,
	                      border: `1px solid ${CHAT_THEME.borderStrong}`,
	                      background: "rgba(12,12,14,0.92)",
	                      backdropFilter: "blur(8px)",
	                      boxShadow: "0 14px 34px rgba(0,0,0,0.55)",
	                      padding: 8,
	                      zIndex: 80,
	                    }}
	                  >
	                    {MODEL_OPTIONS.map((m) => {
	                      const active = settings.model === m;
	                      return (
	                        <button
	                          key={m}
	                          type="button"
	                          onClick={() => {
	                            if (!settings) return;
	                            setSettings({ ...settings, model: m as any });
	                            saveSettingsSilent({ model: m as any });
	                            setModelMenuOpen(false);
	                          }}
	                          style={{
	                            width: "100%",
	                            display: "flex",
	                            alignItems: "center",
	                            gap: 10,
	                            padding: "10px 10px",
	                            borderRadius: 12,
	                            border: `1px solid ${active ? CHAT_THEME.borderStrong : "transparent"}`,
	                            background: active ? "rgba(255,255,255,0.06)" : "transparent",
	                            color: CHAT_THEME.text,
	                            cursor: "pointer",
	                            textAlign: "left",
	                            fontSize: 12,
	                            fontWeight: active ? 900 : 700,
	                          }}
	                        >
	                          <span style={{ width: 18, opacity: active ? 1 : 0.25 }} aria-hidden>
	                            ✓
	                          </span>
	                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{getModelDisplayLabel(m)}</span>
	                        </button>
	                      );
	                    })}
	                  </div>
	                )}
	              </div>
	            </div>
	          </div>
	        </div>
	      </div>
	    </div>

	    {/* 친구비 0일 때: 조그마한 팝업 + 충전 유도 */}
	    {!LOCAL_POINTS_DISABLED && friendFeeEmptyPopup.open && typeof document !== "undefined" &&
	      createPortal(
	        <div
	          style={{
	            position: "fixed",
	            right: 18,
	            bottom: 98,
	            zIndex: 160,
	            width: "min(320px, calc(100vw - 24px))",
	            border: `1px solid ${CHAT_THEME.borderStrong}`,
	            borderRadius: 16,
	            background: "rgba(12,12,14,0.94)",
	            boxShadow: "0 18px 50px rgba(0,0,0,0.60)",
	            padding: 12,
	            color: CHAT_THEME.text,
	          }}
	        >
	          <div style={{ fontWeight: 900, fontSize: 13, lineHeight: 1.4, marginBottom: 10 }}>
	            {friendFeeEmptyPopup.text}
	          </div>
	          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
	            <button
	              type="button"
	              onClick={goFriendFeeCharge}
	              style={{
	                border: `1px solid ${CHAT_THEME.borderStrong}`,
	                background: "rgba(255,255,255,0.10)",
	                color: CHAT_THEME.text,
	                borderRadius: 12,
	                padding: "8px 10px",
	                fontWeight: 900,
	                cursor: "pointer",
	              }}
	            >
	              친구비 입금
	            </button>
	            <button
	              type="button"
	              onClick={closeFriendFeeEmptyPopup}
	              style={{
	                border: "none",
	                background: "transparent",
	                color: CHAT_THEME.text,
	                borderRadius: 12,
	                padding: "8px 10px",
	                fontWeight: 800,
	                cursor: "pointer",
	                opacity: 0.9,
	              }}
	            >
	              닫기
	            </button>
	          </div>
	        </div>,
	        document.body
	      )}

          </div>
        </div>
  );
}
