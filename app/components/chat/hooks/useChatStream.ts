"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type UseChatStreamPacerOptions<T extends { id: string; content: string }> = {
  setMessages: React.Dispatch<React.SetStateAction<T[]>>;
  scrollToBottomIfAllowed: () => void;
  /** Return current render mode (e.g. "chat" | "novel"). Defaults to "novel". */
  getRenderMode?: () => string | undefined;
};

export type UseChatStreamPacerResult<T extends { id: string; content: string }> = {
  // streaming state (UI)
  prebufferUiActive: boolean;
  prebufferSec: number;
  prebufferDots: string;
  stallUiActive: boolean;
  setStallUiActive: React.Dispatch<React.SetStateAction<boolean>>;

  // streaming refs (read/write from caller)
  streamTargetRef: React.MutableRefObject<string>;
  streamShownRef: React.MutableRefObject<string>;
  streamTempAssistantIdRef: React.MutableRefObject<string>;
  streamLastDeltaAtRef: React.MutableRefObject<number>;
  streamLastPingAtRef: React.MutableRefObject<number>;
  streamHasDeltaRef: React.MutableRefObject<boolean>;

  // controls
  startStreamPacer: (tempAssistantId: string) => void;
  stopStreamPacer: (opts?: { flush?: boolean }) => void;
};

/**
 * UI-only stream pacer:
 * - Server NDJSON deltas can arrive in bursts.
 * - This hook smooths rendering by maintaining a small backlog and emitting
 *   chunks at a steady cadence.
 */
export function useChatStreamPacer<T extends { id: string; content: string }>(
  opts: UseChatStreamPacerOptions<T>
): UseChatStreamPacerResult<T> {
  const { setMessages, scrollToBottomIfAllowed, getRenderMode } = opts;

  // --- Stream pacer (UI only): 서버 델타(불규칙) → 화면 표출(규칙/부드러움)로 변환 ---
  // Gemini 3 Pro 계열은 "묶음 생성 → 묶음 방출" 성향이 강해서, 그대로 뿌리면 "멈춤→쏟아짐" 체감이 커진다.
  // 그래서 UI에서는 작은 조각으로 균일하게 흘려보내는 'artificial stream'을 더 적극적으로 적용한다.
  // 40ms(≈25fps)에서는 "툭툭 끊기는" 느낌이 날 수 있어 16ms(≈60fps)로 더 부드럽게 표출한다.
  const STREAM_PACE_MS = 16;
  // 16ms 기준(≈60fps) 기본 속도: 6 chars/tick ≈ 375 chars/sec (기존 14/40ms ≈ 350 chars/sec와 유사)
  const STREAM_CHARS_PER_TICK = 6;
  // (추가) 프리버퍼 + backlog 유지: '멈췄다 한 번에 쏟아짐' 완화
  const STREAM_PREBUFFER_CHARS = 240; // 첫 출력 시작 전 최소 누적 문자수(너무 길면 체감 멈춤이 커짐)
  const STREAM_TARGET_BACKLOG = 180; // 스트리밍 중에는 항상 이 정도 뒤처지게(버퍼 고갈 방지)
  const STREAM_MIN_PREBUFFER_UI_MS = 700; // prebuffer 배지 최소 노출 시간
  const STREAM_IDLE_FLUSH_MS = 280; // 이 시간 이상 델타가 없으면 backlog 제한을 풀고 남은 버퍼를 끝까지 출력

  // prebuffer 표시/해제 판단용: 공백/제로폭 문자만 있는 경우를 '비어있음'으로 취급
  function isEffectivelyEmptyForPrebuffer(s: string): boolean {
    const t = String(s || "").replace(/[\s\u200b\u200c\u200d\uFEFF]/g, "");
    return t.length === 0;
  }

  const streamLastDeltaAtRef = useRef<number>(0);
  const streamLastPingAtRef = useRef<number>(0);
  const streamHasDeltaRef = useRef<boolean>(false);

  // (UI) 프리버퍼 구간에만 '생각 중...' 배지 표시
  const [prebufferUiActive, setPrebufferUiActive] = useState(false);
  const [stallUiActive, setStallUiActive] = useState(false);
  const prebufferUiActiveRef = useRef(false);
  const prebufferStartRef = useRef<number>(0);
  const [prebufferSec, setPrebufferSec] = useState(0);
  const [prebufferDots, setPrebufferDots] = useState("");

  // interval 내부(클로저)에서 최신 prebufferUiActive를 읽기 위한 ref (deps/TDZ 문제 회피)
  useEffect(() => {
    prebufferUiActiveRef.current = prebufferUiActive;
  }, [prebufferUiActive]);

  const streamTargetRef = useRef<string>("");
  const streamShownRef = useRef<string>("");
  const streamTempAssistantIdRef = useRef<string>("");
  const streamPaceTimerRef = useRef<number | null>(null);
  const lastAutoScrollAtRef = useRef<number>(0);
  const streamLastAutoScrollAtRef = useRef<number>(0);

  const startStreamPacer = useCallback(
    (tempAssistantId: string) => {
      streamTempAssistantIdRef.current = tempAssistantId;
      streamTargetRef.current = "";
      streamShownRef.current = "";

      // prebuffer UI ON (shown until first visible token is rendered)
      prebufferStartRef.current = Date.now();
      setPrebufferSec(1);
      setPrebufferDots("");
      setPrebufferUiActive(true);
      setStallUiActive(false);

      // delta tracking
      streamHasDeltaRef.current = false;
      streamLastDeltaAtRef.current = 0;

      if (streamPaceTimerRef.current) {
        window.clearInterval(streamPaceTimerRef.current);
        streamPaceTimerRef.current = null;
      }

      streamPaceTimerRef.current = window.setInterval(() => {
        const id = streamTempAssistantIdRef.current;
        if (!id) return;

        const target = streamTargetRef.current;
        const shown = streamShownRef.current;

        // prebuffer 구간: target이 충분히 쌓이기 전까지는 출력 시작을 지연(elyn 스타일)
        const now = Date.now();
        const lastDeltaAt = streamLastDeltaAtRef.current;
        const allowFlushAll =
          streamHasDeltaRef.current && lastDeltaAt > 0 && now - lastDeltaAt >= STREAM_IDLE_FLUSH_MS;

        if (prebufferUiActiveRef.current && !allowFlushAll) {
          const elapsed = now - (prebufferStartRef.current || now);
          if (elapsed < STREAM_MIN_PREBUFFER_UI_MS || target.length < STREAM_PREBUFFER_CHARS) {
            return;
          }
        }
        // prebuffer 배지는 '실제 첫 글자 출력' 시점에 끈다(아래 nextLen>0 처리)

        if (shown.length >= target.length) return;

        // backlog 유지: 스트리밍 중에는 항상 약간 뒤처지게 해서 버퍼 고갈로 인한 '멈춤'을 완화
        const desiredMaxLen = Math.max(0, target.length - (allowFlushAll ? 0 : STREAM_TARGET_BACKLOG));
        if (shown.length >= desiredMaxLen) return;

        const backlog = target.length - shown.length;
        // backlog가 커지면 더 빠르게 따라잡되, 한 번에 크게 점프하지 않도록 "부드러운 상한"을 둔다.
        // - base: STREAM_CHARS_PER_TICK (타자 치듯)
        // - boost: backlog/160 정도로 서서히 증가
        // - cap: 24 (≈ 1500 chars/sec @16ms)로 제한해 "영상처럼 쏟아짐" 방지
        const backlogBoost = Math.floor(backlog / 160);
        const step = Math.max(1, Math.min(24, STREAM_CHARS_PER_TICK + backlogBoost));

        const nextLen = Math.min(desiredMaxLen, shown.length + step);
        const nextText = target.slice(0, nextLen);
        streamShownRef.current = nextText;

        // (perf) prev.map(...)으로 전체 메시지 재생성/재렌더가 누적되면 끊김이 체감될 수 있다.
        // - 대부분 스트리밍 대상은 마지막 메시지이므로 O(1) 업데이트를 우선 시도하고,
        // - 아니면 findIndex로 최소 변경만 적용한다.
        setMessages((prev) => {
          const n = prev.length;
          if (n === 0) return prev;
          const last = prev[n - 1];
          if (last.id === id) {
            if (last.content === nextText) return prev;
            const next = prev.slice();
            next[n - 1] = ({ ...(last as any), content: nextText } as T);
            return next;
          }
          const idx = prev.findIndex((m) => m.id === id);
          if (idx < 0) return prev;
          if (prev[idx].content === nextText) return prev;
          const next = prev.slice();
          next[idx] = ({ ...(prev[idx] as any), content: nextText } as T);
          return next;
        });

        if (prebufferUiActiveRef.current && !isEffectivelyEmptyForPrebuffer(nextText)) {
          prebufferUiActiveRef.current = false;
          setPrebufferUiActive(false);
          setStallUiActive(false);
        }

        // 스트리밍 중 자동 스크롤: chat 모드에서만(소설 모드는 시작 지점을 유지)
        const rm = (getRenderMode?.() || "novel").trim();
        if (rm === "chat") {
          // (perf) 스크롤은 레이아웃 비용이 커서 매 틱 호출 시 끊김이 생길 수 있다.
          // 80ms 정도로 throttle 하여 더 부드럽게.
          const tNow = Date.now();
          if (tNow - (lastAutoScrollAtRef.current || 0) >= 80) {
            lastAutoScrollAtRef.current = tNow;
            scrollToBottomIfAllowed();
          }
        }
      }, STREAM_PACE_MS);
    },
    [getRenderMode, scrollToBottomIfAllowed, setMessages]
  );

  const stopStreamPacer = useCallback(
    (opts2?: { flush?: boolean }) => {
      const id = streamTempAssistantIdRef.current;

      if (opts2?.flush && id) {
        const finalText = streamTargetRef.current;
        streamShownRef.current = finalText;
        setMessages((prev) => prev.map((m) => (m.id === id ? ({ ...m, content: finalText } as T) : m)));
      }

      if (streamPaceTimerRef.current) {
        window.clearInterval(streamPaceTimerRef.current);
        streamPaceTimerRef.current = null;
      }

      setPrebufferUiActive(false);
      setStallUiActive(false);
      streamTempAssistantIdRef.current = "";
    },
    [setMessages]
  );

  useEffect(() => {
    return () => {
      if (streamPaceTimerRef.current) {
        window.clearInterval(streamPaceTimerRef.current);
        streamPaceTimerRef.current = null;
      }
    };
  }, []);

  // (UI) 프리버퍼 배지: prebufferUiActive 동안 초/점 애니메이션
  useEffect(() => {
    if (!prebufferUiActive) {
      setPrebufferSec(0);
      setPrebufferDots("");
      return;
    }
    const start = prebufferStartRef.current || Date.now();
    prebufferStartRef.current = start;
    let tick = 0;
    const t = window.setInterval(() => {
      const now = Date.now();
      const sec = Math.max(0, Math.floor((now - start) / 1000));
      setPrebufferSec(sec);
      tick = (tick + 1) % 4;
      setPrebufferDots(tick === 0 ? "" : ".".repeat(tick));
    }, 250);
    return () => window.clearInterval(t);
  }, [prebufferUiActive]);

  return {
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
  };
}
