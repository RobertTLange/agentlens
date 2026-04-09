import type { CostModelRate, ModelContextWindow } from "@agentlens/contracts";

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
export const DEFAULT_PRICING_SYNC_USER_AGENT = "agentlens-pricing-sync/0.1";
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

const CANONICAL_PROVIDER_ORDER = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistral",
  "cohere",
  "xai",
  "alibaba",
  "minimax",
  "moonshotai",
  "perplexity",
  "upstage",
  "zai",
  "zhipuai",
] as const;
const CANONICAL_PROVIDERS = new Set<string>(CANONICAL_PROVIDER_ORDER);

const ANTHROPIC_OVERRIDES: Readonly<Record<string, Partial<CostModelRate>>> = {
  "claude-opus-4.6": {
    cachedCreate1hPer1MUsd: 10,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextInputPer1MUsd: 10,
    longContextOutputPer1MUsd: 37.5,
    longContextCachedReadPer1MUsd: 1,
    longContextCachedCreatePer1MUsd: 12.5,
    longContextCachedCreate5mPer1MUsd: 12.5,
    longContextCachedCreate1hPer1MUsd: 20,
  },
  "claude-opus-4.5": {
    cachedCreate1hPer1MUsd: 10,
  },
  "claude-sonnet-4.6": {
    cachedCreate1hPer1MUsd: 6,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextInputPer1MUsd: 6,
    longContextOutputPer1MUsd: 22.5,
    longContextCachedReadPer1MUsd: 0.6,
    longContextCachedCreatePer1MUsd: 7.5,
    longContextCachedCreate5mPer1MUsd: 7.5,
    longContextCachedCreate1hPer1MUsd: 12,
  },
  "claude-sonnet-4.5": {
    cachedCreate1hPer1MUsd: 6,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextInputPer1MUsd: 6,
    longContextOutputPer1MUsd: 22.5,
    longContextCachedReadPer1MUsd: 0.6,
    longContextCachedCreatePer1MUsd: 7.5,
    longContextCachedCreate5mPer1MUsd: 7.5,
    longContextCachedCreate1hPer1MUsd: 12,
  },
  "claude-haiku-4.5": {
    cachedCreate1hPer1MUsd: 2,
  },
};

export interface PricingCatalog {
  fetchedAt: string;
  sources: string[];
  modelRates: CostModelRate[];
  contextWindows: ModelContextWindow[];
}

export interface FetchPricingCatalogOptions {
  url?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  fetchedAt?: string;
}

interface SourceEntry {
  provider: string;
  rawModel: string;
  modelData: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function hasRelevantCostField(cost: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(cost, field) && isFiniteNumber(cost[field]);
}

function hasRelevantCost(cost: unknown): boolean {
  const normalizedCost = asRecord(cost);
  if (Object.keys(normalizedCost).length === 0) return false;
  if (
    hasRelevantCostField(normalizedCost, "input") ||
    hasRelevantCostField(normalizedCost, "output") ||
    hasRelevantCostField(normalizedCost, "reasoning") ||
    hasRelevantCostField(normalizedCost, "cache_read") ||
    hasRelevantCostField(normalizedCost, "cache_write")
  ) {
    return true;
  }
  const longContext = asRecord(normalizedCost.context_over_200k);
  return (
    hasRelevantCostField(longContext, "input") ||
    hasRelevantCostField(longContext, "output") ||
    hasRelevantCostField(longContext, "reasoning") ||
    hasRelevantCostField(longContext, "cache_read") ||
    hasRelevantCostField(longContext, "cache_write")
  );
}

function providerPriority(provider: string): number {
  const index = CANONICAL_PROVIDER_ORDER.indexOf(provider as (typeof CANONICAL_PROVIDER_ORDER)[number]);
  return index >= 0 ? index : CANONICAL_PROVIDER_ORDER.length + 1;
}

function isDatedModelVariant(model: string): boolean {
  return /-\d{8}$/.test(model) || /-\d{4}-\d{2}-\d{2}$/.test(model);
}

function compareSourceEntries(left: SourceEntry, right: SourceEntry): number {
  const providerDelta = providerPriority(left.provider) - providerPriority(right.provider);
  if (providerDelta !== 0) return providerDelta;

  const leftDated = isDatedModelVariant(left.rawModel);
  const rightDated = isDatedModelVariant(right.rawModel);
  if (leftDated !== rightDated) return leftDated ? 1 : -1;

  const providerNameDelta = compareText(left.provider, right.provider);
  if (providerNameDelta !== 0) return providerNameDelta;
  return compareText(left.rawModel, right.rawModel);
}

function toAgentLensCanonicalModelId(provider: string, rawModel: string): string {
  const model = String(rawModel).trim();
  if (!model) return "";
  if (provider !== "anthropic") return model;

  const anthropicMatch = model.match(/^claude-(haiku|sonnet|opus)-4-(5|6)(?:-\d{8})?$/);
  if (!anthropicMatch) return model;
  return `claude-${anthropicMatch[1]}-4.${anthropicMatch[2]}`;
}

function emittedModelKeys(provider: string, rawModel: string): string[] {
  const model = String(rawModel).trim();
  if (!model) return [];

  const keys: string[] = [];
  if (CANONICAL_PROVIDERS.has(provider) && !model.includes("/")) {
    keys.push(model);
    const canonicalModel = toAgentLensCanonicalModelId(provider, model);
    if (canonicalModel && !canonicalModel.includes("/")) {
      keys.push(canonicalModel);
    }
  }
  keys.push(`${provider}/${model}`);
  return Array.from(new Set(keys));
}

function buildBaseRate(modelData: Record<string, unknown>): Omit<CostModelRate, "model"> {
  const cost = asRecord(modelData.cost);
  const rate: Omit<CostModelRate, "model"> = {
    inputPer1MUsd: isFiniteNumber(cost.input) ? cost.input : 0,
    outputPer1MUsd: isFiniteNumber(cost.output) ? cost.output : 0,
    cachedReadPer1MUsd: isFiniteNumber(cost.cache_read) ? cost.cache_read : 0,
    cachedCreatePer1MUsd: isFiniteNumber(cost.cache_write) ? cost.cache_write : 0,
    reasoningOutputPer1MUsd: isFiniteNumber(cost.reasoning) ? cost.reasoning : 0,
  };

  const longContext = asRecord(cost.context_over_200k);
  if (Object.keys(longContext).length > 0) {
    rate.longContextThresholdTokens = LONG_CONTEXT_THRESHOLD_TOKENS;
    if (isFiniteNumber(longContext.input)) rate.longContextInputPer1MUsd = longContext.input;
    if (isFiniteNumber(longContext.output)) rate.longContextOutputPer1MUsd = longContext.output;
    if (isFiniteNumber(longContext.cache_read)) rate.longContextCachedReadPer1MUsd = longContext.cache_read;
    if (isFiniteNumber(longContext.cache_write)) rate.longContextCachedCreatePer1MUsd = longContext.cache_write;
    if (isFiniteNumber(longContext.reasoning)) rate.longContextReasoningOutputPer1MUsd = longContext.reasoning;
  }

  const contextWindowTokens = asRecord(modelData.limit).context;
  if (isFiniteNumber(contextWindowTokens) && contextWindowTokens > 0) {
    rate.contextWindowTokens = Math.round(contextWindowTokens);
  }

  return rate;
}

function resolveAnthropicOverrideKey(model: string): string | null {
  let candidate = String(model).trim();
  if (!candidate) return null;
  if (candidate.startsWith("anthropic/")) {
    candidate = candidate.slice("anthropic/".length);
  } else if (candidate.includes("/")) {
    return null;
  }

  if (/^claude-opus-4(?:\.6|-6(?:-\d{8})?)$/.test(candidate)) return "claude-opus-4.6";
  if (/^claude-opus-4(?:\.5|-5(?:-\d{8})?)$/.test(candidate)) return "claude-opus-4.5";
  if (/^claude-sonnet-4(?:\.6|-6(?:-\d{8})?)$/.test(candidate)) return "claude-sonnet-4.6";
  if (/^claude-sonnet-4(?:\.5|-5(?:-\d{8})?)$/.test(candidate)) return "claude-sonnet-4.5";
  if (/^claude-haiku-4(?:\.5|-5(?:-\d{8})?)$/.test(candidate)) return "claude-haiku-4.5";
  return null;
}

function applyAnthropicOverrides(model: string, baseRate: Omit<CostModelRate, "model">): Omit<CostModelRate, "model"> {
  const overrideKey = resolveAnthropicOverrideKey(model);
  if (!overrideKey) return { ...baseRate };

  const nextRate: Omit<CostModelRate, "model"> = { ...baseRate };
  if (isFiniteNumber(nextRate.cachedCreatePer1MUsd) && nextRate.cachedCreate5mPer1MUsd === undefined) {
    nextRate.cachedCreate5mPer1MUsd = nextRate.cachedCreatePer1MUsd;
  }
  const override = ANTHROPIC_OVERRIDES[overrideKey];
  return override ? { ...nextRate, ...override } : nextRate;
}

function addRate(rateByModel: Map<string, CostModelRate>, model: string, rate: Omit<CostModelRate, "model">): void {
  if (rateByModel.has(model)) return;
  rateByModel.set(model, { model, ...rate });
}

function addContextWindow(
  contextByModel: Map<string, ModelContextWindow>,
  model: string,
  contextWindowTokens: number | undefined,
): void {
  if (!isFiniteNumber(contextWindowTokens) || contextWindowTokens <= 0 || contextByModel.has(model)) return;
  contextByModel.set(model, { model, contextWindowTokens: Math.round(contextWindowTokens) });
}

export function buildPricingCatalog(sourceApi: unknown, fetchedAt = new Date().toISOString()): PricingCatalog {
  const api = asRecord(sourceApi);
  const sourceEntries: SourceEntry[] = [];

  for (const [provider, providerData] of Object.entries(api)) {
    if (!CANONICAL_PROVIDERS.has(provider)) continue;
    const models = asRecord(asRecord(providerData).models);
    for (const [rawModel, modelData] of Object.entries(models)) {
      const normalizedModelData = asRecord(modelData);
      if (!hasRelevantCost(normalizedModelData.cost)) continue;
      sourceEntries.push({ provider, rawModel, modelData: normalizedModelData });
    }
  }

  sourceEntries.sort(compareSourceEntries);

  const rateByModel = new Map<string, CostModelRate>();
  const contextByModel = new Map<string, ModelContextWindow>();

  for (const entry of sourceEntries) {
    const baseRate = buildBaseRate(entry.modelData);
    for (const model of emittedModelKeys(entry.provider, entry.rawModel)) {
      const rate = applyAnthropicOverrides(model, baseRate);
      addRate(rateByModel, model, rate);
      addContextWindow(contextByModel, model, rate.contextWindowTokens);
    }
  }

  return {
    fetchedAt,
    sources: [DEFAULT_MODELS_DEV_URL, "local Anthropic cache-tier overrides"],
    modelRates: Array.from(rateByModel.values()).sort((left, right) => compareText(left.model, right.model)),
    contextWindows: Array.from(contextByModel.values()).sort((left, right) => compareText(left.model, right.model)),
  };
}

export async function fetchPricingCatalog(options: FetchPricingCatalogOptions = {}): Promise<PricingCatalog> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? DEFAULT_MODELS_DEV_URL;
  const requestInit: RequestInit = {
    headers: {
      "user-agent": options.userAgent ?? DEFAULT_PRICING_SYNC_USER_AGENT,
      accept: "application/json",
    },
  };
  if (options.signal) requestInit.signal = options.signal;
  const response = await fetchImpl(url, requestInit);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as unknown;
  return buildPricingCatalog(payload, options.fetchedAt ?? new Date().toISOString());
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toString();
  return text.includes(".") ? text : `${text}`;
}

export function renderGeneratedPricingFile(catalog: PricingCatalog, generatedAt = new Date().toISOString()): string {
  const header = [
    'import type { CostModelRate, ModelContextWindow } from "@agentlens/contracts";',
    "",
    `// Generated by scripts/sync-pricing.ts on ${generatedAt}.`,
    `// Sources: ${catalog.sources.join(", ")}`,
    "export const DEFAULT_PRICING_MODEL_RATES: CostModelRate[] = [",
  ];

  const ratesBody = catalog.modelRates
    .map((rate) => {
      const fields = Object.entries(rate)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `    ${key}: ${typeof value === "string" ? `"${value}"` : formatNumber(value)},`);
      return ["  {", ...fields, "  },"].join("\n");
    })
    .join("\n");

  const contextBody = catalog.contextWindows
    .map(
      (entry) =>
        `  { model: "${entry.model}", contextWindowTokens: ${formatNumber(entry.contextWindowTokens)} },`,
    )
    .join("\n");

  return [
    ...header,
    ratesBody,
    "];",
    "",
    "export const DEFAULT_CONTEXT_WINDOWS: ModelContextWindow[] = [",
    contextBody,
    "];",
    "",
  ].join("\n");
}
