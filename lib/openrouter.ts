// NOTE:
// 이 파일은 과거 OpenRouter 연동 코드 경로(app/api/chat/route.ts)에서 빌드 에러가 나지 않도록
// 호환용으로 남겨둔 래퍼입니다.
// 현재 프로젝트의 AI Provider는 Google Gemini API이며, 여기서도 Gemini 호출로 대체합니다.
// (기존 기능 삭제/비활성화 없이, 레거시 엔드포인트가 동작 가능하도록만 최소 구현)

import { generateText, type ChatGenOpts } from "@/lib/ai";
import { DEFAULT_CHAT_MODEL, coerceChatModelId } from "@/lib/models";

export type ORMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function defaultModel() {
  // 프로젝트의 기본값을 우선 사용하고, 없으면 flash로 안전하게.
  return (
    process.env.DEFAULT_GEMINI_MODEL ||
    process.env.NEXT_PUBLIC_DEFAULT_GEMINI_MODEL ||
    DEFAULT_CHAT_MODEL
  );
}

// OpenRouter 스타일(messages[]) 입력을 받아, Gemini 단일(system+user) 호출로 변환한다.
// - system: messages 중 첫 system 역할을 사용
// - user: 나머지 대화 히스토리를 간단 포맷으로 직렬화
export async function callOpenRouter(params: {
  messages: ORMessage[];
  model?: string;
  maxOutputTokens?: number;
  maxReasoningTokens?: number;
}) {
  const { messages } = params;

  const systemMsg = messages.find((m) => m.role === "system")?.content || "";

  // system을 제외한 대화 히스토리 직렬화
  const hist = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const tag = m.role === "user" ? "USER" : "ASSISTANT";
      return `[${tag}]\n${String(m.content || "").trim()}\n`;
    })
    .join("\n");

  const user = hist.trim();

  const opts: ChatGenOpts = {
    model: coerceChatModelId(String(params.model || defaultModel())),
    maxOutputTokens: Number(params.maxOutputTokens ?? 2048),
    maxReasoningTokens: Number(params.maxReasoningTokens ?? 0),
  };

  const { text } = await generateText({
    system: systemMsg,
    user,
    opts,
  });

  return text;
}
