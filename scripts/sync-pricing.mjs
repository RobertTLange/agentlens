import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MODELS_DEV_URL = "https://models.dev/api.json";
const OUTPUT_PATH = path.resolve("packages/core/src/generatedPricing.ts");
const USER_AGENT = "agentlens-pricing-sync/0.1";
const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

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
];
const CANONICAL_PROVIDERS = new Set(CANONICAL_PROVIDER_ORDER);

const ANTHROPIC_OVERRIDES = {
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  const text = value.toString();
  return text.includes(".") ? text : `${text}`;
}

function compareText(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function hasRelevantCostField(cost, field) {
  return Object.prototype.hasOwnProperty.call(cost, field) && isFiniteNumber(cost[field]);
}

function hasRelevantCost(cost) {
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return false;
  if (
    hasRelevantCostField(cost, "input") ||
    hasRelevantCostField(cost, "output") ||
    hasRelevantCostField(cost, "reasoning") ||
    hasRelevantCostField(cost, "cache_read") ||
    hasRelevantCostField(cost, "cache_write")
  ) {
    return true;
  }
  const longContext = cost.context_over_200k;
  if (!longContext || typeof longContext !== "object" || Array.isArray(longContext)) return false;
  return (
    hasRelevantCostField(longContext, "input") ||
    hasRelevantCostField(longContext, "output") ||
    hasRelevantCostField(longContext, "reasoning") ||
    hasRelevantCostField(longContext, "cache_read") ||
    hasRelevantCostField(longContext, "cache_write")
  );
}

function providerPriority(provider) {
  const index = CANONICAL_PROVIDER_ORDER.indexOf(provider);
  return index >= 0 ? index : CANONICAL_PROVIDER_ORDER.length + 1;
}

function isDatedModelVariant(model) {
  return /-\d{8}$/.test(model) || /-\d{4}-\d{2}-\d{2}$/.test(model);
}

function compareSourceEntries(left, right) {
  const providerDelta = providerPriority(left.provider) - providerPriority(right.provider);
  if (providerDelta !== 0) return providerDelta;

  const leftDated = isDatedModelVariant(left.rawModel);
  const rightDated = isDatedModelVariant(right.rawModel);
  if (leftDated !== rightDated) return leftDated ? 1 : -1;

  const providerNameDelta = compareText(left.provider, right.provider);
  if (providerNameDelta !== 0) return providerNameDelta;
  return compareText(left.rawModel, right.rawModel);
}

function toAgentLensCanonicalModelId(provider, rawModel) {
  const model = String(rawModel).trim();
  if (!model) return "";
  if (provider !== "anthropic") return model;

  const anthroMatch = model.match(/^claude-(haiku|sonnet|opus)-4-(5|6)(?:-\d{8})?$/);
  if (!anthroMatch) return model;
  return `claude-${anthroMatch[1]}-4.${anthroMatch[2]}`;
}

function emittedModelKeys(provider, rawModel) {
  const model = String(rawModel).trim();
  if (!model) return [];

  const keys = [];
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

function buildBaseRate(modelData) {
  const cost = modelData.cost ?? {};
  const rate = {
    inputPer1MUsd: isFiniteNumber(cost.input) ? cost.input : 0,
    outputPer1MUsd: isFiniteNumber(cost.output) ? cost.output : 0,
    cachedReadPer1MUsd: isFiniteNumber(cost.cache_read) ? cost.cache_read : 0,
    cachedCreatePer1MUsd: isFiniteNumber(cost.cache_write) ? cost.cache_write : 0,
    reasoningOutputPer1MUsd: isFiniteNumber(cost.reasoning) ? cost.reasoning : 0,
  };

  const longContext = cost.context_over_200k;
  if (longContext && typeof longContext === "object" && !Array.isArray(longContext)) {
    rate.longContextThresholdTokens = LONG_CONTEXT_THRESHOLD_TOKENS;
    if (isFiniteNumber(longContext.input)) rate.longContextInputPer1MUsd = longContext.input;
    if (isFiniteNumber(longContext.output)) rate.longContextOutputPer1MUsd = longContext.output;
    if (isFiniteNumber(longContext.cache_read)) rate.longContextCachedReadPer1MUsd = longContext.cache_read;
    if (isFiniteNumber(longContext.cache_write)) rate.longContextCachedCreatePer1MUsd = longContext.cache_write;
    if (isFiniteNumber(longContext.reasoning)) {
      rate.longContextReasoningOutputPer1MUsd = longContext.reasoning;
    }
  }

  const contextWindowTokens = modelData.limit?.context;
  if (isFiniteNumber(contextWindowTokens) && contextWindowTokens > 0) {
    rate.contextWindowTokens = Math.round(contextWindowTokens);
  }

  return rate;
}

function resolveAnthropicOverrideKey(model) {
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

function applyAnthropicOverrides(model, baseRate) {
  const overrideKey = resolveAnthropicOverrideKey(model);
  if (!overrideKey) return { ...baseRate };

  const nextRate = { ...baseRate };
  if (isFiniteNumber(nextRate.cachedCreatePer1MUsd) && nextRate.cachedCreate5mPer1MUsd === undefined) {
    nextRate.cachedCreate5mPer1MUsd = nextRate.cachedCreatePer1MUsd;
  }

  const override = ANTHROPIC_OVERRIDES[overrideKey];
  return override ? { ...nextRate, ...override } : nextRate;
}

function addRate(rateByModel, model, rate) {
  if (rateByModel.has(model)) return;
  rateByModel.set(model, {
    model,
    inputPer1MUsd: rate.inputPer1MUsd,
    outputPer1MUsd: rate.outputPer1MUsd,
    cachedReadPer1MUsd: rate.cachedReadPer1MUsd,
    cachedCreatePer1MUsd: rate.cachedCreatePer1MUsd,
    ...(rate.cachedCreate5mPer1MUsd !== undefined ? { cachedCreate5mPer1MUsd: rate.cachedCreate5mPer1MUsd } : {}),
    ...(rate.cachedCreate1hPer1MUsd !== undefined ? { cachedCreate1hPer1MUsd: rate.cachedCreate1hPer1MUsd } : {}),
    reasoningOutputPer1MUsd: rate.reasoningOutputPer1MUsd,
    ...(rate.longContextThresholdTokens !== undefined ? { longContextThresholdTokens: rate.longContextThresholdTokens } : {}),
    ...(rate.longContextInputPer1MUsd !== undefined ? { longContextInputPer1MUsd: rate.longContextInputPer1MUsd } : {}),
    ...(rate.longContextOutputPer1MUsd !== undefined ? { longContextOutputPer1MUsd: rate.longContextOutputPer1MUsd } : {}),
    ...(rate.longContextCachedReadPer1MUsd !== undefined
      ? { longContextCachedReadPer1MUsd: rate.longContextCachedReadPer1MUsd }
      : {}),
    ...(rate.longContextCachedCreatePer1MUsd !== undefined
      ? { longContextCachedCreatePer1MUsd: rate.longContextCachedCreatePer1MUsd }
      : {}),
    ...(rate.longContextCachedCreate5mPer1MUsd !== undefined
      ? { longContextCachedCreate5mPer1MUsd: rate.longContextCachedCreate5mPer1MUsd }
      : {}),
    ...(rate.longContextCachedCreate1hPer1MUsd !== undefined
      ? { longContextCachedCreate1hPer1MUsd: rate.longContextCachedCreate1hPer1MUsd }
      : {}),
    ...(rate.longContextReasoningOutputPer1MUsd !== undefined
      ? { longContextReasoningOutputPer1MUsd: rate.longContextReasoningOutputPer1MUsd }
      : {}),
    ...(rate.contextWindowTokens !== undefined ? { contextWindowTokens: rate.contextWindowTokens } : {}),
  });
}

function addContextWindow(contextByModel, model, contextWindowTokens) {
  if (!isFiniteNumber(contextWindowTokens) || contextWindowTokens <= 0 || contextByModel.has(model)) return;
  contextByModel.set(model, {
    model,
    contextWindowTokens: Math.round(contextWindowTokens),
  });
}

function renderGeneratedFile(modelRates, contextWindows, sources) {
  const header = [
    'import type { CostModelRate, ModelContextWindow } from "@agentlens/contracts";',
    "",
    `// Generated by scripts/sync-pricing.mjs on ${new Date().toISOString()}.`,
    `// Sources: ${sources.join(", ")}`,
    "export const DEFAULT_PRICING_MODEL_RATES: CostModelRate[] = [",
  ];

  const ratesBody = modelRates
    .map((rate) => {
      const fields = Object.entries(rate)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `    ${key}: ${typeof value === "string" ? `"${value}"` : formatNumber(value)},`);
      return ["  {", ...fields, "  },"].join("\n");
    })
    .join("\n");

  const contextBody = contextWindows
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

async function main() {
  const api = await fetchJson(MODELS_DEV_URL);
  const sourceEntries = [];

  for (const [provider, providerData] of Object.entries(api ?? {})) {
    if (!CANONICAL_PROVIDERS.has(provider)) continue;
    const models = providerData?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;

    for (const [rawModel, modelData] of Object.entries(models)) {
      if (!modelData || typeof modelData !== "object" || Array.isArray(modelData)) continue;
      if (!hasRelevantCost(modelData.cost)) continue;
      sourceEntries.push({ provider, rawModel, modelData });
    }
  }

  sourceEntries.sort(compareSourceEntries);

  const rateByModel = new Map();
  const contextByModel = new Map();

  for (const entry of sourceEntries) {
    const baseRate = buildBaseRate(entry.modelData);
    for (const model of emittedModelKeys(entry.provider, entry.rawModel)) {
      const rate = applyAnthropicOverrides(model, baseRate);
      addRate(rateByModel, model, rate);
      addContextWindow(contextByModel, model, rate.contextWindowTokens);
    }
  }

  const modelRates = Array.from(rateByModel.values()).sort((left, right) => compareText(left.model, right.model));
  const contextWindows = Array.from(contextByModel.values()).sort((left, right) => compareText(left.model, right.model));

  const generated = renderGeneratedFile(modelRates, contextWindows, [
    MODELS_DEV_URL,
    "local Anthropic cache-tier overrides",
  ]);
  await writeFile(OUTPUT_PATH, generated, "utf8");
  process.stdout.write(`Wrote ${OUTPUT_PATH} (${modelRates.length} rates, ${contextWindows.length} context windows)\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
