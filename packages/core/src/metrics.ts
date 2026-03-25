import type { AgentKind, AppConfig, ModelTokenShare, NormalizedEvent, TokenTotals } from "@agentlens/contracts";
import { estimateUsageCost, resolveContextWindowTokens } from "./pricing.js";
import { asRecord, asString } from "./utils.js";

export interface SessionUsagePoint {
  timestampMs: number;
  agent: AgentKind;
  model: string;
  inputTokens: number;
  cachedReadTokens: number;
  cachedCreateTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface SessionMetrics {
  tokenTotals: TokenTotals;
  modelTokenSharesTop: ModelTokenShare[];
  modelTokenSharesEstimated: boolean;
  contextWindowPct: number | null;
  costEstimateUsd: number | null;
  usagePoints: SessionUsagePoint[];
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

function claudeCacheCreationBreakdown(usageRecord: Record<string, unknown>): {
  cachedCreateTokens: number;
  cachedCreate5mTokens: number;
  cachedCreate1hTokens: number;
} {
  const cacheCreation = asRecord(usageRecord.cache_creation);
  const cachedCreate5mTokens = toNumber(cacheCreation.ephemeral_5m_input_tokens);
  const cachedCreate1hTokens = toNumber(cacheCreation.ephemeral_1h_input_tokens);
  const cachedCreateTokens = Math.max(
    toNumber(usageRecord.cache_creation_input_tokens),
    cachedCreate5mTokens + cachedCreate1hTokens,
  );
  return {
    cachedCreateTokens,
    cachedCreate5mTokens,
    cachedCreate1hTokens,
  };
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

function codexInputIncludesCached(record: Record<string, unknown>): boolean {
  const inputTokens = toNumber(record.input_tokens);
  const cachedReadTokens = toNumber(record.cached_input_tokens);
  const outputTokens = toNumber(record.output_tokens);
  const reasoningOutputTokens = toNumber(record.reasoning_output_tokens);
  const totalTokens = toNumber(record.total_tokens);
  if (cachedReadTokens <= 0 || totalTokens <= 0) return false;
  return inputTokens + cachedReadTokens + outputTokens + reasoningOutputTokens > totalTokens;
}

function codexPromptTokens(record: Record<string, unknown>): number {
  const inputTokens = toNumber(record.input_tokens);
  const cachedReadTokens = toNumber(record.cached_input_tokens);
  return codexInputIncludesCached(record) ? inputTokens : inputTokens + cachedReadTokens;
}

function codexBillableInputTokens(record: Record<string, unknown>): number {
  const inputTokens = toNumber(record.input_tokens);
  const cachedReadTokens = toNumber(record.cached_input_tokens);
  return codexInputIncludesCached(record) ? Math.max(0, inputTokens - cachedReadTokens) : inputTokens;
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

function tokenTotalsFromGeminiTokensRecord(record: Record<string, unknown>): TokenTotals {
  const totals = emptyTokenTotals();
  totals.inputTokens = toNumber(record.input);
  totals.cachedReadTokens = toNumber(record.cached);
  totals.cachedCreateTokens = 0;
  totals.outputTokens = toNumber(record.output) + toNumber(record.tool);
  totals.reasoningOutputTokens = toNumber(record.thoughts);
  totals.totalTokens = toNumber(record.total);
  return finalizeTokenTotals(totals);
}

function tokenTotalsFromPiUsageRecord(record: Record<string, unknown>): TokenTotals {
  const totals = emptyTokenTotals();
  totals.inputTokens = toNumber(record.input);
  totals.cachedReadTokens = toNumber(record.cacheRead);
  totals.cachedCreateTokens = toNumber(record.cacheWrite);
  totals.outputTokens = toNumber(record.output);
  totals.reasoningOutputTokens = toNumber(record.reasoning);
  totals.totalTokens = toNumber(record.totalTokens);
  return finalizeTokenTotals(totals);
}

function contextWindowResolver(config: AppConfig): (model: string) => number {
  return (model: string): number => resolveContextWindowTokens(model, config);
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

  let total = 0;
  for (const [model, tokens] of perModel) {
    const cost = estimateUsageCost(
      {
        model,
        promptTokens: tokens.inputTokens + tokens.cachedReadTokens + tokens.cachedCreateTokens,
        inputTokens: tokens.inputTokens,
        cachedReadTokens: tokens.cachedReadTokens,
        cachedCreateTokens: tokens.cachedCreateTokens,
        outputTokens: tokens.outputTokens,
        reasoningOutputTokens: tokens.reasoningOutputTokens,
      },
      costConfig,
    );
    if (cost === null) return null;
    total += cost;
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

function finalizeCostTotal(costKnown: boolean, total: number): number | null {
  if (!costKnown) return null;
  return Number(total.toFixed(6));
}

function usagePointFromTotals(
  event: NormalizedEvent,
  agent: AgentKind,
  model: string,
  totals: TokenTotals,
  costUsd: number | null,
): SessionUsagePoint | null {
  if (event.timestampMs === null || event.timestampMs <= 0) return null;
  return {
    timestampMs: event.timestampMs,
    agent,
    model,
    inputTokens: totals.inputTokens,
    cachedReadTokens: totals.cachedReadTokens,
    cachedCreateTokens: totals.cachedCreateTokens,
    outputTokens: totals.outputTokens,
    reasoningOutputTokens: totals.reasoningOutputTokens,
    totalTokens: totals.totalTokens,
    costUsd: costUsd === null ? 0 : Number(costUsd.toFixed(6)),
  };
}

function deriveClaudeMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  let costTotal = 0;
  let costKnown = config.cost.enabled;
  const seenRows = new Set<Record<string, unknown>>();
  const seenUsageKeys = new Set<string>();
  const usagePoints: SessionUsagePoint[] = [];

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
    const cacheCreation = claudeCacheCreationBreakdown(usage);
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

    const cost = estimateUsageCost(
      {
        model,
        promptTokens,
        inputTokens: usageTotals.inputTokens,
        cachedReadTokens: usageTotals.cachedReadTokens,
        cachedCreateTokens: cacheCreation.cachedCreateTokens,
        cachedCreate5mTokens: cacheCreation.cachedCreate5mTokens,
        cachedCreate1hTokens: cacheCreation.cachedCreate1hTokens,
        outputTokens: usageTotals.outputTokens,
        reasoningOutputTokens: usageTotals.reasoningOutputTokens,
      },
      config.cost,
    );
    if (cost === null) {
      costKnown = false;
    } else {
      costTotal += cost;
    }
    const usagePoint = usagePointFromTotals(event, "claude", model, usageTotals, cost);
    if (usagePoint) usagePoints.push(usagePoint);
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
    costEstimateUsd: finalizeCostTotal(costKnown, costTotal),
    usagePoints,
  };
}

function deriveCodexMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const rows: Array<{ raw: Record<string, unknown>; event: NormalizedEvent }> = [];
  const seenRows = new Set<Record<string, unknown>>();
  for (const event of events) {
    if (seenRows.has(event.raw)) continue;
    seenRows.add(event.raw);
    rows.push({ raw: event.raw, event });
  }

  let currentModel = "";
  let latestTotals = emptyTokenTotals();
  let prevTotalTokens: number | null = null;
  let maxContextPct: number | null = null;
  let costTotal = 0;
  let costKnown = config.cost.enabled;
  const modelTotalDeltas = new Map<string, number>();
  const usagePoints: SessionUsagePoint[] = [];

  for (const { raw: row, event } of rows) {
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
    const pricedUsage = Object.keys(lastUsage).length > 0 ? lastUsage : totalUsage;
    const promptTokens = codexPromptTokens(pricedUsage);
    const fallbackPromptTokens = promptTokens > 0 ? promptTokens : toNumber(pricedUsage.total_tokens);
    if (window > 0 && fallbackPromptTokens > 0) {
      const pct = (fallbackPromptTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    }

    if (currentModel) {
      const cost = estimateUsageCost(
        {
          model: currentModel,
          promptTokens: fallbackPromptTokens,
          inputTokens: codexBillableInputTokens(pricedUsage),
          cachedReadTokens: toNumber(pricedUsage.cached_input_tokens),
          cachedCreateTokens: 0,
          outputTokens: toNumber(pricedUsage.output_tokens),
          reasoningOutputTokens: toNumber(pricedUsage.reasoning_output_tokens),
        },
        config.cost,
      );
      if (cost === null) {
        costKnown = false;
      } else {
        costTotal += cost;
      }
      const usageTotals = tokenTotalsFromCodexUsageRecord(pricedUsage);
      const usagePoint = usagePointFromTotals(event, "codex", currentModel, usageTotals, cost);
      if (usagePoint) usagePoints.push(usagePoint);
    } else {
      const usageTotals = tokenTotalsFromCodexUsageRecord(pricedUsage);
      const usagePoint = usagePointFromTotals(event, "codex", "<unknown>", usageTotals, null);
      if (usagePoint) usagePoints.push(usagePoint);
    }
  }

  const tokenTotals = finalizeTokenTotals(latestTotals);
  const topShares = buildTopModelShares(modelTotalDeltas, config.traceInspector.topModelCount);

  return {
    tokenTotals,
    modelTokenSharesTop: topShares,
    modelTokenSharesEstimated: topShares.length > 0,
    contextWindowPct: maxContextPct,
    costEstimateUsd: finalizeCostTotal(costKnown, costTotal),
    usagePoints,
  };
}

function deriveOpenCodeMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  let costTotal = 0;
  let costKnown = config.cost.enabled;
  const seenAssistantMessageIds = new Set<string>();
  const usagePoints: SessionUsagePoint[] = [];

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

    const cost = estimateUsageCost(
      {
        model: modelId || model,
        promptTokens,
        inputTokens: usageTotals.inputTokens,
        cachedReadTokens: usageTotals.cachedReadTokens,
        cachedCreateTokens: usageTotals.cachedCreateTokens,
        outputTokens: usageTotals.outputTokens,
        reasoningOutputTokens: usageTotals.reasoningOutputTokens,
      },
      config.cost,
    );
    if (cost === null) {
      costKnown = false;
    } else {
      costTotal += cost;
    }
    const usagePoint = usagePointFromTotals(event, "opencode", modelId || model, usageTotals, cost);
    if (usagePoint) usagePoints.push(usagePoint);
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
    costEstimateUsd: finalizeCostTotal(costKnown, costTotal),
    usagePoints,
  };
}

function deriveCursorMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  const usagePoints: SessionUsagePoint[] = [];

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
      const usageTotals = finalizeTokenTotals({
        ...emptyTokenTotals(),
        inputTokens: estimatedTokens,
      });
      const cost = estimateUsageCost(
        {
          model,
          promptTokens: usageTotals.inputTokens,
          inputTokens: usageTotals.inputTokens,
          cachedReadTokens: 0,
          cachedCreateTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        config.cost,
      );
      const usagePoint = usagePointFromTotals(event, "cursor", model, usageTotals, cost);
      if (usagePoint) usagePoints.push(usagePoint);
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
      const usageTotals = finalizeTokenTotals({
        ...emptyTokenTotals(),
        outputTokens: estimatedTokens,
        reasoningOutputTokens: event.eventKind === "reasoning" ? estimatedTokens : 0,
      });
      const cost = estimateUsageCost(
        {
          model,
          promptTokens: 0,
          inputTokens: 0,
          cachedReadTokens: 0,
          cachedCreateTokens: 0,
          outputTokens: usageTotals.outputTokens,
          reasoningOutputTokens: usageTotals.reasoningOutputTokens,
        },
        config.cost,
      );
      const usagePoint = usagePointFromTotals(event, "cursor", model, usageTotals, cost);
      if (usagePoint) usagePoints.push(usagePoint);
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
    usagePoints,
  };
}

function deriveGeminiMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  const seenMessageIds = new Set<string>();
  const seenRows = new Set<Record<string, unknown>>();
  const usagePoints: SessionUsagePoint[] = [];

  for (const event of events) {
    const raw = asRecord(event.raw);
    if (seenRows.has(raw)) continue;
    seenRows.add(raw);

    const rawType = asString(raw.type).toLowerCase();
    if (rawType !== "gemini" && rawType !== "assistant" && rawType !== "model") continue;

    const messageId = asString(raw.id);
    if (messageId && seenMessageIds.has(messageId)) continue;
    if (messageId) seenMessageIds.add(messageId);

    const tokens = asRecord(raw.tokens);
    if (Object.keys(tokens).length === 0) continue;
    const usageTotals = tokenTotalsFromGeminiTokensRecord(tokens);
    addTokenTotals(totals, usageTotals);

    const model = asString(raw.model || raw.modelVersion) || "<unknown>";
    const existing = modelBreakdown.get(model) ?? emptyTokenTotals();
    addTokenTotals(existing, usageTotals);
    modelBreakdown.set(model, existing);

    const promptTokens = usageTotals.inputTokens + usageTotals.cachedReadTokens;
    const window = resolveWindow(model);
    if (window > 0 && promptTokens > 0) {
      const pct = (promptTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    }
    const cost = estimateUsageCost(
      {
        model,
        promptTokens,
        inputTokens: usageTotals.inputTokens,
        cachedReadTokens: usageTotals.cachedReadTokens,
        cachedCreateTokens: usageTotals.cachedCreateTokens,
        outputTokens: usageTotals.outputTokens,
        reasoningOutputTokens: usageTotals.reasoningOutputTokens,
      },
      config.cost,
    );
    const usagePoint = usagePointFromTotals(event, "gemini", model, usageTotals, cost);
    if (usagePoint) usagePoints.push(usagePoint);
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
    usagePoints,
  };
}

function derivePiMetrics(events: NormalizedEvent[], config: AppConfig): SessionMetrics {
  const resolveWindow = contextWindowResolver(config);
  const totals = emptyTokenTotals();
  const modelBreakdown = new Map<string, TokenTotals>();
  let maxContextPct: number | null = null;
  const seenRows = new Set<Record<string, unknown>>();

  let embeddedCostTotal = 0;
  let embeddedCostKnown = false;
  let estimatedCostTotal = 0;
  let estimatedCostKnown = config.cost.enabled;
  const usagePoints: SessionUsagePoint[] = [];

  for (const event of events) {
    const raw = asRecord(event.raw);
    if (seenRows.has(raw)) continue;
    seenRows.add(raw);

    const rawType = asString(raw.type).toLowerCase();
    if (rawType !== "message") continue;

    const message = asRecord(raw.message);
    if (asString(message.role).toLowerCase() !== "assistant") continue;

    const usage = asRecord(message.usage);
    if (Object.keys(usage).length === 0) continue;

    const usageTotals = tokenTotalsFromPiUsageRecord(usage);
    addTokenTotals(totals, usageTotals);

    const model = asString(message.model || message.modelId) || "<unknown>";
    const existing = modelBreakdown.get(model) ?? emptyTokenTotals();
    addTokenTotals(existing, usageTotals);
    modelBreakdown.set(model, existing);

    const promptTokens = usageTotals.inputTokens + usageTotals.cachedReadTokens + usageTotals.cachedCreateTokens;
    const window = resolveWindow(model);
    if (window > 0 && promptTokens > 0) {
      const pct = (promptTokens / window) * 100;
      maxContextPct = maxContextPct === null ? pct : Math.max(maxContextPct, pct);
    }

    const cost = asRecord(usage.cost);
    if (Object.prototype.hasOwnProperty.call(cost, "total")) {
      const total = Number(cost.total);
      if (Number.isFinite(total)) {
        embeddedCostTotal += total;
        embeddedCostKnown = true;
      }
    }

    const estimatedCost = estimateUsageCost(
      {
        model,
        promptTokens,
        inputTokens: usageTotals.inputTokens,
        cachedReadTokens: usageTotals.cachedReadTokens,
        cachedCreateTokens: usageTotals.cachedCreateTokens,
        outputTokens: usageTotals.outputTokens,
        reasoningOutputTokens: usageTotals.reasoningOutputTokens,
      },
      config.cost,
    );
    if (estimatedCost === null) {
      estimatedCostKnown = false;
    } else {
      estimatedCostTotal += estimatedCost;
    }
    const preferredCost = Object.prototype.hasOwnProperty.call(cost, "total")
      ? (Number(cost.total) as number)
      : estimatedCost;
    const usagePoint = usagePointFromTotals(
      event,
      "pi",
      model,
      usageTotals,
      Number.isFinite(preferredCost) ? preferredCost : estimatedCost,
    );
    if (usagePoint) usagePoints.push(usagePoint);
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
    costEstimateUsd: embeddedCostKnown
      ? Number(embeddedCostTotal.toFixed(6))
      : finalizeCostTotal(estimatedCostKnown, estimatedCostTotal),
    usagePoints,
  };
}

export function deriveSessionMetrics(events: NormalizedEvent[], agent: AgentKind, config: AppConfig): SessionMetrics {
  if (agent === "claude") return deriveClaudeMetrics(events, config);
  if (agent === "codex") return deriveCodexMetrics(events, config);
  if (agent === "cursor") return deriveCursorMetrics(events, config);
  if (agent === "opencode") return deriveOpenCodeMetrics(events, config);
  if (agent === "gemini") return deriveGeminiMetrics(events, config);
  if (agent === "pi") return derivePiMetrics(events, config);
  return {
    tokenTotals: emptyTokenTotals(),
    modelTokenSharesTop: [],
    modelTokenSharesEstimated: false,
    contextWindowPct: null,
    costEstimateUsd: null,
    usagePoints: [],
  };
}
