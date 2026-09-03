const DEFAULT_USD_TO_KRW = Number(process.env.USD_TO_KRW || 1434); // 대략값

export type ModelPricing = { inPer1M: number; outPer1M: number };

export function getModelPricing(model: string, atMs = Date.now()): ModelPricing {
  const m = String(model || "").trim();
  // Official 3.8 Flash introductory pricing ends 2026-12-31 (UTC).
  // https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash
  const flash38Pricing = atMs < Date.UTC(2027, 0, 1)
    ? { inPer1M: 0.75, outPer1M: 3.75 }
    : { inPer1M: 1.5, outPer1M: 7.5 };
  // 기본값은 2.5-pro로 둔다(프로젝트 기본 모델).
  const table: Record<string, ModelPricing> = {
    // Gemini 2.5
    "gemini-2.5-pro": { inPer1M: 1.25, outPer1M: 10.0 },
    // Official on-demand Gemini API pricing (USD per 1M tokens).
    "gemini-3.8-flash": flash38Pricing,
    // Keep historical IDs for previously recorded usage; new calls use 3.8.
    "gemini-3.7-flash": { inPer1M: 1.5, outPer1M: 7.5 },
    "gemini-3.6-flash": { inPer1M: 1.5, outPer1M: 7.5 },
    "gemini-3.5-flash": { inPer1M: 1.5, outPer1M: 9.0 },
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
