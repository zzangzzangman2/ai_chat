"use client";

import React, { memo, useMemo } from "react";
import type { ReactElement } from "react";

import { Icon } from "@/app/components/chat/ChatArea/Icons";
import { SourceBadges } from "@/app/components/chat/ChatArea/SourceBadges";
import type { ChatTheme, Msg, MessageContentRenderer } from "@/app/components/ChatArea";

// (role) 서버/DB에서 assistant 응답이 'model'로 들어오는 케이스가 있어 UI에서 동일하게 처리한다.
const isAssistantLikeRole = (role: any) => role === "assistant" || role === "model";

type ModelBadge = { label: string; bg: string; fg: string };

const MessageItem = memo(function MessageItem(props: {
  m: Msg;
  contentOverride?: string;

  prebufferUiActive: boolean;
  prebufferSec: number;
  prebufferDots: string;
  streamTempAssistantId: string;
  stallUiActive: boolean;
  streamTargetId: string;

  userName: string;
  npcName: string;
  theme: ChatTheme;
  iconButtonStyle: React.CSSProperties;
  MessageContent: MessageContentRenderer;
  effectiveRenderMode: "chat" | "novel";

  editingAssistantId: string | null;
  editingUserId: string | null;

  assistantDraft: string;
  userDraft: string;
  onChangeAssistantDraft: (v: string) => void;
  onChangeUserDraft: (v: string) => void;

  onRegenerateFromAssistant: (m: Msg) => void;
  onContinueFromAssistant: (m: Msg) => void;
  onRequestDeleteMessage: (m: Msg) => void;
  onStartAssistantEdit: (m: Msg) => void;
  onStartUserEdit: (m: Msg) => void;

  onOpenTokenInfo: (m: Msg, anchorEl?: HTMLElement | null) => void;

  onCancelAssistantEdit: () => void;
  onSaveAssistantEdit: () => void;
  onCancelUserEdit: () => void;
  onSaveUserEdit: () => void;
}) {
  const {
    m,
    contentOverride,
    prebufferUiActive,
    prebufferSec,
    prebufferDots,
    streamTempAssistantId,
    stallUiActive,
    streamTargetId,
    userName,
    npcName,
    theme,
    iconButtonStyle,
    MessageContent,
    effectiveRenderMode,
    editingAssistantId,
    editingUserId,
    assistantDraft,
    userDraft,
    onChangeAssistantDraft,
    onChangeUserDraft,
    onRegenerateFromAssistant,
    onContinueFromAssistant,
    onRequestDeleteMessage,
    onStartAssistantEdit,
    onStartUserEdit,
    onOpenTokenInfo,
    onCancelAssistantEdit,
    onSaveAssistantEdit,
    onCancelUserEdit,
    onSaveUserEdit,
  } = props;

  const contentForRender = contentOverride ?? m.content;

  // (perf)
  // - MessageContent(소설 파서/정규식)가 prebufferDots/상태 UI 변화로 매번 재실행되면 CPU가 튄다.
  // - map에서 { ...m }로 새 객체를 만들면 memo가 무력화되어, visible 메시지가 전부 재렌더된다.
  // → MessageItem props는 원본 message object를 유지하고,
  //   표시용 content 변형은 "contentForRender"(primitive) 기준으로만 다시 계산한다.
  const renderedBody = useMemo<ReactElement | null>(() => {
    if (m.id === editingAssistantId || m.id === editingUserId) return null;
    const msgForRender = contentOverride !== undefined ? ({ ...m, content: contentForRender } as Msg) : m;
    try {
      return MessageContent({ message: msgForRender });
    } catch {
      return (
        <div style={{ opacity: 0.75, fontSize: 12 }}>
          (렌더 중 오류가 발생했습니다)
        </div>
      );
    }
  }, [MessageContent, m.id, m.role, contentForRender, contentOverride, editingAssistantId, editingUserId]);

  return (
    <div data-msg-id={m.id} style={{ fontSize: "inherit" as any }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          opacity: 0.9,
          marginBottom: 6,
          color: theme.muted,
        }}
      >
        {m.role === "user" ? userName : npcName}
        {isAssistantLikeRole(m.role) && prebufferUiActive && m.id === streamTempAssistantId ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "4px 10px",
              borderRadius: 999,
              border: `1px solid rgba(126, 196, 255, 0.38)`,
              background: "linear-gradient(135deg, rgba(84,160,255,0.20), rgba(120,110,255,0.14))",
              color: theme.text,
              fontWeight: 800,
              fontSize: 11,
              letterSpacing: 0.2,
              boxShadow: "0 8px 20px rgba(0,0,0,0.26)",
              backdropFilter: "blur(3px)",
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 999,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(162, 214, 255, 0.18)",
                color: "#bde5ff",
              }}
            >
              <Icon name="sparkles" size={10} />
            </span>
            <span>생각 중 · {Math.max(0, prebufferSec)}s{prebufferDots}</span>
          </span>
        ) : null}

        {isAssistantLikeRole(m.role) && !prebufferUiActive && stallUiActive && m.id === streamTargetId ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "4px 10px",
              borderRadius: 999,
              border: `1px solid rgba(141, 222, 184, 0.34)`,
              background: "linear-gradient(135deg, rgba(35,195,128,0.18), rgba(120,230,190,0.10))",
              color: theme.text,
              fontWeight: 800,
              fontSize: 11,
              letterSpacing: 0.2,
              marginLeft: 8,
              boxShadow: "0 8px 20px rgba(0,0,0,0.24)",
              backdropFilter: "blur(3px)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: "#7ce7b8",
                boxShadow: "0 0 0 4px rgba(124,231,184,0.16)",
              }}
            />
            <span>생각 중…</span>
          </span>
        ) : null}
      </div>

      {isAssistantLikeRole(m.role) && m.id !== editingAssistantId && m.id !== editingUserId ? (
        <SourceBadges m={m} theme={theme} onOpenTokenInfo={onOpenTokenInfo} />
      ) : null}

      <div style={{ border: "none", borderRadius: 0, padding: 0, background: "transparent" }}>
        {m.id === editingAssistantId ? (
          <textarea
            value={assistantDraft}
            onChange={(e) => onChangeAssistantDraft(e.target.value)}
            style={{
              width: "100%",
              display: "block",
              boxSizing: "border-box",
              minHeight: 220,
              resize: "vertical",
              borderRadius: 10,
              border: `1px solid ${theme.borderStrong}`,
              background: theme.bg,
              color: theme.text,
              padding: 10,
              lineHeight: 1.35,
            }}
          />
        ) : m.id === editingUserId ? (
          <textarea
            value={userDraft}
            onChange={(e) => onChangeUserDraft(e.target.value)}
            style={{
              width: "100%",
              display: "block",
              boxSizing: "border-box",
              minHeight: 120,
              resize: "vertical",
              borderRadius: 10,
              border: `1px solid ${theme.borderStrong}`,
              background: theme.bg,
              color: theme.text,
              padding: 10,
              lineHeight: 1.35,
            }}
          />
        ) : (
          renderedBody
        )}

        {isAssistantLikeRole(m.role) && m.id === editingAssistantId ? (
          <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button type="button" title="취소" onClick={onCancelAssistantEdit} style={iconButtonStyle}>
              <Icon name="close" />
            </button>
            <button type="button" title="저장" onClick={onSaveAssistantEdit} style={iconButtonStyle}>
              <Icon name="check" />
            </button>
          </div>
        ) : null}

        {m.role === "user" && m.id === editingUserId ? (
          <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button type="button" title="취소" onClick={onCancelUserEdit} style={iconButtonStyle}>
              <Icon name="close" />
            </button>
            <button type="button" title="저장" onClick={onSaveUserEdit} style={iconButtonStyle}>
              <Icon name="check" />
            </button>
          </div>
        ) : null}

        {m.id !== editingAssistantId && m.id !== editingUserId ? (
          <div
            style={{
              marginTop: 6,
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 6,
              rowGap: 8,
              opacity: 0.9,
            }}
          >
            {isAssistantLikeRole(m.role) ? (
              <>
                <button
                  type="button"
                  title="토큰 사용량 보기"
                  onClick={() => onOpenTokenInfo(m)}
                  style={iconButtonStyle}
                >
                  <Icon name="info" />
                </button>
                <button
                  type="button"
                  title="이 답변부터 재생성"
                  onClick={() => onRegenerateFromAssistant(m)}
                  style={iconButtonStyle}
                >
                  <Icon name="refresh" />
                </button>
                <button
                  type="button"
                  title="이어쓰기"
                  onClick={() => onContinueFromAssistant(m)}
                  style={iconButtonStyle}
                >
                  <Icon name="magic" />
                </button>
                <button
                  type="button"
                  title="수정"
                  onClick={() => onStartAssistantEdit(m)}
                  style={iconButtonStyle}
                >
                  <Icon name="edit" />
                </button>
              </>
            ) : (
              <button type="button" title="수정" onClick={() => onStartUserEdit(m)} style={iconButtonStyle}>
                <Icon name="edit" />
              </button>
            )}
            <button type="button" title="삭제" onClick={() => onRequestDeleteMessage(m)} style={iconButtonStyle}>
              <Icon name="trash" />
            </button>
          </div>
        ) : null}
      </div>

      {/* (novel) 메시지 구분 여백 */}
      {effectiveRenderMode === "novel" ? <div style={{ height: 10 }} /> : null}
    </div>
  );
});

export const MessageList = memo(function MessageList(props: {
  messagesLength: number;
  visibleMessages: Msg[];
  modelName: string;
  getModelBadge: (rawModel: string) => ModelBadge;
  stripLeadingTitleForDisplay: (text: string) => string;

  hiddenMessageCount: number;
  hiddenNewerMessageCount: number;
  windowStep: number;

  // (무한 스크롤) 위로 올리면 이전 내용 추가 로드
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  requestLoadOlder: () => void;

  // (windowing) 누적 확장 대신 구간 이동
  moveWindowUp: (mode: "more" | "all") => void;
  resetWindowToTail: () => void;

  userName: string;
  npcName: string;
  theme: ChatTheme;
  iconButtonStyle: React.CSSProperties;
  MessageContent: MessageContentRenderer;
  effectiveRenderMode: "chat" | "novel";

  prebufferUiActive: boolean;
  prebufferSec: number;
  prebufferDots: string;
  streamTempAssistantId: string;
  stallUiActive: boolean;
  streamTargetId: string;

  editingAssistantId: string | null;
  editingUserId: string | null;

  assistantDraft: string;
  userDraft: string;
  onChangeAssistantDraft: (v: string) => void;
  onChangeUserDraft: (v: string) => void;

  onRegenerateFromAssistant: (m: Msg) => void;
  onContinueFromAssistant: (m: Msg) => void;
  onRequestDeleteMessage: (m: Msg) => void;
  onStartAssistantEdit: (m: Msg) => void;
  onStartUserEdit: (m: Msg) => void;

  onOpenTokenInfo: (m: Msg, anchorEl?: HTMLElement | null) => void;

  onCancelAssistantEdit: () => void;
  onSaveAssistantEdit: () => void;
  onCancelUserEdit: () => void;
  onSaveUserEdit: () => void;

  bottomRef: any;
}) {
  const {
    messagesLength,
    visibleMessages,
    modelName,
    getModelBadge,
    stripLeadingTitleForDisplay,
    hiddenMessageCount,
    hiddenNewerMessageCount,
    windowStep,
    hasMoreOlder,
    loadingOlder,
    requestLoadOlder,
    moveWindowUp,
    resetWindowToTail,
    userName,
    npcName,
    theme,
    iconButtonStyle,
    MessageContent,
    effectiveRenderMode,
    prebufferUiActive,
    prebufferSec,
    prebufferDots,
    streamTempAssistantId,
    stallUiActive,
    streamTargetId,
    editingAssistantId,
    editingUserId,
    assistantDraft,
    userDraft,
    onChangeAssistantDraft,
    onChangeUserDraft,
    onRegenerateFromAssistant,
    onContinueFromAssistant,
    onRequestDeleteMessage,
    onStartAssistantEdit,
    onStartUserEdit,
    onOpenTokenInfo,
    onCancelAssistantEdit,
    onSaveAssistantEdit,
    onCancelUserEdit,
    onSaveUserEdit,
    bottomRef,
  } = props;

  if (messagesLength === 0) {
    return (
      <div style={{ fontSize: 13, opacity: 0.7 }}>
        왼쪽에서 새 채팅 만들기 후 메시지를 보내보세요.
      </div>
    );
  }

  const badgeBg = getModelBadge(modelName).bg;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(loadingOlder || hasMoreOlder) && (
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 14,
              border: `1px solid ${theme.borderStrong}`,
              background: "rgba(255,255,255,0.04)",
              maxWidth: "min(720px, 100%)",
              width: "100%",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: theme.text, lineHeight: 1.25 }}>
                {loadingOlder ? "이전 내용 불러오는 중…" : "위로 스크롤하면 이전 내용이 이어서 나타납니다"}
              </div>
              <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.25 }}>
                {loadingOlder
                  ? "잠시만요"
                  : hasMoreOlder
                    ? "맨 위에 닿으면 자동으로 더 로드돼요"
                    : "이 채팅의 처음까지 도달했어요"}
              </div>
            </div>
            <button
              type="button"
              onClick={requestLoadOlder}
              disabled={loadingOlder || !hasMoreOlder}
              style={{
                padding: "8px 10px",
                borderRadius: 12,
                border: `1px solid ${theme.borderStrong}`,
                background: badgeBg,
                color: theme.text,
                cursor: loadingOlder || !hasMoreOlder ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 900,
                whiteSpace: "nowrap",
                opacity: loadingOlder || !hasMoreOlder ? 0.55 : 1,
              }}
              title="이전 내용 불러오기"
            >
              {loadingOlder ? "로드 중…" : "이전 더 보기"}
            </button>
          </div>
        </div>
      )}

      {hiddenMessageCount > 0 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 4 }}>
          <button
            type="button"
            onClick={() => moveWindowUp("more")}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: `1px solid ${theme.borderStrong}`,
              background: badgeBg,
              color: theme.text,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            이전 구간 보기 ({Math.min(windowStep, hiddenMessageCount)}개)
          </button>
          <button
            type="button"
            onClick={() => moveWindowUp("all")}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: `1px solid ${theme.borderStrong}`,
              background: badgeBg,
              color: theme.text,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 800,
              opacity: 0.85,
            }}
          >
            처음으로
          </button>

          {hiddenNewerMessageCount > 0 && (
            <button
              type="button"
              onClick={resetWindowToTail}
              style={{
                padding: "8px 12px",
                borderRadius: 12,
                border: `1px solid ${theme.borderStrong}`,
                background: "rgba(255,255,255,0.04)",
                color: theme.text,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 800,
                opacity: 0.9,
              }}
              title="최신 구간으로 이동"
            >
              최신으로
            </button>
          )}
        </div>
      )}

      {visibleMessages.map((m) => {
        const contentOverride = isAssistantLikeRole(m.role)
          ? stripLeadingTitleForDisplay(String(m.content || ""))
          : undefined;

        // (perf)
        // prebufferSec/prebufferDots는 초/틱 단위로 자주 바뀌어, 그대로 모든 MessageItem에 props로 내려주면
        // visible 메시지 전체가 매번 rerender 된다.
        // → 실제로 UI에 영향을 받는(=표시되는) 메시지에만 값/ID를 전달한다.
        const isPrebufferTarget =
          Boolean(prebufferUiActive) && isAssistantLikeRole(m.role) && m.id === streamTempAssistantId;
        const isStallTarget =
          !isPrebufferTarget && Boolean(stallUiActive) && isAssistantLikeRole(m.role) && m.id === streamTargetId;

        const safePrebufferSec = isPrebufferTarget ? prebufferSec : 0;
        const safePrebufferDots = isPrebufferTarget ? prebufferDots : "";
        const safeStreamTempAssistantId = isPrebufferTarget ? streamTempAssistantId : "";
        const safeStreamTargetId = isStallTarget ? streamTargetId : "";

        return (
          <MessageItem
            key={m.id}
            m={m}
            contentOverride={contentOverride}
            userName={userName}
            npcName={npcName}
            theme={theme}
            iconButtonStyle={iconButtonStyle}
            MessageContent={MessageContent}
            effectiveRenderMode={effectiveRenderMode}
            prebufferUiActive={isPrebufferTarget}
            prebufferSec={safePrebufferSec}
            prebufferDots={safePrebufferDots}
            streamTempAssistantId={safeStreamTempAssistantId}
            stallUiActive={isStallTarget}
            streamTargetId={safeStreamTargetId}
            editingAssistantId={editingAssistantId}
            editingUserId={editingUserId}
            assistantDraft={assistantDraft}
            userDraft={userDraft}
            onChangeAssistantDraft={onChangeAssistantDraft}
            onChangeUserDraft={onChangeUserDraft}
            onRegenerateFromAssistant={onRegenerateFromAssistant}
            onContinueFromAssistant={onContinueFromAssistant}
            onRequestDeleteMessage={onRequestDeleteMessage}
            onStartAssistantEdit={onStartAssistantEdit}
            onStartUserEdit={onStartUserEdit}
            onOpenTokenInfo={onOpenTokenInfo}
            onCancelAssistantEdit={onCancelAssistantEdit}
            onSaveAssistantEdit={onSaveAssistantEdit}
            onCancelUserEdit={onCancelUserEdit}
            onSaveUserEdit={onSaveUserEdit}
          />
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
});
