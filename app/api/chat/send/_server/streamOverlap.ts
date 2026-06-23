export type MaybeStartStreamMetaOverlapParams = {
  enabled: boolean;
  existingPromise: Promise<string> | null;
  metaStarted: boolean;
  capReached: boolean;
  raw: string;
  triggerChars: number;
  metaLabelHint: string;
  metaFenceTemplateHint: string;
  opts: any;
  metaCompletionModel: string;
  generateText: (args: { system: string; user: string; opts: any }) => Promise<any>;
  normalizeAnyFenceOpen: (text: string) => string;
  repairUnclosedAnyFence: (text: string) => string;
  reEsc: (text: string) => string;
};

export type MaybeStartStreamMetaOverlapResult = {
  metaOverlapPromise: Promise<string> | null;
  metaOverlapTriggeredAt: number;
};

export function maybeStartStreamMetaOverlap(
  params: MaybeStartStreamMetaOverlapParams
): MaybeStartStreamMetaOverlapResult {
  let metaOverlapPromise = params.existingPromise;
  let metaOverlapTriggeredAt = 0;

  // (Meta completion overlap) Start meta-only completion in parallel once the body is mostly produced.
  if (
    params.enabled &&
    !metaOverlapPromise &&
    !params.metaStarted &&
    !params.capReached &&
    params.raw.length >= params.triggerChars
  ) {
    let hasMeta = false;
    try {
      hasMeta = params.metaLabelHint
        ? new RegExp("```[ \t]*" + params.reEsc(params.metaLabelHint) + "(?=[^A-Za-z0-9_-]|$)", "i").test(params.raw)
        : /```/.test(params.raw);
    } catch {
      hasMeta = /```/.test(params.raw);
    }
    if (!hasMeta) {
      metaOverlapTriggeredAt = Date.now();
      const bodyTail = params.raw.slice(-Math.min(2400, params.raw.length)).trim();
      metaOverlapPromise = (async () => {
        const metaSystem = [
          `너는 소설 본문 뒤에 붙는 '메타 패널(상태/정보)'만 생성하는 도우미다.`,
          `아래의 메타 템플릿을 최대한 그대로 따르되, 내용만 상황에 맞게 채운다.`,
          `반드시 fenced 코드블록으로 시작하고(예: \`\`\`${params.metaLabelHint}\`) 닫는 \`\`\`을 포함해 완전히 닫아라.`,
          `메타 패널 외의 다른 문장/지문/대사는 절대 출력하지 마라.`,
          `fenced 블록 뒤에는 <<<END_META>>> 를 반드시 붙여라.`,
        ].join("\n");
        const metaUser = [
          `메타 템플릿(이 형식을 최대한 그대로 유지):`,
          String(params.metaFenceTemplateHint || "").trim(),
          ``,
          `아래는 방금까지 생성된 본문 일부다. 본문을 반복 출력하지 말고, 메타 패널 내용 작성에만 참고하라:`,
          bodyTail,
          ``,
          `출력은 반드시 메타 fenced 블록 1개만.`,
        ].join("\n");

        const meta = await params.generateText({
          system: metaSystem,
          user: metaUser,
          opts: {
            ...(params.opts as any),
            model: params.metaCompletionModel,
            // meta panel should be fast and small (no deep thinking needed)
            maxOutputTokens: 384,
            maxOutputTokensRequested: 384,
            maxReasoningTokens: 0,
            thinkingBudget: 0,
            thinkingLevel: "none",
            stopSequences: ["<<<END_META>>>"],
            temperature: 0.2,
          } as any,
        });

        let metaOnly = String((meta as any)?.text ?? meta ?? "");
        // trim any sentinel / trailing noise
        metaOnly = metaOnly.replace(/<<<END_META>>>[\s\S]*$/i, "");
        metaOnly = params.normalizeAnyFenceOpen(metaOnly);
        metaOnly = params.repairUnclosedAnyFence(metaOnly).trim();

        const reLabel = params.metaLabelHint
          ? new RegExp(`\`\`\`[ \\t]*${params.reEsc(params.metaLabelHint)}(?=[^A-Za-z0-9_-]|$)[\\s\\S]*?\`\`\``, "i")
          : null;
        const picked = (reLabel && metaOnly.match(reLabel)?.[0]) || metaOnly.match(/```[\s\S]*?```/i)?.[0] || "";
        return picked ? picked.trim() : "";
      })().catch(() => "");
    }
  }

  return { metaOverlapPromise, metaOverlapTriggeredAt };
}

export type MaybeStartDoneOnlyMetaOverlapParams = {
  proDoneOnly: boolean;
  enabled: boolean;
  existingPromise: Promise<string> | null;
  metaFenceTemplateHint: string;
  userText: string;
  opts: any;
  metaCompletionModel: string;
  metaLabelHint: string;
  generateText: (args: { system: string; user: string; opts: any }) => Promise<any>;
  normalizeAnyFenceOpen: (text: string) => string;
  repairUnclosedAnyFence: (text: string) => string;
  reEsc: (text: string) => string;
};

export type MaybeStartDoneOnlyMetaOverlapResult = {
  metaOverlapPromise: Promise<string> | null;
  metaOverlapTriggeredAt: number;
};

export function maybeStartDoneOnlyMetaOverlap(
  params: MaybeStartDoneOnlyMetaOverlapParams
): MaybeStartDoneOnlyMetaOverlapResult {
  let metaOverlapPromise = params.existingPromise;
  let metaOverlapTriggeredAt = 0;

  // (Overlap) In PRO_DONE_ONLY mode, prefetch a meta panel from the prompt-defined template
  // so the user perceives a single one-shot response.
  if (params.proDoneOnly && params.enabled && !metaOverlapPromise) {
    try {
      metaOverlapTriggeredAt = Date.now();
      metaOverlapPromise = (async (): Promise<string> => {
        const metaSystem = [
          "너는 메타 패널을 작성하는 보조 생성기다.",
          "아래 템플릿을 반드시 그대로 따라, fenced 블록 1개만 출력한다.",
          "본문(서사/대사)은 절대 출력하지 않는다.",
          "추측이 필요한 항목은 '?' 또는 비워 둔다.",
          "반드시 닫는 ```을 포함해 완전히 닫아라.",
          "fenced 블록 뒤에는 <<<END_META>>> 를 반드시 붙여라.",
        ].join("\n");

        const metaUser = [
          "메타 템플릿(반드시 라벨/구성 유지, 닫는 ``` 포함):",
          String(params.metaFenceTemplateHint || "").trim(),
          "",
          "이번 턴 입력/지시(참고용, 본문을 재출력하지 말 것):",
          String(params.userText || "").trim(),
          "",
          "출력은 반드시 위 템플릿 라벨의 fenced 블록 1개만.",
        ].join("\n");

        const metaRes = await params.generateText({
          system: metaSystem,
          user: metaUser,
          opts: {
            ...(params.opts as any),
            model: params.metaCompletionModel,
            maxOutputTokens: 256,
            maxOutputTokensRequested: 256,
            maxReasoningTokens: 0,
            thinkingBudget: 0,
            thinkingLevel: "none",
            stopSequences: ["<<<END_META>>>"],
            temperature: 0.2,
          } as any,
        });

        let metaOnly = String((metaRes as any)?.text || "").trim();
        metaOnly = params.repairUnclosedAnyFence(params.normalizeAnyFenceOpen(metaOnly)).trim();

        const reLabel = params.metaLabelHint
          ? new RegExp("```[ \\t]*" + params.reEsc(params.metaLabelHint) + "(?=[^A-Za-z0-9_-]|$)[\\s\\S]*?```", "i")
          : null;
        const picked = reLabel ? metaOnly.match(reLabel)?.[0] : null;
        return String(picked || metaOnly || "").trim();
      })();
    } catch {
      // ignore
    }
  }

  return { metaOverlapPromise, metaOverlapTriggeredAt };
}

export type ResolveMetaCompletionFenceParams = {
  metaOverlapPromise: Promise<string> | null;
  metaOverlapTimeoutMs: number;
  metaLabelHint: string;
  metaFenceTemplateHint: string;
  assistantText: string;
  opts: any;
  metaCompletionModel: string;
  generateText: (args: { system: string; user: string; opts: any }) => Promise<any>;
  normalizeAnyFenceOpen: (text: string) => string;
  repairUnclosedAnyFence: (text: string) => string;
  reEsc: (text: string) => string;
};

export type ResolveMetaCompletionFenceResult = {
  picked: string;
  pickedFromOverlap: boolean;
  metaOverlapWaitMs: number;
};

export async function resolveMetaCompletionFence(
  params: ResolveMetaCompletionFenceParams
): Promise<ResolveMetaCompletionFenceResult> {
  let pickedFromOverlap = "";
  let metaOverlapWaitMs = 0;

  if (params.metaOverlapPromise) {
    const waitStart = Date.now();
    pickedFromOverlap = String(
      await Promise.race<string>([
        params.metaOverlapPromise,
        new Promise<string>((res) => setTimeout(() => res(""), params.metaOverlapTimeoutMs)),
      ])
    );
    metaOverlapWaitMs = Date.now() - waitStart;
  }

  let picked = pickedFromOverlap || "";
  if (!picked) {
    const metaSystem = [
      `너는 소설 본문 뒤에 붙는 '메타 패널(상태/정보)'만 생성하는 도우미다.`,
      `아래의 메타 템플릿을 최대한 그대로 따르되, 내용만 상황에 맞게 채운다.`,
      `반드시 fenced 코드블록으로 시작하고(예: \`\`\`${params.metaLabelHint}\`) 닫는 \`\`\`을 포함해 완전히 닫아라.`,
      `메타 패널 외의 다른 문장/지문/대사는 절대 출력하지 마라.`,
      `fenced 블록 뒤에는 <<<END_META>>> 를 반드시 붙여라.`,
    ].join("\n");
    const metaUser = [
      `메타 템플릿(이 형식을 최대한 그대로 유지):`,
      String(params.metaFenceTemplateHint || "").trim(),
      ``,
      `아래는 방금 생성된 본문이다. 본문을 반복 출력하지 말고, 메타 패널 내용 작성에만 참고하라:`,
      String(params.assistantText || "").slice(-Math.min(2400, String(params.assistantText || "").length)).trim(),
      ``,
      `출력은 반드시 메타 fenced 블록 1개만.`,
    ].join("\n");

    const meta = await params.generateText({
      system: metaSystem,
      user: metaUser,
      opts: {
        ...(params.opts as any),
        model: params.metaCompletionModel,
        // meta panel should be fast and bounded (no deep thinking needed)
        maxOutputTokens: 384,
        maxOutputTokensRequested: 384,
        maxReasoningTokens: 0,
        thinkingBudget: 0,
        thinkingLevel: "none",
        stopSequences: ["<<<END_META>>>"],
        temperature: 0.2,
      } as any,
    });

    let metaOnly = String((meta as any)?.text ?? meta ?? "");

    // trim any sentinel / trailing noise
    metaOnly = metaOnly.replace(/<<<END_META>>>[\s\S]*$/i, "");
    metaOnly = params.normalizeAnyFenceOpen(metaOnly);
    metaOnly = params.repairUnclosedAnyFence(metaOnly).trim();

    // Keep only a single fenced block (prefer the hinted label).
    const reLabel = params.metaLabelHint
      ? new RegExp(`\`\`\`[ \\t]*${params.reEsc(params.metaLabelHint)}(?=[^A-Za-z0-9_-]|$)[\\s\\S]*?\`\`\``, "i")
      : null;
    picked = (reLabel && metaOnly.match(reLabel)?.[0]) || metaOnly.match(/```[\s\S]*?```/i)?.[0] || "";
    picked = picked.trim();
  }

  return {
    picked,
    pickedFromOverlap: Boolean(pickedFromOverlap),
    metaOverlapWaitMs,
  };
}

export type ApplyMetaCompletionFenceParams = {
  picked: string;
  assistantText: string;
  promptMaxChars: number;
  authorWantsStatus: boolean;
  allowedMetaLabels: string[];
  bodyMaxChars: number;
  metaMaxChars: number;
  finalizeOneShotOutputWithMeta: (text: string, promptMaxChars: number, opts: any) => any;
  persistAssistantContent?: (assistantText: string) => void;
};

export type ApplyMetaCompletionFenceResult = {
  assistantText: string;
  fin: any;
  applied: boolean;
};

export function applyMetaCompletionFence(params: ApplyMetaCompletionFenceParams): ApplyMetaCompletionFenceResult {
  const picked = String(params.picked || "").trim();
  if (!picked) {
    return {
      assistantText: params.assistantText,
      fin: null,
      applied: false,
    };
  }

  // Non-streaming: append in-place.
  const withMeta = String(params.assistantText || "") + "\n\n" + picked + "\n";
  const fin = params.finalizeOneShotOutputWithMeta(withMeta, params.promptMaxChars, {
    statusRequired: params.authorWantsStatus,
    allowedLabels: params.allowedMetaLabels,
    preferAppendOnly: true,
    bodyBudgetChars: params.bodyMaxChars,
    metaHardMaxChars: params.metaMaxChars,
    metaSoftMaxChars: params.metaMaxChars,
  });

  const assistantText = String(fin?.text ?? withMeta);
  if (params.persistAssistantContent) {
    try {
      params.persistAssistantContent(assistantText);
    } catch {
      // ignore
    }
  }

  return {
    assistantText,
    fin,
    applied: true,
  };
}
