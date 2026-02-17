import type { AgentKind, AppConfig, ModelTokenShare, NormalizedEvent, TokenTotals } from "@agentlens/contracts";
import { asRecord, asString } from "./utils.js";

interface SessionMetrics {
  tokenTotals: TokenTotals;
  modelTokenSharesTop: ModelTokenShare[];
  modelTokenSharesEstimated: boolean;
  contextWindowPct: number | null;
  costEstimateUsd: number | null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateTokenCountFromText(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  const charEstimate = Math.ceil(normalized.length / 4);
  const wordEstimate = Math.ceil(normalized.split(/\s+/).filter(Boolean).length * 0.75);
  return Math.max(1, charEstimate, wordEstimate);
}

function estimateTokenCountFromTextBlocks(blocks: string[]): number {
  let total = 0;
  for (const block of blocks) {
    total += estimateTokenCountFromText(block);
  }
  return total;
}

function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedReadTokens: 0,
    cachedCreateTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function finalizeTokenTotals(partial: TokenTotals): TokenTotals {
  const totalFromFields =
    partial.inputTokens +
    partial.cachedReadTokens +
    partial.cachedCreateTokens +
    partial.outputTokens +
    partial.reasoningOutputTokens;
  return {
    ...partial,
    totalTokens: partial.totalTokens > 0 ? partial.totalTokens : totalFromFields,
  };
}

function addTokenTotals(target: TokenTotals, delta: TokenTotals): void {
  target.inputTokens += delta.inputTokens;
  target.cachedReadTokens += delta.cachedReadTokens;
  target.cachedCreateTokens += delta.cachedCreateTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
  target.totalTokens += delta.totalTokens;
}

function tokenTotalsFromUsageRecord(usageRecord: Record<string, unknown>): TokenTotals {
  const cacheCreation = asRecord(usageRecord.cache_creation);
  const cachedCreateFromBreakdown =
    toNumber(cacheCreation.ephemeral_5m_input_tokens) + toNumber(cacheCreation.ephemeral_1h_input_tokens);
  const cachedCreate = Math.max(toNumber(usageRecord.cache_creation_input_tokens), cachedCreateFromBreakdown);
  const totals = emptyTokenTotals();
  totals.inputTokens = toNumber(usageRecord.input_tokens);
  totals.cachedReadTokens = toNumber(usageRecord.cache_read_input_tokens);
  totals.cachedCreateTokens = cachedCreate;
  totals.outputTokens = toNumber(usageRecord.output_tokens);
  totals.reasoningOutputTokens = toNumber(usageRecord.reasoning_output_tokens);
  totals.totalTokens = toNumber(usageRecord.total_tokens);
  return finalizeTokenTotals(totals);
}

function tokenTotalsFromCodexUsageRecord(record: Record<string, unknown>): TokenTotals {
  const totals = emptyTokenTotals();
  totals.inputTokens = toNumber(record.input_tokens);
  totals.cachedReadTokens = toNumber(record.cached_input_tokens);
  totals.cachedCreateTokens = 0;
  totals.outputTokens = toNumber(record.output_tokens);
  totals.reasoningOutputTokens = toNumber(record.reasoning_output_tokens);
  totals.totalTokens = toNumber(record.total_tokens);
  return finalizeTokenTotals(totals);
}

function tokenTotalsFromOpenCodeTokensRecord(record: Record<string, unknown>): TokenTotals {
  const cache = asRecord(record.cache);
  const totals = emptyTokenTotals();
  totals.inputTokens = toNumber(record.input);
  totals.cachedReadTokens = toNumber(cache.read);
  totals.cachedCreateTokens = toNumber(cache.write);
  totals.outputTokens = toNumber(record.output);
  totals.reasoningOutputTokens = toNumber(record.reasoning);
  totals.totalTokens = toNumber(record.total);
  return finalizeTokenTotals(totals);
}

function contextWindowResolver(config: AppConfig): (model: string) => number {
  const byModel = new Map<string, number>();
  for (const entry of config.models.contextWindows) {
    const model = entry.model.trim();
    if (!model || !Number.isFinite(entry.contextWindowTokens) || entry.contextWindowTokens <= 0) continue;
    byModel.set(model, entry.contextWindowTokens);
  }
  const fallback = config.models.defaultContextWindowTokens;
  return (model: string): number => {
    const direct = byModel.get(model);
    if (direct) return direct;
    return fallback > 0 ? fallback : 0;
  };
}

function buildTopModelShares(modelTokenTotals: Map<string, number>, topN: number): ModelTokenShare[] {
  const ranked = [...modelTokenTotals.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (total <= 0) return [];
  return ranked.slice(0, Math.max(1, topN)).map(([model, tokens]) => ({
    model,
    tokens,
    percent: (tokens / total) * 100,
  }));
}

function estimateCost(
  perModel: Map<string, TokenTotals>,
  costConfig: AppConfig["cost"],
): number | null {
  if (!costConfig.enabled) return null;

  const rateByModel = new Map(costConfig.modelRates.map((rate) => [rate.model, rate] as const));
  let total = 0;
  for (const [model, tokens] of perModel) {
    const rate = rateByModel.get(model);
    if (!rate) {
      if (costConfig.unknownModelPolicy === "n_a") return null;
      continue;
    }
    total += (tokens.inputTokens / 1_000_000) * rate.inputPer1MUsd;
    total += (tokens.cachedReadTokens / 1_000_000) * rate.cachedReadPer1MUsd;
    total += (tokens.cachedCreateTokens / 1_000_000) * rate.cachedCreatePer1MUsd;
    total += (tokens.outputTokens / 1_000_000) * rate.outputPer1MUsd;
    total += (tokens.reasoningOutputTokens / 1_000_000) * rate.reasoningOutputPer1MUsd;
  }
  return Number(total.toFixed(6));
}

function buildClaudeUsageDedupKey(raw: Record<string, unknown>, message: Record<string, unknown>): string {
  const requestId = asString(raw.requestId).trim();
  if (requestId) return `request:${requestId}`;

  const messageId = asString(message.id).trim();
  if (messageId) return `message:${messageId}`;

  return "";
}

function codexTokensForCost(totals: TokenTotals): TokenTotals {
  return {
    ...totals,
    // Codex reports cached tokens as part of input; subtract once for pricing.
    inputTokens: Math.max(0, totals.inputTokens - totals.cachedReadTokens - totals.cachedCreateTokens),
  };
}

function deriveClaudeMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  const seenRows = new Set<Record<string, unknown>>();
  const seenUsageKeys = new Set<string>();

  for (const event of events) {
    const raw = event.raw;
    if (seenRows.has(raw)) continue;
    seenRows.add(raw);

    if (asString(raw.type).toLowerCase() !== "assistant") continue;
    const message = asRecord(raw.message);
    const usage = asRecord(message.usage);
    if (Object.keys(usage).length === 0) continue;
    const usageKey = buildClaudeUsageDedupKey(raw, message);
    if (usageKey) {
      if (seenUsageKeys.has(usageKey)) continue;
      seenUsageKeys.add(usageKey);
    }
    const model = asString(message.model) || "<unknown>";
    const usageTotals = tokenTotalsFromUsageRecord(usage);
    addTokenTotals(totals, usageTotals);

    const existing = modelBreakdown.get(model) ?? emptyTokenTotals();
    addTokenTotals(existing, usageTotals);
    modelBreakdown.set(model, existing);

    const promptTokens = usageTotals.inputTokens + usageTotals.cachedReadTokens + usageTotals.cachedCreateTokens;
    const window = resolveWindow(model);
    if (window > 0 && promptTokens > 0) {
      const pct = (promptTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    }
  }

  for (const [model, modelTotals] of modelBreakdown) {
    modelBreakdown.set(model, finalizeTokenTotals(modelTotals));
  }

  return {
    tokenTotals: finalizeTokenTotals(totals),
    modelTokenSharesTop: buildTopModelShares(
      new Map([...modelBreakdown.entries()].map(([model, modelTotals]) => [model, modelTotals.totalTokens] as const)),
      config.traceInspector.topModelCount,
    ),
    modelTokenSharesEstimated: false,
    contextWindowPct: maxContextPct,
    costEstimateUsd: estimateCost(modelBreakdown, config.cost),
  };
}

function deriveCodexMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const rows: Record<string, unknown>[] = [];
  const seenRows = new Set<Record<string, unknown>>();
  for (const event of events) {
    if (seenRows.has(event.raw)) continue;
    seenRows.add(event.raw);
    rows.push(event.raw);
  }

  let currentModel = "";
  let latestTotals = emptyTokenTotals();
  let prevTotalTokens: number | null = null;
  let maxContextPct: number | null = null;
  const modelTotalDeltas = new Map<string, number>();

  for (const row of rows) {
    const rowType = asString(row.type).toLowerCase();
    if (rowType === "turn_context") {
      const payload = asRecord(row.payload);
      const model = asString(payload.model);
      if (model) currentModel = model;
      continue;
    }

    if (rowType !== "event_msg") continue;
    const payload = asRecord(row.payload);
    if (asString(payload.type).toLowerCase() !== "token_count") continue;

    const info = asRecord(payload.info);
    const totalUsage = asRecord(info.total_token_usage);
    const lastUsage = asRecord(info.last_token_usage);
    latestTotals = tokenTotalsFromCodexUsageRecord(totalUsage);

    const deltaTotal = prevTotalTokens === null ? latestTotals.totalTokens : Math.max(0, latestTotals.totalTokens - prevTotalTokens);
    if (deltaTotal > 0) {
      const modelKey = currentModel || "<unknown>";
      modelTotalDeltas.set(modelKey, (modelTotalDeltas.get(modelKey) ?? 0) + deltaTotal);
    }
    prevTotalTokens = latestTotals.totalTokens;

    const windowFromEvent = toNumber(info.model_context_window);
    const window = windowFromEvent > 0 ? windowFromEvent : resolveWindow(currentModel);
    const promptTokens =
      toNumber(lastUsage.input_tokens) + toNumber(lastUsage.cached_input_tokens) + toNumber(lastUsage.cache_creation_input_tokens);
    const fallbackPromptTokens = promptTokens > 0 ? promptTokens : toNumber(lastUsage.total_tokens);
    if (window > 0 && fallbackPromptTokens > 0) {
      const pct = (fallbackPromptTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    }
  }

  const tokenTotals = finalizeTokenTotals(latestTotals);
  const topShares = buildTopModelShares(modelTotalDeltas, config.traceInspector.topModelCount);

  const modelBreakdown = new Map<string, TokenTotals>();
  const allModelShares = [...modelTotalDeltas.entries()].filter(([, tokens]) => tokens > 0);
  const shareTotal = allModelShares.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (shareTotal > 0) {
    for (const [model, modelTokens] of allModelShares) {
      const ratio = modelTokens / shareTotal;
      modelBreakdown.set(model, codexTokensForCost({
        inputTokens: tokenTotals.inputTokens * ratio,
        cachedReadTokens: tokenTotals.cachedReadTokens * ratio,
        cachedCreateTokens: tokenTotals.cachedCreateTokens * ratio,
        outputTokens: tokenTotals.outputTokens * ratio,
        reasoningOutputTokens: tokenTotals.reasoningOutputTokens * ratio,
        totalTokens: tokenTotals.totalTokens * ratio,
      }));
    }
  }

  return {
    tokenTotals,
    modelTokenSharesTop: topShares,
    modelTokenSharesEstimated: topShares.length > 0,
    contextWindowPct: maxContextPct,
    costEstimateUsd: estimateCost(modelBreakdown, config.cost),
  };
}

function deriveOpenCodeMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  const seenAssistantMessageIds = new Set<string>();

  for (const event of events) {
    const raw = asRecord(event.raw);
    const nestedMessage = asRecord(raw.message);
    const message = Object.keys(nestedMessage).length > 0 ? nestedMessage : raw;
    if (asString(message.role).toLowerCase() !== "assistant") continue;

    const messageId = asString(message.id);
    if (messageId && seenAssistantMessageIds.has(messageId)) continue;
    if (messageId) seenAssistantMessageIds.add(messageId);

    const tokens = asRecord(message.tokens);
    if (Object.keys(tokens).length === 0) continue;
    const usageTotals = tokenTotalsFromOpenCodeTokensRecord(tokens);
    addTokenTotals(totals, usageTotals);

    const modelId = asString(message.modelID) || asString(asRecord(message.model).modelID);
    const providerId = asString(message.providerID) || asString(asRecord(message.model).providerID);
    const model = modelId || (providerId ? `${providerId}/<unknown>` : "<unknown>");

    const existing = modelBreakdown.get(model) ?? emptyTokenTotals();
    addTokenTotals(existing, usageTotals);
    modelBreakdown.set(model, existing);

    const promptTokens = usageTotals.inputTokens + usageTotals.cachedReadTokens + usageTotals.cachedCreateTokens;
    const window = resolveWindow(modelId || model);
    if (window > 0 && promptTokens > 0) {
      const pct = (promptTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    }
  }

  for (const [model, modelTotals] of modelBreakdown) {
    modelBreakdown.set(model, finalizeTokenTotals(modelTotals));
  }

  return {
    tokenTotals: finalizeTokenTotals(totals),
    modelTokenSharesTop: buildTopModelShares(
      new Map([...modelBreakdown.entries()].map(([model, modelTotals]) => [model, modelTotals.totalTokens] as const)),
      config.traceInspector.topModelCount,
    ),
    modelTokenSharesEstimated: false,
    contextWindowPct: maxContextPct,
    costEstimateUsd: estimateCost(modelBreakdown, config.cost),
  };
}

function deriveCursorMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;

  const modelFallback =
    events
      .map((event) => asString(asRecord(event.raw).model).trim())
      .find((model) => model.length > 0) ?? "<unknown>";
  let currentModel = modelFallback;

  for (const event of events) {
    const eventModel = asString(asRecord(event.raw).model).trim();
    if (eventModel) currentModel = eventModel;
    const model = currentModel || "<unknown>";
    const estimatedTokens = estimateTokenCountFromTextBlocks(event.textBlocks);
    if (estimatedTokens <= 0) continue;

    const modelTotals = modelBreakdown.get(model) ?? emptyTokenTotals();
    const applyPromptWindowEstimate = (): void => {
      const window = resolveWindow(model);
      if (window <= 0) return;
      const pct = (estimatedTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    };

    if (event.eventKind === "user" || event.eventKind === "tool_result") {
      totals.inputTokens += estimatedTokens;
      modelTotals.inputTokens += estimatedTokens;
      applyPromptWindowEstimate();
      modelBreakdown.set(model, modelTotals);
      continue;
    }

    if (event.eventKind === "assistant" || event.eventKind === "tool_use" || event.eventKind === "reasoning") {
      totals.outputTokens += estimatedTokens;
      modelTotals.outputTokens += estimatedTokens;
      if (event.eventKind === "reasoning") {
        totals.reasoningOutputTokens += estimatedTokens;
        modelTotals.reasoningOutputTokens += estimatedTokens;
      }
      modelBreakdown.set(model, modelTotals);
    }
  }

  for (const [model, modelTotals] of modelBreakdown) {
    modelBreakdown.set(model, finalizeTokenTotals(modelTotals));
  }

  return {
    tokenTotals: finalizeTokenTotals(totals),
    modelTokenSharesTop: buildTopModelShares(
      new Map([...modelBreakdown.entries()].map(([model, modelTotals]) => [model, modelTotals.totalTokens] as const)),
      config.traceInspector.topModelCount,
    ),
    modelTokenSharesEstimated: modelBreakdown.size > 0,
    contextWindowPct: maxContextPct,
    costEstimateUsd: estimateCost(modelBreakdown, config.cost),
  };
}

export function deriveSessionMetrics(events: NormalizedEvent[], agent: AgentKind, config: AppConfig): SessionMetrics {
  if (agent === "claude") return deriveClaudeMetrics(events, config);
  if (agent === "codex") return deriveCodexMetrics(events, config);
  if (agent === "cursor") return deriveCursorMetrics(events, config);
  if (agent === "opencode") return deriveOpenCodeMetrics(events, config);
  return {
    tokenTotals: emptyTokenTotals(),
    modelTokenSharesTop: [],
    modelTokenSharesEstimated: false,
    contextWindowPct: null,
    costEstimateUsd: null,
  };
}
