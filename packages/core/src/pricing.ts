import type { AppConfig, CostConfig, CostModelRate } from "@agentlens/contracts";

export interface CostUsage {
  model: string;
  promptTokens: number;
  inputTokens: number;
  cachedReadTokens: number;
  cachedCreateTokens: number;
  cachedCreate5mTokens?: number;
  cachedCreate1hTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ActiveRate {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cachedReadPer1MUsd: number;
  cachedCreatePer1MUsd: number;
  cachedCreate5mPer1MUsd?: number;
  cachedCreate1hPer1MUsd?: number;
  reasoningOutputPer1MUsd: number;
}

function normalizedLookupCandidates(model: string): string[] {
  const raw = String(model).trim();
  if (!raw) return [];
  const normalized = normalizePricingModelId(raw);
  return normalized === raw ? [raw] : [raw, normalized];
}

function findCostRate(model: string, costConfig: CostConfig): CostModelRate | null {
  const candidates = normalizedLookupCandidates(model);
  for (const candidate of candidates) {
    const match = costConfig.modelRates.find((rate) => rate.model === candidate);
    if (match) return match;
  }
  return null;
}

function pickActiveRate(rate: CostModelRate, promptTokens: number): ActiveRate {
  const useLongContext =
    typeof rate.longContextThresholdTokens === "number" &&
    Number.isFinite(rate.longContextThresholdTokens) &&
    rate.longContextThresholdTokens > 0 &&
    promptTokens > rate.longContextThresholdTokens;

  if (!useLongContext) {
    const activeRate: ActiveRate = {
      inputPer1MUsd: rate.inputPer1MUsd,
      outputPer1MUsd: rate.outputPer1MUsd,
      cachedReadPer1MUsd: rate.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: rate.cachedCreatePer1MUsd,
      reasoningOutputPer1MUsd: rate.reasoningOutputPer1MUsd,
    };
    if (typeof rate.cachedCreate5mPer1MUsd === "number") activeRate.cachedCreate5mPer1MUsd = rate.cachedCreate5mPer1MUsd;
    if (typeof rate.cachedCreate1hPer1MUsd === "number") activeRate.cachedCreate1hPer1MUsd = rate.cachedCreate1hPer1MUsd;
    return activeRate;
  }

  const activeRate: ActiveRate = {
    inputPer1MUsd: rate.longContextInputPer1MUsd ?? rate.inputPer1MUsd,
    outputPer1MUsd: rate.longContextOutputPer1MUsd ?? rate.outputPer1MUsd,
    cachedReadPer1MUsd: rate.longContextCachedReadPer1MUsd ?? rate.cachedReadPer1MUsd,
    cachedCreatePer1MUsd: rate.longContextCachedCreatePer1MUsd ?? rate.cachedCreatePer1MUsd,
    reasoningOutputPer1MUsd: rate.longContextReasoningOutputPer1MUsd ?? rate.reasoningOutputPer1MUsd,
  };
  const cachedCreate5mPer1MUsd = rate.longContextCachedCreate5mPer1MUsd ?? rate.cachedCreate5mPer1MUsd;
  if (typeof cachedCreate5mPer1MUsd === "number") activeRate.cachedCreate5mPer1MUsd = cachedCreate5mPer1MUsd;
  const cachedCreate1hPer1MUsd = rate.longContextCachedCreate1hPer1MUsd ?? rate.cachedCreate1hPer1MUsd;
  if (typeof cachedCreate1hPer1MUsd === "number") activeRate.cachedCreate1hPer1MUsd = cachedCreate1hPer1MUsd;
  return activeRate;
}

function estimateCachedCreateCost(usage: CostUsage, rate: ActiveRate): number {
  const cachedCreate5mTokens = usage.cachedCreate5mTokens ?? 0;
  const cachedCreate1hTokens = usage.cachedCreate1hTokens ?? 0;
  const splitKnownTokens = Math.max(0, cachedCreate5mTokens) + Math.max(0, cachedCreate1hTokens);
  const aggregateTokens = Math.max(0, usage.cachedCreateTokens);
  const remainingAggregateTokens = Math.max(0, aggregateTokens - splitKnownTokens);

  let total = 0;
  if (cachedCreate5mTokens > 0) {
    total +=
      (cachedCreate5mTokens / 1_000_000) * (rate.cachedCreate5mPer1MUsd ?? rate.cachedCreatePer1MUsd);
  }
  if (cachedCreate1hTokens > 0) {
    total +=
      (cachedCreate1hTokens / 1_000_000) * (rate.cachedCreate1hPer1MUsd ?? rate.cachedCreatePer1MUsd);
  }
  if (remainingAggregateTokens > 0) {
    total += (remainingAggregateTokens / 1_000_000) * rate.cachedCreatePer1MUsd;
  }
  return total;
}

export function estimateUsageCost(usage: CostUsage, costConfig: CostConfig): number | null {
  if (!costConfig.enabled) return null;

  const rate = findCostRate(usage.model, costConfig);
  if (!rate) {
    return costConfig.unknownModelPolicy === "zero" ? 0 : null;
  }

  const activeRate = pickActiveRate(rate, usage.promptTokens);
  const total =
    (Math.max(0, usage.inputTokens) / 1_000_000) * activeRate.inputPer1MUsd +
    (Math.max(0, usage.cachedReadTokens) / 1_000_000) * activeRate.cachedReadPer1MUsd +
    estimateCachedCreateCost(usage, activeRate) +
    (Math.max(0, usage.outputTokens) / 1_000_000) * activeRate.outputPer1MUsd +
    (Math.max(0, usage.reasoningOutputTokens) / 1_000_000) * activeRate.reasoningOutputPer1MUsd;
  return Number(total.toFixed(6));
}

export function normalizePricingModelId(model: string): string {
  let normalized = String(model).trim().toLowerCase();
  if (!normalized) return "";

  normalized = normalized.replace(/^global\.anthropic\./, "");
  normalized = normalized.replace(/^anthropic\//, "");
  normalized = normalized.replace(/^openai\//, "");
  normalized = normalized.replace(/-v\d+(?::\d+)?$/, "");

  if (normalized.includes("/")) {
    const tail = normalized.split("/").at(-1)?.trim() ?? normalized;
    if (tail.startsWith("claude-") || tail.startsWith("gpt-")) normalized = tail;
  }

  const claudeMatch = normalized.match(/^claude-(haiku|sonnet|opus)-4-(5|6)(?:-\d{8})?$/);
  if (claudeMatch) return `claude-${claudeMatch[1]}-4.${claudeMatch[2]}`;

  const gpt54Match = normalized.match(/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/);
  if (gpt54Match) return "gpt-5.4";

  const gpt53CodexMatch = normalized.match(/^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$/);
  if (gpt53CodexMatch) return "gpt-5.3-codex";

  const gpt52CodexMatch = normalized.match(/^gpt-5\.2-codex(?:-\d{4}-\d{2}-\d{2})?$/);
  if (gpt52CodexMatch) return "gpt-5.2-codex";

  const gpt52Match = normalized.match(/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/);
  if (gpt52Match) return "gpt-5.2";

  return normalized;
}

export function resolveContextWindowTokens(model: string, config: Pick<AppConfig, "models" | "cost">): number {
  const rawModel = String(model).trim();
  const normalizedModel = normalizePricingModelId(rawModel);

  for (const candidate of [rawModel, normalizedModel]) {
    if (!candidate) continue;
    const direct = config.models.contextWindows.find((entry) => entry.model === candidate);
    if (direct && Number.isFinite(direct.contextWindowTokens) && direct.contextWindowTokens > 0) {
      return direct.contextWindowTokens;
    }
  }

  const rate = findCostRate(rawModel || normalizedModel, config.cost);
  if (rate && Number.isFinite(rate.contextWindowTokens) && (rate.contextWindowTokens ?? 0) > 0) {
    return rate.contextWindowTokens ?? 0;
  }

  return config.models.defaultContextWindowTokens > 0 ? config.models.defaultContextWindowTokens : 0;
}
