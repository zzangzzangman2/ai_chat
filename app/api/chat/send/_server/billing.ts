const DEFAULT_USD_TO_KRW = Number(process.env.USD_TO_KRW || 1434); // 대략값

export type ModelPricing = { inPer1M: number; outPer1M: number };

export function getModelPricing(model: string): ModelPricing {
  const m = String(model || "").trim();
  // 기본값은 2.5-pro로 둔다(프로젝트 기본 모델).
  const table: Record<string, ModelPricing> = {
    // Gemini 2.5
    "gemini-2.5-pro": { inPer1M: 1.25, outPer1M: 10.0 },
    // Gemini 3.x flash — 신/구 ID 모두 같은 단가로 매핑 (사용자가 구체 단가 알리기 전까지 기존 3-flash 단가 유지)
    "gemini-3.5-flash": { inPer1M: 0.3, outPer1M: 2.5 },
    "gemini-3-flash-preview": { inPer1M: 0.3, outPer1M: 2.5 },
    "gemini-3.1-flash": { inPer1M: 0.3, outPer1M: 2.5 },
    "gemini-3.1-pro-preview": { inPer1M: 2.0, outPer1M: 12.0 },
  };
  return table[m] || table["gemini-2.5-pro"];
}

export function estimateCost(model: string, promptTokens: number, outputTokens: number) {
  const p = getModelPricing(model);
  const usd = (promptTokens / 1_000_000) * p.inPer1M + (outputTokens / 1_000_000) * p.outPer1M;
  const krw = usd * DEFAULT_USD_TO_KRW;
  return { costUsd: usd, costKrw: krw, usdToKrw: DEFAULT_USD_TO_KRW, pricing: p };
}
