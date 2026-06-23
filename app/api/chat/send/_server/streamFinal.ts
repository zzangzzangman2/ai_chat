import { awaitFinalFast } from "./streamHelpers";

export type FinalizeStreamResultParams = {
  genFinal: Promise<any>;
  raw: string;
  hadDelta: boolean;
  modelName: string;
  modelForWait: string;
  isGemini3: boolean;
  streamDebug: boolean;
  streamTag: string;
  tag: string;
  safeEnqueue: (obj: any) => boolean;
};

export type FinalizeStreamResult = {
  raw: string;
  usage: any;
  finishReason: string;
};

export type ApplyStreamFinalizeUsageStatsParams = {
  enrichedUsage: any;
  assistantText: string;
  targetChars: number;
  allowedMetaLabels: string[];
  metaLabelHint: string;
  fin: {
    bodyChars: number;
    metaChars: number;
    totalChars: number;
    injectedStatus: boolean;
  };
  metaInjectedLocal: boolean;
};

export async function finalizeStreamResult(params: FinalizeStreamResultParams): Promise<FinalizeStreamResult> {
  let final: any = null;
  let usage: any = null;
  let raw = params.raw;

  // gen.final can resolve much later than the last visible delta (esp. gemini-3-pro*).
  // We must avoid the ping-only/0-char failure mode where no delta arrives but final is late.
  const isGemini25 = params.modelName.includes("gemini-2.5");
  const isGemini3Pro = /gemini-3(?:\.\d+)?-pro/i.test(String(params.modelForWait || ""));
  const baseFinalWait = isGemini3Pro ? 3500 : params.isGemini3 ? 3200 : isGemini25 ? 2200 : 1600;
  // If no deltas ever arrived (ping-only), final can arrive much later (esp. gemini-3-pro-preview).
  let finalWaitMs = baseFinalWait;
  if (!params.hadDelta) {
    finalWaitMs = isGemini3Pro ? 30000 : params.isGemini3 ? 15000 : isGemini25 ? 8000 : 6000;
  }
  final = await awaitFinalFast(params.genFinal, finalWaitMs);
  usage = (final as any)?.usage ?? null;

  // Some models (esp. gemini-3-pro-preview) attach usage late. Wait a bit more if needed.
  if (!usage) {
    const extraWaitMs = isGemini3Pro ? 1500 : params.isGemini3 ? 1500 : isGemini25 ? 1200 : 900;
    if (params.streamDebug) console.debug(`${params.streamTag} final.wait.extra (${params.tag}) ms=${extraWaitMs}`);
    const f2 = await awaitFinalFast(params.genFinal, extraWaitMs);
    if (f2) final = f2;
    usage = (final as any)?.usage ?? usage;
  }

  // Last resort: if final is still missing and no deltas arrived, wait once more.
  if (!final && !params.hadDelta) {
    const extraFinalMs = isGemini3Pro ? 30000 : params.isGemini3 ? 15000 : 8000;
    if (params.streamDebug) console.debug(`${params.streamTag} final.wait.extra2 (${params.tag}) ms=${extraFinalMs}`);
    const f3 = await awaitFinalFast(params.genFinal, extraFinalMs);
    if (f3) final = f3;
    usage = (final as any)?.usage ?? usage;
  }

  // Never end up with a totally blank assistant message.
  if (!params.hadDelta && (!final || !String((final as any)?.text || "").trim())) {
    const status = [
      "```STATUS",
      "error: empty_output",
      "note: 모델이 빈 응답(또는 차단된 응답)을 반환했습니다.",
      "tip: 입력을 완곡하게 바꾸거나(수위/폭력/성적 표현 완화), 다시 시도해 주세요.",
      "```",
      "",
    ].join("\n");
    final = { text: status, usage: usage ?? null } as any;
    usage = (final as any)?.usage ?? usage;
  }

  if (!params.hadDelta && final?.text) {
    const ft = String(final.text || "");
    raw += ft;
    try {
      params.safeEnqueue({ type: "delta", text: ft });
    } catch {
      // ignore
    }
  }

  // Finish reason should be sourced from usage metadata; in this stream handler `final`
  // only includes { text, usage } (no finishReason field).
  const finishReason = String(
    (usage && (usage.finishReason || usage.native_finish_reason || (usage as any).nativeFinishReason)) || ""
  ).toUpperCase();
  if (params.streamDebug) console.debug(`${params.streamTag} gen.done (${params.tag}) finishReason=${finishReason}`);
  return { raw, usage, finishReason };
}

export function applyStreamFinalizeUsageStats(params: ApplyStreamFinalizeUsageStatsParams): void {
  if (!params.enrichedUsage || typeof params.enrichedUsage !== "object") return;
  (params.enrichedUsage as any).outputChars = params.assistantText.length;
  // Client-side diagnostics / policies
  (params.enrichedUsage as any).outputTargetChars = params.targetChars;
  (params.enrichedUsage as any).metaFenceLabels = params.allowedMetaLabels;
  (params.enrichedUsage as any).metaLabelHint = params.metaLabelHint;
  (params.enrichedUsage as any).outputBodyChars = params.fin.bodyChars;
  (params.enrichedUsage as any).outputMetaChars = params.fin.metaChars;
  (params.enrichedUsage as any).outputTotalChars = params.fin.totalChars;
  (params.enrichedUsage as any).injectedStatus = params.fin.injectedStatus;
  (params.enrichedUsage as any).metaInjectedLocal = params.metaInjectedLocal;
  (params.enrichedUsage as any).metaInjectedLocalChars = params.metaInjectedLocal ? params.fin.metaChars : 0;
}
