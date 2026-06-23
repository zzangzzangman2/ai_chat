export type MsgRole = "user" | "assistant" | (string & {});

/**
 * Compute the visible message window and commonly-used derived IDs.
 *
 * NOTE:
 * - This is intentionally a *pure* function (no React, no DOM).
 * - Moving this logic out of ChatArea.tsx reduces the amount of code that
 *   TypeScript/fast-refresh has to re-parse on small UI edits.
 */
export function computeMessageWindow<T extends { id: string; role: MsgRole }>(
  messages: readonly T[],
  visibleCount: number,
  opts: {
    threshold: number;
    defaultTail: number;
    /**
     * Optional: true windowing / virtualization.
     * If provided, the visible window is computed as messages.slice(windowStart, windowStart + windowSize)
     * (clamped to bounds). This keeps render count constant even for long chats.
     */
    windowStart?: number;
    windowSize?: number;
  }
): {
  effectiveVisibleCount: number;
  visibleMessages: T[];
  /**
   * Number of messages hidden *above* the visible window.
   * (Kept for backward compatibility with older UI that only cared about "older hidden".)
   */
  hiddenMessageCount: number;
  /** Number of messages hidden *below* the visible window. */
  hiddenNewerMessageCount: number;
  lastAssistantId?: string;
  lastUserId?: string;
  firstAssistantId: string;
} {
  const total = messages.length;

  // last ids
  let lastAssistantId: string | undefined;
  let lastUserId: string | undefined;
  for (let i = total - 1; i >= 0 && (!lastAssistantId || !lastUserId); i--) {
    const m = messages[i];
    if (!m) continue;
    if (!lastAssistantId && m.role === "assistant") lastAssistantId = m.id;
    if (!lastUserId && m.role === "user") lastUserId = m.id;
  }

  // effective visible count + visible slice
  let effectiveVisibleCount = 0;
  let visibleMessages: T[] = [];
  let hiddenMessageCount = 0;
  let hiddenNewerMessageCount = 0;

  const ws = typeof opts.windowStart === "number" ? Math.max(0, Math.floor(opts.windowStart)) : -1;
  const wz = typeof opts.windowSize === "number" ? Math.max(0, Math.floor(opts.windowSize)) : 0;

  if (ws >= 0 && wz > 0) {
    const start = Math.min(ws, total);
    const end = Math.min(total, start + wz);
    visibleMessages = (messages as T[]).slice(start, end);
    effectiveVisibleCount = visibleMessages.length;
    hiddenMessageCount = start;
    hiddenNewerMessageCount = Math.max(0, total - end);
  } else {
    if (total === 0) {
      effectiveVisibleCount = 0;
    } else if (visibleCount > 0) {
      effectiveVisibleCount = Math.min(total, visibleCount);
    } else if (total >= opts.threshold) {
      effectiveVisibleCount = Math.min(total, opts.defaultTail);
    } else {
      effectiveVisibleCount = total;
    }

    if (effectiveVisibleCount >= total) {
      visibleMessages = messages as T[];
    } else {
      const start = Math.max(0, total - effectiveVisibleCount);
      visibleMessages = (messages as T[]).slice(start);
    }

    hiddenMessageCount = Math.max(0, total - visibleMessages.length);
    hiddenNewerMessageCount = 0;
  }

  // first assistant id in visible window
  let firstAssistantId = "";
  for (let i = 0; i < visibleMessages.length; i++) {
    const m = visibleMessages[i];
    if (m && m.role === "assistant") {
      firstAssistantId = m.id;
      break;
    }
  }

  return {
    effectiveVisibleCount,
    visibleMessages,
    hiddenMessageCount,
    hiddenNewerMessageCount,
    lastAssistantId,
    lastUserId,
    firstAssistantId,
  };
}
