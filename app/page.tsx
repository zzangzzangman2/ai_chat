"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Home, MessageCircle, Wrench, PanelLeft, Settings, ChevronLeft, ChevronRight } from "lucide-react";

const WorkSelectGrid = dynamic(() => import("./components/WorkSelectGrid"), {
  loading: () => <div style={{ minHeight: 240, opacity: 0.65 }}>작품 목록 불러오는 중…</div>,
});

const WorkSelectModal = dynamic(() => import("./components/WorkSelectModal"), {
  loading: () => null,
});

const BannerCarousel = dynamic(() => import("./components/BannerCarousel"), {
  loading: () => null,
});

const ChatArea = dynamic(() => import("./components/ChatArea"), {
  loading: () => <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 12px", opacity: 0.75 }}>채팅 화면 불러오는 중…</div>,
});

const Workspace = dynamic(() => import("./components/Workspace"), {
  loading: () => <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 12px", opacity: 0.75 }}>작업실 불러오는 중…</div>,
});

// NOTE: 이 파일은 UI 구조만 바꾸는 용도입니다.
//       채팅/요약/장기기억/추천/스트리밍 등 서버 기능은 건드리지 않습니다.

export type Preset = {
  id: string;
  name: string;
  characterName: string;
  background?: string;
  desc?: string;
  // Workspace/editor fields
  characterAge?: number;
  character?: string;
  systemPrompt?: string;
  extra?: string;
  image?: string;
  tags?: string;
  // Roster-only story memory: JSON array string (e.g. "[\"미연\",\"천소\"]")
  memoryRoster?: string;
  target?: string;
  gallery?: string;
  firstMessages?: string;
  lorebooks?: string;
  isPublic?: 0 | 1;
  isNsfw?: 0 | 1;
  createdAt?: number;
  updatedAt?: number;
};

type View = "home" | "chat" | "workspace";

type RecentChat = {
  id: string;
  presetId: string;
  presetName: string;
  image?: string;
  createdAt: number;
};

type ContinueChatOption = {
  id: string;
  createdAt: number;
  title: string;
  lastMessage: string;
};

function compactTitle(t: string) {
  return String(t || "").replace(/\s+/g, "");
}

export default function Page() {
  // 홈(작품 선택): 공개 + 내 프리셋
  const [presets, setPresets] = useState<Preset[]>([]);

  const presetNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of presets as any[]) {
      const id = String((p as any)?.id || "");
      if (!id) continue;
      const name = String((p as any)?.name || (p as any)?.characterName || "");
      if (name) map[id] = name;
    }
    return map;
  }, [presets]);

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  // 작업실: 내 프리셋만 (처음 로그인 유저는 0개가 정상)
  const [myPresets, setMyPresets] = useState<Preset[]>([]);
  const [workspacePresetId, setWorkspacePresetId] = useState<string | null>(null);

  // 로그인 상태(작업실용 리스트 갱신 트리거)
  const [meEmail, setMeEmail] = useState<string | null>(null);
  const [meStatus, setMeStatus] = useState<"unknown" | "guest" | "authed">("unknown");
  const [loginGateOpen, setLoginGateOpen] = useState(false);
  const [continueChatOptions, setContinueChatOptions] = useState<ContinueChatOption[]>([]);
  const [latestChatLoaded, setLatestChatLoaded] = useState<boolean>(false);

  // 좌측 메뉴에 보여줄 최근 채팅 리스트(최소 5개)
  const [recentChats, setRecentChats] = useState<RecentChat[]>([]);

  // 좌측 메뉴 접힘/펼침 (기본: 펼침)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Mobile responsive
  const [isMobile, setIsMobile] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setIsMobile(Boolean(mq.matches));
    apply();

    // Safari compatibility
    const onChange = () => apply();
    try {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    } catch {
      mq.addListener(onChange);
      return () => mq.removeListener(onChange);
    }
  }, []);

  // When leaving mobile mode, ensure the mobile drawer is closed.
  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!isMobile) return;
    const prev = document.body.style.overflow;
    if (mobileSidebarOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = prev || "";
    return () => {
      document.body.style.overflow = prev || "";
    };
  }, [isMobile, mobileSidebarOpen]);

  // 홈 진입 체감 속도를 위해, 무거운 화면 번들은 idle 시점에 미리 준비한다.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefetchHeavyViews = () => {
      void import("./components/ChatArea");
      void import("./components/Workspace");
    };

    const w = window as Window & {
      requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(() => prefetchHeavyViews(), { timeout: 2500 });
      return () => {
        if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
      };
    }

    const t = window.setTimeout(prefetchHeavyViews, 1200);
    return () => window.clearTimeout(t);
  }, []);

  const [workModalOpen, setWorkModalOpen] = useState(false);

  // 작업실 카드의 "채팅하기" 버튼은 CustomEvent로 신호를 보냅니다.
  // 홈의 "작품 선택" 모달과 완전히 동일한 UI(이어하기/처음하기)를 띄우기 위해 여기서 수신합니다.
  useEffect(() => {
    const openByPresetId = (presetIdRaw: any) => {
      const presetId = String(presetIdRaw || "");
      if (!presetId) return;
      setSelectedPresetId(presetId);
      setWorkModalOpen(true);
      // Push a history entry so browser Back closes the modal instead of leaving the site.
      pushUiState({ workModalOpen: true, selectedPresetId: presetId }, "push");
    };

    const onOpen = (ev: any) => openByPresetId(ev?.detail?.presetId);
    window.addEventListener("mate:openChatForPreset", onOpen as any);

    // Workspace(제작실)에서 같은 페이지 내 모달을 확실히 열 수 있도록 window 헬퍼도 제공
    // (이벤트가 막히는 환경/브라우저 대비)
    (window as any).__mate_open_work_modal = openByPresetId;

    return () => {
      window.removeEventListener("mate:openChatForPreset", onOpen as any);
      try {
        delete (window as any).__mate_open_work_modal;
      } catch {
        // ignore
      }
    };
  }, []);

  // 진입 시: 항상 작품 선택 화면부터
  const [view, setView] = useState<View>("home");
  const [activeChatId, setActiveChatId] = useState<string>("");
  // 기본 상태는 항상 펼쳐진 좌측 메뉴
  // 좌측 메뉴는 기본 펼침 상태 고정
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In-app back navigation: mirror key UI state to history.state.
  // (This app uses internal view state, so without this the Back button can jump out of the site.)
  const pushUiState = (next: { view?: View; workModalOpen?: boolean; selectedPresetId?: string | null }, mode: "push" | "replace" = "push") => {
    if (typeof window === "undefined") return;
    try {
      const cur = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
      const st = {
        ...cur,
        sjView: typeof next.view === "string" ? next.view : (cur as any).sjView,
        sjWorkModalOpen: typeof next.workModalOpen === "boolean" ? next.workModalOpen : (cur as any).sjWorkModalOpen,
        sjSelectedPresetId:
          typeof next.selectedPresetId === "string"
            ? next.selectedPresetId
            : next.selectedPresetId === null
            ? null
            : (cur as any).sjSelectedPresetId,
      };
      if (mode === "replace") window.history.replaceState(st, "", window.location.href);
      else window.history.pushState(st, "", window.location.href);
    } catch {
      // ignore
    }
  };

  const goView = (nextView: View, mode: "push" | "replace" = "push") => {
    setView(nextView);
    // view 전환 시 모달은 닫는다.
    setWorkModalOpen(false);
    // mobile: close drawer
    setMobileSidebarOpen(false);
    pushUiState({ view: nextView, workModalOpen: false }, mode);
  };

  const selectedPreset = useMemo(() => {
    if (!selectedPresetId) return null;
    return presets.find((p) => p.id === selectedPresetId) || myPresets.find((p) => p.id === selectedPresetId) || null;
  }, [presets, myPresets, selectedPresetId]);

  const homePresets = presets;

const THEME = useMemo(
  () => ({
    // Global background is driven by CSS vars in globals.css
    bg: "var(--app-bg)",
    panel: "rgba(255,255,255,0.04)",
    panel2: "rgba(255,255,255,0.06)",
    border: "rgba(255,255,255,0.14)",
    borderSoft: "rgba(255,255,255,0.10)",
    text: "#e9eefc",
    muted: "rgba(233,238,252,0.72)",
  }),
  []
);

const handleUpdatePreset = async (p: Preset) => {
  // 입력 중 자동 저장(POST) 금지: 변경 사항은 로컬 상태에만 반영하고,
  // 실제 저장은 Workspace 하단 고정 "캐릭터 생성/수정" 버튼에서만 1회 수행한다.
  const patch = (prev: Preset[]) => {
    const i = prev.findIndex((it) => it.id === p.id);
    if (i >= 0) {
      const next = prev.slice();
      next[i] = { ...next[i], ...p };
      return next;
    }
    // 새 프리셋 생성 케이스: 리스트 상단에 추가
    return [p, ...prev];
  };

  // 작업실(내 프리셋)과 홈(공개+내 프리셋) 양쪽 상태를 함께 갱신
  setMyPresets(patch);
  setPresets(patch);

  // 선택 유지: 작업실에서 새로 만든 경우를 대비
  if (!workspacePresetId) setWorkspacePresetId(p.id);
  if (!selectedPresetId) setSelectedPresetId(p.id);
};

const handleDeletePreset = async (id: string) => {
  const res = await fetch("/api/preset/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());

  setMyPresets((prev) => prev.filter((x) => x.id !== id));
  setPresets((prev) => prev.filter((x) => x.id !== id));

  setWorkspacePresetId((cur) => (cur === id ? null : cur));
  setSelectedPresetId((cur) => (cur === id ? null : cur));
};



// 로그인 상태 확인(비로그인에서 채팅/작업실 진입을 막기 위함)
const refreshMe = async (): Promise<string> => {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json().catch(() => ({} as any));
    const email = typeof (data as any)?.user?.email === "string" ? String((data as any).user.email) : (typeof (data as any)?.email === "string" ? String((data as any).email) : "");
    setMeEmail(email);
    setMeStatus(email ? "authed" : "guest");
    return email;
  } catch {
    setMeEmail("");
    setMeStatus("guest");
    return "";
  }
};

// 초기 마운트 시 로그인 상태를 먼저 확정한다.
useEffect(() => {
  void refreshMe();

  // Ensure the current page has an initial UI state in history, and make Back/Forward
  // restore our internal view/modal state instead of jumping out of the site.
  if (typeof window !== "undefined") {
    try {
      // First entry for this tab/session should be home with modal closed.
      const cur = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
      window.history.replaceState(
        {
          ...cur,
          sjView: (cur as any).sjView || "home",
          sjWorkModalOpen: Boolean((cur as any).sjWorkModalOpen),
          sjSelectedPresetId: typeof (cur as any).sjSelectedPresetId === "string" ? (cur as any).sjSelectedPresetId : null,
        },
        "",
        window.location.href
      );
    } catch {
      // ignore
    }

    const onPop = (ev: PopStateEvent) => {
      try {
        const st: any = ev.state || {};
        const v = st.sjView as View | undefined;
        if (v === "home" || v === "chat" || v === "workspace") {
          setView(v);
        } else {
          setView("home");
        }

        const open = Boolean(st.sjWorkModalOpen);
        setWorkModalOpen(open);

        if (typeof st.sjSelectedPresetId === "string") setSelectedPresetId(st.sjSelectedPresetId);
        else if (st.sjSelectedPresetId === null) setSelectedPresetId(null);
      } catch {
        // ignore
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

const refreshRecentChats = async () => {
  let email = meEmail || "";
  if (!email && meStatus === "unknown") {
    email = await refreshMe();
  }
  if (!email) {
    setRecentChats([]);
    return;
  }
  try {
    const r = await fetch("/api/chat/recent?limit=5", { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json().catch(() => ({} as any));
    const items = Array.isArray((j as any)?.items) ? (j as any).items : [];
    setRecentChats(
      items
        .filter((x: any) => x && typeof x.id === "string")
        .map((x: any) => ({
          id: String(x.id),
          presetId: String(x.presetId || ""),
          presetName: String(presetNameById[String(x.presetId || "")] || x.presetName || x.title || "채팅"),
          image: typeof x.image === "string" ? String(x.image) : undefined,
          createdAt:
            typeof x.createdAt === "number"
              ? x.createdAt
              : typeof x.updatedAt === "string" && /^\d+$/.test(x.updatedAt)
              ? Number(x.updatedAt)
              : Date.now(),
        }))
    );
  } catch {
    // 메뉴는 부가 기능: 실패해도 화면 전체를 깨지지 않게
    setRecentChats([]);
  }
}

// Sidebar collapse persistence
useEffect(() => {
  if (typeof window === "undefined") return;
  try {
    const v = window.localStorage.getItem("sj:sidebarCollapsed");
    if (v === "1") setSidebarCollapsed(true);
  } catch {}
}, []);

useEffect(() => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("sj:sidebarCollapsed", sidebarCollapsed ? "1" : "0");
  } catch {}
}, [sidebarCollapsed]);

;

// Ensure logout clears any cached auth state immediately
useEffect(() => {
  const handler = () => {
    setMeEmail("");
    setMeStatus("guest");
    setLoginGateOpen(false);
    goView("home", "replace");
  };
  window.addEventListener("sj:logout", handler);
  return () => window.removeEventListener("sj:logout", handler);
}, []);

// 비로그인 상태에서 chat/workspace로 마운트 자체를 막아서
// unauthorized 토스트(설정 저장 실패 등)가 먼저 뜨는 현상을 방지한다.
const requireLoginThen = async (next: View, mode: "push" | "replace" = "push") => {
  let email = meEmail || "";
  // If auth state is unknown OR we previously evaluated as guest, re-check once.
  // This allows immediate access after a fresh login without requiring a hard refresh.
  if (meStatus === "unknown" || !email) {
    email = await refreshMe();
  }
  if (!email) {
    setLoginGateOpen(true);
    // view 전환은 하지 않는다(마운트 차단)
    return;
  }
  setLoginGateOpen(false);
  goView(next, mode);
};

// Local mode: old friend-fee charge events should just return to chat.
useEffect(() => {
  if (typeof window === "undefined") return;
  const onOpen = () => {
    void requireLoginThen("chat");
  };
  window.addEventListener("mate:openFriendFeePage", onOpen as any);
  return () => window.removeEventListener("mate:openFriendFeePage", onOpen as any);
  // requireLoginThen은 컴포넌트 내부 함수지만, 의존성에 넣으면 리스너가 과도하게 재등록될 수 있어
  // 여기서는 현재 렌더 기준의 함수 참조로 충분하다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// 로그인 상태가 바뀌면 좌측 최근 채팅을 갱신한다.
useEffect(() => {
  if (meStatus === "unknown") return;
  void refreshRecentChats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [meStatus, meEmail]);

useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch("/api/preset/list?view=home");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json().catch(() => ({} as any));
      const list: Preset[] = Array.isArray((data as any)?.presets) ? (data as any).presets : [];
      if (cancelled) return;
      setPresets(list);
      if (!selectedPresetId && list.length > 0) setSelectedPresetId(list[0].id);
    } catch (e: any) {
      if (cancelled) return;
      setPresets([]);
      setError(e?.message || "프리셋 목록을 불러오지 못했습니다.");
    }
  })();
  return () => {
    cancelled = true;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// 작업실(내 프리셋) 로드: 로그인 계정의 것만
useEffect(() => {
  let cancelled = false;
  (async () => {
    // 홈/채팅 진입 시에는 작업실 전용 목록을 불러오지 않는다.
    if (view !== "workspace") return;

    let email = meEmail || "";
    if (meStatus === "unknown") {
      email = await refreshMe();
    }

    // 비로그인 상태에선 작업실은 빈 리스트가 정상
    if (!email) {
      setMyPresets([]);
      setWorkspacePresetId(null);
      return;
    }

    try {
      const res = await fetch("/api/preset/list?scope=mine", { cache: "no-store" });
      const data = await res.json().catch(() => ({} as any));
      const list: Preset[] = Array.isArray((data as any)?.presets) ? (data as any).presets : [];
      if (cancelled) return;
      setMyPresets(list);
      if (!workspacePresetId && list.length > 0) setWorkspacePresetId(list[0].id);
      if (list.length === 0) setWorkspacePresetId(null);
    } catch {
      if (cancelled) return;
      setMyPresets([]);
      setWorkspacePresetId(null);
    }
  })();
  return () => {
    cancelled = true;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [view, meEmail, meStatus]);

  // 선택된 프리셋의 이어하기 채팅(최대 3개) 로드
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 모달을 실제로 열었을 때만 조회 (초기 로딩 네트워크 절약)
      if (!workModalOpen || !selectedPresetId) {
        setContinueChatOptions([]);
        setLatestChatLoaded(false);
        return;
      }
      setLatestChatLoaded(false);
      try {
        const res = await fetch(`/api/chat/list?presetId=${encodeURIComponent(selectedPresetId)}&limit=3`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (cancelled) return;
        const chats = Array.isArray(data?.chats) ? data.chats : [];
        setContinueChatOptions(
          chats
            .map((c: any) => ({
              id: String(c?.id || ""),
              createdAt: Number(c?.createdAt || 0),
              title: String(c?.title || ""),
              lastMessage: String(c?.lastMessage || ""),
            }))
            .filter((c: ContinueChatOption) => !!c.id)
            .slice(0, 3)
        );
        setLatestChatLoaded(true);
      } catch {
        if (cancelled) return;
        setContinueChatOptions([]);
        setLatestChatLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPresetId, workModalOpen]);

  const openContinueChat = (chatId: string) => {
    const targetChatId = String(chatId || "").trim();
    if (!targetChatId || !selectedPresetId) return;
    try {
      window.localStorage.removeItem("forceNewChatPresetId");
      window.localStorage.setItem("forceOpenChatPresetId", selectedPresetId);
      window.localStorage.setItem("forceOpenChatId", targetChatId);
    } catch {
      // ignore
    }
    setWorkModalOpen(false);
    pushUiState({ workModalOpen: false }, "replace");
    void requireLoginThen("chat", "replace");
  };

  const deleteContinueChatOption = async (chatId: string) => {
    const targetChatId = String(chatId || "").trim();
    if (!targetChatId) return;
    const ok = typeof window === "undefined" ? false : window.confirm("이 이어하기 채팅을 삭제할까요?");
    if (!ok) return;
    try {
      const res = await fetch("/api/chat/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: targetChatId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "채팅 삭제 실패");
      setContinueChatOptions((prev) => prev.filter((c) => c.id !== targetChatId));
      if (activeChatId === targetChatId) setActiveChatId("");
      void refreshRecentChats();
    } catch (e: any) {
      alert(e?.message || "채팅 삭제 실패");
    }
  };

  // 상단 좌측 제목은 '채팅' 화면에서만 표시 (작업실/홈/친구비 등 다른 화면에서는 숨김)
  const workTitle = view === "chat" ? compactTitle(selectedPreset?.name || "채팅") : "";

  // Desktop docked sidebar width (mobile uses drawer)
  const dockedSidebarWidth = isMobile ? 0 : sidebarCollapsed ? 72 : 320;
  const sidebarCollapsedUI = isMobile ? false : sidebarCollapsed;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--app-bg)",
        color: "var(--foreground)",
      }}
    >
      <style jsx global>{`
        /* 메시지 스크롤바: 화면 우측에 자연스럽게, 배경과 비슷한 톤 */
        .chat-scroll {
          scrollbar-color: rgba(255,255,255,0.18) rgba(0,0,0,0.2);
        }
        .chat-scroll::-webkit-scrollbar {
          width: 10px;
        }
        .chat-scroll::-webkit-scrollbar-track {
          background: rgba(0,0,0,0.2);
        }
        .chat-scroll::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.16);
          border-radius: 999px;
          border: 2px solid rgba(0,0,0,0.25);
        }
        .chat-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.24);
        }
      `}</style>

      {/* Top bar */}
      <div
        style={{
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 14px",
          // 사이드바가 fixed로 덮지 않도록 Top bar를 사이드바 폭만큼 오른쪽으로 밀고 폭을 줄인다.
          marginLeft: dockedSidebarWidth,
          width: `calc(100% - ${dockedSidebarWidth}px)`,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          position: "sticky",
          top: 0,
          background: "rgba(26,27,27,0.92)",
          backdropFilter: "blur(10px)",
          // NOTE: 상단바가 사이드바(zIndex 60) 뒤로 숨는 케이스가 있어(특히 '이어하기' 직후/초기 진입)
          // 항상 상단바가 우선 보이도록 zIndex를 올린다.
          zIndex: 80,
        }}
      >
	      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: isMobile ? 0 : 120, flex: "1 1 auto" }}>
            {isMobile && (
              <button
                type="button"
                aria-label="메뉴 열기"
                onClick={() => setMobileSidebarOpen(true)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)",
                  color: "#e9eefc",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <PanelLeft size={18} />
              </button>
            )}
	        {view === "chat" ? (
				<div style={{ fontWeight: 800, letterSpacing: "0.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
				  {workTitle}
				</div>
			) : (
				<button
					type="button"
					onClick={() => goView("home")}
					aria-label="홈으로 이동"
					title="홈으로"
					style={{
						border: "none",
						background: "transparent",
						color: "#e9eefc",
						cursor: "pointer",
						padding: 0,
						display: "inline-flex",
						alignItems: "center",
						minWidth: 0,
					}}
				>
						<div
							style={{
								fontWeight: 950,
								letterSpacing: "0.2px",
								lineHeight: 1.1,
								backgroundImage: "var(--arca-grad)",
								WebkitBackgroundClip: "text",
								color: "transparent",
								textShadow: "0 0 18px var(--arca-glow)",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							Arca
						</div>
				</button>
			)}
	      </div>

	      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: isMobile ? 0 : 200, justifyContent: "flex-end", flex: "0 0 auto" }}>
	        {view === "chat" && (
	          <button
	            type="button"
	            onClick={() => setSettingsOpen(true)}
	            aria-label="설정 열기"
	            title="설정"
	            style={{
	              width: 36,
	              height: 36,
	              borderRadius: 12,
	              border: "none",
	              background: "transparent",
	              color: "#e9eefc",
	              cursor: "pointer",
	            }}
	          >
	            <Settings size={18} />
	          </button>
	        )}
        </div>
      </div>

      {/* Mobile drawer backdrop */}
      {isMobile && mobileSidebarOpen && (
        <div
          aria-hidden
          onClick={() => setMobileSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            // 상단바는 가려지지 않도록(backdrop < topbar)
            zIndex: 70,
          }}
        />
      )}

      {/* Left menu (항상 펼쳐진 상태) */}
      <aside
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: isMobile ? 320 : sidebarCollapsed ? 72 : 320,
          background: "var(--app-bg)",
          borderRight: "1px solid rgba(255,255,255,0.10)",
          // Desktop에서는 상단바가 항상 위(80)로 오게 하고,
          // Mobile drawer에서는 사이드바가 상단바 위로 올라오게 한다.
          zIndex: isMobile ? 90 : 60,
          padding: isMobile ? 14 : sidebarCollapsedUI ? 10 : 14,
          // collapsed일 때는 상단 토글 버튼 영역만 확보하고(로고/배너는 표시하지 않음)
          paddingTop: isMobile ? 64 : sidebarCollapsedUI ? 52 : 14,
          overflow: "auto",
          transform: isMobile ? (mobileSidebarOpen ? "translateX(0)" : "translateX(-110%)") : "none",
          transition: isMobile ? "transform 180ms ease" : undefined,
          boxShadow: isMobile ? "10px 0 30px rgba(0,0,0,0.45)" : undefined,
        }}
      >
        {/* Desktop collapse toggle / Mobile close */}
        {isMobile ? (
          <button
            type="button"
            aria-label="메뉴 닫기"
            onClick={() => setMobileSidebarOpen(false)}
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              width: 34,
              height: 34,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.04)",
              color: "#e9eefc",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              fontSize: 16,
            }}
          >
            ✕
          </button>
        ) : (
          <button
            type="button"
            aria-label={sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
            onClick={() => setSidebarCollapsed((v) => !v)}
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: 32,
              height: 32,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.04)",
              color: "#e9eefc",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        )}

        {/* Brand (사이드바에는 이미 홈 버튼이 있으므로, collapsed일 땐 별도 배너/로고 표시를 하지 않음) */}
        {!sidebarCollapsedUI && (
          <div style={{ padding: "12px 44px 10px 10px" }}>
            <div
              style={{
                fontWeight: 950,
                fontSize: 18,
                letterSpacing: "0.2px",
                color: "#e9eefc",
              }}
            >
              Arca
            </div>
          </div>
        )}

        {/* Nav */}
        <div style={{ display: "grid", gap: sidebarCollapsedUI ? 12 : 10, marginTop: sidebarCollapsedUI ? 8 : 6 }}>
          <button
            type="button"
            onClick={() => goView("home")}
            aria-label="홈"
            title={sidebarCollapsedUI ? "홈" : undefined}
            style={navBtnStyle(view === "home", sidebarCollapsedUI)}
          >
            <span style={{ display: "inline-flex", width: 22, justifyContent: "center" }}>
              <Home size={18} />
            </span>
            {!sidebarCollapsedUI && "홈"}
          </button>
          <button
            type="button"
            onClick={() => void requireLoginThen("chat")}
            aria-label="채팅"
            title={sidebarCollapsedUI ? "채팅" : undefined}
            style={navBtnStyle(view === "chat", sidebarCollapsedUI)}
          >
            <span style={{ display: "inline-flex", width: 22, justifyContent: "center" }}>
              <MessageCircle size={18} />
            </span>
            {!sidebarCollapsedUI && "채팅"}
          </button>
          <button
            type="button"
            onClick={() => void requireLoginThen("workspace")}
            aria-label="작업실"
            title={sidebarCollapsedUI ? "작업실" : undefined}
            style={navBtnStyle(view === "workspace", sidebarCollapsedUI)}
          >
            <span style={{ display: "inline-flex", width: 22, justifyContent: "center" }}>
              <Wrench size={18} />
            </span>
            {!sidebarCollapsedUI && "작업실"}
          </button>
        </div>

        {/* Recent */}
        <div style={{ marginTop: 28, opacity: 0.9, fontSize: 13, display: "flex", flexDirection: "column", alignItems: "stretch" }}>
          {!sidebarCollapsedUI && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, width: "100%" }}>

              <span>최근 채팅</span>
          <button
            type="button"
            onClick={() => void refreshRecentChats()}
            style={{
              border: "none",
              background: "transparent",
              color: "rgba(233,238,252,0.75)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            새로고침
          </button>
        </div>

        <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
          {!meEmail && (
            <div style={{ fontSize: 12, opacity: 0.7, padding: "10px 6px" }}>로그인 후 최근 채팅이 표시됩니다.</div>
          )}

          {!!meEmail && recentChats.length === 0 && (
            <div style={{ fontSize: 12, opacity: 0.7, padding: "10px 6px" }}>최근 채팅이 없습니다.</div>
          )}

          {recentChats.map((c) => {
            const recentTitle = presetNameById[String(c.presetId || "")] || c.presetName || "채팅";
            return (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setSelectedPresetId(c.presetId);
                void requireLoginThen("chat");
              }}
              style={{
                width: "100%",
                display: "flex",
                gap: 10,
                alignItems: "center",
                textAlign: "left",
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 16,
                padding: 10,
                overflow: "hidden",
                minWidth: 0,
                cursor: "pointer",
                color: "#e9eefc",
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 58,
                  height: 58,
                  borderRadius: 14,
                  overflow: "hidden",
                  background: "linear-gradient(145deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04))",
                  border: "1px solid rgba(255,255,255,0.10)",
                  flex: "0 0 auto",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 15,
                  fontWeight: 950,
                }}
              >
                {c.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.image}
                    alt=""
                    loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                ) : (
                  <span>{recentTitle.slice(0, 1)}</span>
                )}
              </div>
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                {/*
                  긴 제목은 1줄 + ... 처리 (flex 환경에서 ellipsis가 확실히 먹도록 maxWidth/minWidth 보강)
                */}
                <div
                  style={{
                    fontWeight: 900,
                    fontSize: 14,
                    lineHeight: 1.25,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "block",
                    width: "100%",
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                >
                  {(presetNameById[String(c.presetId || "")] || c.presetName || "채팅")}
                </div>
              </div>
            </button>
            );
          })}
        </div>
          </>
        )}

        </div>

      </aside>

      {/* Main */}
      <div style={{ padding: view === "chat" && isMobile ? "0 0 14px" : "18px 14px 28px", marginLeft: dockedSidebarWidth }}>
        {error && (
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto 16px",
              border: "1px solid rgba(255,120,120,0.25)",
              background: "rgba(255,120,120,0.08)",
              borderRadius: 16,
              padding: 12,
              color: "#ffd6d6",
              fontWeight: 700,
            }}
          >
            {error}
          </div>
        )}

		{view === "chat" && meStatus === "authed" && (
			<ChatArea
              presetId={selectedPresetId}
              presets={presets as any}
              onChangePreset={(id) => setSelectedPresetId(id)}
              onChatIdChange={(id) => setActiveChatId(id)}
              settingsUiMode="drawer"
              hideSettingsToggle
              layoutKey={dockedSidebarWidth}
              externalSettingsOpen={settingsOpen}
              onExternalSettingsOpenChange={setSettingsOpen}
			/>
		)}
        {view === "workspace" && meStatus === "authed" && (
          <div style={{ maxWidth: 1100, margin: "0 auto" }}>
            <Workspace
              theme={THEME as any}
              // 작업실은 "내 프리셋만" 보여야 함 (처음 로그인 유저면 빈 리스트가 정상)
              presets={myPresets as any}
              selectedPresetId={workspacePresetId}
              onSelectPreset={(id) => setWorkspacePresetId(id)}
              onUpdatePreset={handleUpdatePreset as any}
              onDeletePreset={handleDeletePreset as any}
            />
          </div>
        )}

{view === "home" && (
          <div style={{ maxWidth: 1100, margin: "0 auto" }}>
            <BannerCarousel height={isMobile ? 148 : 220} />
            <WorkSelectGrid
              presets={homePresets}
              selectedPresetId={selectedPresetId}
              onSelect={(id) => {
                setSelectedPresetId(id);
                setWorkModalOpen(true);
                pushUiState({ workModalOpen: true, selectedPresetId: id }, "push");
              }}
            />
          </div>
        )}
      </div>

      {/* Work select modal (global) */}
      <WorkSelectModal
        open={workModalOpen}
        onClose={() => {
          // If the modal was opened via a pushed history entry, Back should close it.
          try {
            const st: any = typeof window !== "undefined" ? window.history.state : null;
            if (st && st.sjWorkModalOpen) {
              window.history.back();
              return;
            }
          } catch {
            // ignore
          }
          setWorkModalOpen(false);
          pushUiState({ workModalOpen: false }, "replace");
        }}
        preset={selectedPreset}
        latestChatLoaded={latestChatLoaded}
        continueChats={continueChatOptions}
        onContinueChat={openContinueChat}
        onDeleteContinueChat={deleteContinueChatOption}
        onNew={() => {
          // ChatArea의 기존 로직(강제 새 채팅 플래그)을 그대로 사용한다.
          try {
            window.localStorage.removeItem("forceOpenChatPresetId");
            window.localStorage.removeItem("forceOpenChatId");
            if (selectedPresetId) {
              window.localStorage.setItem("forceNewChatPresetId", selectedPresetId);
            }
          } catch {
            // ignore
          }
          setWorkModalOpen(false);
          pushUiState({ workModalOpen: false }, "replace");
          void requireLoginThen("chat", "replace");
        }}
      />


{/* Login gate (full-screen) */}
{loginGateOpen && (
  <div
    role="dialog"
    aria-modal="true"
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 200,
      background: "rgba(26,27,27,0.92)",
      backdropFilter: "blur(10px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    }}
    onMouseDown={(e) => {
      // 바깥 클릭으로 닫히지 않게(게이트)
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    <div
      style={{
        width: "min(720px, 96vw)",
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(255,255,255,0.04)",
        borderRadius: 22,
        padding: 18,
        boxShadow: "none",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "10px 0 6px" }}>
        <div style={{ fontSize: 30, fontWeight: 950, letterSpacing: "-0.5px", backgroundImage: "var(--arca-grad)", WebkitBackgroundClip: "text", color: "transparent", textShadow: "0 0 22px var(--arca-glow)" }}>Arca</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>계속하려면 로그인이 필요합니다.</div>
      </div>

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
            border: "none",
            background: "var(--arca-grad-soft)",
            color: "#e9eefc",
            textDecoration: "none",
            fontWeight: 900,
          }}
        >
          Google로 계속하기
        </a>
      </div>

      <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}>
        <button
          type="button"
          onClick={() => setLoginGateOpen(false)}
          style={{
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.04)",
            color: "rgba(233,238,252,0.85)",
            borderRadius: 14,
            padding: "10px 12px",
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          닫기
        </button>
      </div>
    </div>
  </div>
)}

    </div>
  );
}

function navBtnStyle(active: boolean, collapsed: boolean): React.CSSProperties {
  return {
    width: "100%",
    textAlign: collapsed ? "center" : "left",
    border: active ? "1px solid rgba(176,126,255,0.50)" : "1px solid rgba(255,255,255,0.12)",
    background: active ? "var(--arca-grad-weak)" : "rgba(255,255,255,0.03)",
    boxShadow: active ? "0 0 0 1px rgba(92,211,255,0.12), 0 10px 24px rgba(0,0,0,0.35)" : undefined,
    transition: "background 160ms ease, border-color 160ms ease, box-shadow 160ms ease",
    color: "#e9eefc",
    borderRadius: 16,
    padding: collapsed ? "10px" : "12px 12px",
    cursor: "pointer",
    fontWeight: 800,
    display: "flex",
    alignItems: "center",
    justifyContent: collapsed ? "center" : "flex-start",
    gap: collapsed ? 0 : 10,
  };
}
