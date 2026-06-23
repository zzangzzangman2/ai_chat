"use client";

import React, { memo, useEffect, useMemo, useState } from "react";
import type { ChatTheme, Msg } from "@/app/components/ChatArea";
import { labelTokenKey } from "@/app/components/chat/utils/tokenUi";

/**
 * 각 assistant 메시지가 "어떤 입력 구성요소"를 참고했는지
 * (usage.tokenBreakdown 기반) 작은 뱃지로 표시한다.
 *
 * v2:
 * - 간단/전체 토글(로컬 저장)
 * - 모바일(좁은 화면)에서 +N 접기
 * - 장기기억/로어북 등 "핵심 소스"는 강조 스타일
 */

type SourceKey =
  | "presetPrompt"
  | "lorebookPrompt"
  | "persona"
  | "userNote"
  | "longMemorySummary"
  | "recentTurns"
  | "systemAndRules"
  | "userInput";

type Mode = "compact" | "all";

type SourceBadgeDef = {
  key: SourceKey;
  icon: string;
  short: string;
  // (UI) 항상 노출할지 여부
  always?: boolean;
  // (UI) 강조 표시할지 여부
  strong?: boolean;
};

const BASE_BADGES: SourceBadgeDef[] = [
  { key: "presetPrompt", icon: "🧩", short: "제작", always: true },
  { key: "recentTurns", icon: "💬", short: "최근", always: true },
  { key: "longMemorySummary", icon: "🧠", short: "장기", strong: true },
  { key: "lorebookPrompt", icon: "📚", short: "로어", strong: true },
  { key: "userNote", icon: "📝", short: "노트" },
  { key: "persona", icon: "👤", short: "페르소나" },
];

const ALL_EXTRA_BADGES: SourceBadgeDef[] = [
  { key: "systemAndRules", icon: "📏", short: "규칙" },
  { key: "userInput", icon: "↩️", short: "입력" },
];

const STORAGE_KEY = "ui:sourceBadgesMode";
const MODE_EVENT = "ui:sourceBadgesModeChanged";

function safeNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}m`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(Math.round(n));
}

function readMode(): Mode {
  try {
    if (typeof window === "undefined") return "compact";
    const raw = String(window.localStorage?.getItem(STORAGE_KEY) || "").trim().toLowerCase();
    return raw === "all" ? "all" : "compact";
  } catch {
    return "compact";
  }
}

function writeMode(mode: Mode) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage?.setItem(STORAGE_KEY, mode);
      window.dispatchEvent(new Event(MODE_EVENT));
    }
  } catch {
    // ignore
  }
}

function useNarrow(breakpointPx = 520): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const apply = () => setNarrow(Boolean(mq.matches));
    apply();
    // Safari fallback
    const add = (mq as any).addEventListener ? "addEventListener" : "addListener";
    const remove = (mq as any).removeEventListener ? "removeEventListener" : "removeListener";
    (mq as any)[add]("change", apply);
    return () => (mq as any)[remove]("change", apply);
  }, [breakpointPx]);

  return narrow;
}

export const SourceBadges = memo(function SourceBadges(props: {
  m: Msg;
  theme: ChatTheme;
  onOpenTokenInfo?: (m: Msg, anchorEl?: HTMLElement | null) => void;
}) {
  const { m, theme, onOpenTokenInfo } = props;

  const clickable = typeof onOpenTokenInfo === "function";
  const isNarrow = useNarrow(520);

  const [mode, setMode] = useState<Mode>(() => readMode());
  const [expanded, setExpanded] = useState(false);

  // 다른 메시지의 토글과 동기화(같은 탭 내)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMode = () => setMode(readMode());
    window.addEventListener(MODE_EVENT, onMode);
    return () => window.removeEventListener(MODE_EVENT, onMode);
  }, []);

  // 화면이 넓어지면 펼침 상태를 자연스럽게 리셋
  useEffect(() => {
    if (!isNarrow) setExpanded(false);
  }, [isNarrow]);

  const items = useMemo(() => {
    const breakdown = m.usage?.tokenBreakdown;
    if (!breakdown) return [] as Array<{ def: SourceBadgeDef; n: number }>;

    const defs = mode === "all" ? [...BASE_BADGES, ...ALL_EXTRA_BADGES] : BASE_BADGES;
    const out: Array<{ def: SourceBadgeDef; n: number }> = [];

    for (const def of defs) {
      const n = safeNum((breakdown as any)[def.key]);
      if (def.always) {
        if (n > 0) out.push({ def, n });
      } else {
        if (n > 0) out.push({ def, n });
      }
    }

    return out;
  }, [m.usage?.tokenBreakdown, mode]);

  if (!items || items.length === 0) return null;

  // (mobile) 접기
  const maxCompact = mode === "all" ? 4 : 3;
  const canCollapse = isNarrow && items.length > maxCompact;
  const shown = canCollapse && !expanded ? items.slice(0, maxCompact) : items;
  const hiddenCount = canCollapse && !expanded ? items.length - shown.length : 0;

  const toggleLabel = mode === "all" ? "전체" : "간단";
  const toggleTitle = mode === "all" ? "간단 표시로 전환" : "전체(규칙/입력 포함) 표시";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        margin: "2px 0 8px",
        userSelect: "none",
      }}
    >
      <button
        type="button"
        title={toggleTitle}
        onClick={() => {
          const next: Mode = mode === "all" ? "compact" : "all";
          setMode(next);
          writeMode(next);
          setExpanded(false);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          borderRadius: 999,
          border: `1px solid ${theme.border}`,
          background: "rgba(255,255,255,0.02)",
          color: theme.muted,
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 900,
          lineHeight: 1.2,
        }}
      >
        <span style={{ opacity: 0.75 }}>참고</span>
        <span
          style={{
            padding: "1px 6px",
            borderRadius: 999,
            border: `1px solid ${theme.border}`,
            background: "rgba(255,255,255,0.04)",
            color: theme.text,
            fontWeight: 900,
            fontSize: 10,
          }}
        >
          {toggleLabel}
        </span>
      </button>

      {shown.map(({ def, n }) => {
        const title = `${labelTokenKey(def.key)} · ${n.toLocaleString("ko-KR")} (입력 토큰 배분)`;
        const isStrong = Boolean(def.strong);
        const showNumber = mode === "all"; // 전체 모드에서 숫자 표시

        return (
          <button
            key={def.key}
            type="button"
            title={title}
            onClick={
              clickable
                ? (e) => onOpenTokenInfo?.(m, e.currentTarget)
                : undefined
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              borderRadius: 999,
              border: `1px solid ${isStrong ? theme.borderStrong : theme.border}`,
              background: isStrong ? theme.panel : "rgba(255,255,255,0.04)",
              color: theme.text,
              cursor: clickable ? "pointer" : "default",
              fontSize: 11,
              fontWeight: 900,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              opacity: isStrong ? 1 : 0.95,
            }}
          >
            <span style={{ filter: isStrong ? "saturate(1.15)" : "saturate(1.05)" }}>{def.icon}</span>
            <span>{def.short}</span>
            {showNumber ? (
              <span style={{ opacity: 0.65, fontWeight: 900 }}>{formatCompact(n)}</span>
            ) : null}
          </button>
        );
      })}

      {hiddenCount > 0 ? (
        <button
          type="button"
          title="나머지 참고 항목 펼치기"
          onClick={() => setExpanded(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${theme.border}`,
            background: "rgba(255,255,255,0.04)",
            color: theme.text,
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 900,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            opacity: 0.9,
          }}
        >
          +{hiddenCount}
        </button>
      ) : null}

      {canCollapse && expanded ? (
        <button
          type="button"
          title="접기"
          onClick={() => setExpanded(false)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${theme.border}`,
            background: "rgba(255,255,255,0.02)",
            color: theme.muted,
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 900,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            opacity: 0.8,
          }}
        >
          접기
        </button>
      ) : null}
    </div>
  );
});
