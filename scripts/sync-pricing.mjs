import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_MODELS_OVERVIEW_URL = "https://platform.claude.com/docs/en/about-claude/models/overview";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const OPENAI_GPT52_URL = "https://developers.openai.com/api/docs/models/gpt-5.2";
const OPENAI_GPT52_CODEX_URL = "https://developers.openai.com/api/docs/models/gpt-5.2-codex";
const OPENAI_GPT54_URL = "https://developers.openai.com/api/docs/models/gpt-5.4";
const OPENAI_GPT53_CODEX_URL = "https://developers.openai.com/api/docs/models/gpt-5.3-codex";
const OUTPUT_PATH = path.resolve("packages/core/src/generatedPricing.ts");

const USER_AGENT = "agentlens-pricing-sync/0.1";

function assertFound(value, message) {
  if (value === null || value === undefined || value === "") {
    throw new Error(message);
  }
  return value;
}

function parseUsd(value) {
  const match = String(value).match(/\$([0-9]+(?:\.[0-9]+)?)/);
  if (!match) throw new Error(`Could not parse USD amount from: ${value}`);
  return Number(match[1]);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  const text = value.toString();
  return text.includes(".") ? text : `${text}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

function parseAnthropicStandardRow(html, label) {
  const rowPattern = new RegExp(
    `<td[^>]*>${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</td><td[^>]*>([^<]+)</td><td[^>]*>([^<]+)</td><td[^>]*>([^<]+)</td><td[^>]*>([^<]+)</td><td[^>]*>([^<]+)</td>`,
  );
  const match = html.match(rowPattern);
  if (!match) throw new Error(`Could not find Anthropic pricing row for ${label}`);
  return {
    inputPer1MUsd: parseUsd(match[1]),
    cachedCreate5mPer1MUsd: parseUsd(match[2]),
    cachedCreate1hPer1MUsd: parseUsd(match[3]),
    cachedReadPer1MUsd: parseUsd(match[4]),
    outputPer1MUsd: parseUsd(match[5]),
  };
}

function parseAnthropicLongContextRow(html, label) {
  const anchor = html.indexOf("requests that exceed 200K input tokens");
  if (anchor < 0) throw new Error("Could not find Anthropic long-context section");
  const segment = html.slice(anchor, anchor + 12000);
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowPattern = new RegExp(
    `<td[^>]*>${escapedLabel}</td><td[^>]*>Input: ([^<]+)</td><td[^>]*>Input: ([^<]+)</td></tr><tr[^>]*><td[^>]*></td><td[^>]*>Output: ([^<]+)</td><td[^>]*>Output: ([^<]+)</td>`,
  );
  const match = segment.match(rowPattern);
  if (!match) throw new Error(`Could not find Anthropic long-context row for ${label}`);
  return {
    baseInputPer1MUsd: parseUsd(match[1]),
    longContextInputPer1MUsd: parseUsd(match[2]),
    baseOutputPer1MUsd: parseUsd(match[3]),
    longContextOutputPer1MUsd: parseUsd(match[4]),
  };
}

function parseOpenAiPricingRow(html, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowPattern = new RegExp(
    `<td[^>]*>${escapedLabel}</td><td[^>]*>([^<]*)</td><td[^>]*>([^<]*)</td><td[^>]*>([^<]*)</td>`,
  );
  const match = html.match(rowPattern);
  if (!match) throw new Error(`Could not find OpenAI pricing row for ${label}`);
  return {
    inputPer1MUsd: parseUsd(match[1]),
    cachedReadPer1MUsd: match[2].trim() ? parseUsd(match[2]) : 0,
    outputPer1MUsd: parseUsd(match[3]),
  };
}

function parseOpenAiLongContext(html) {
  const anchor = html.indexOf("1.05M context window");
  const threshold = html.indexOf("272K input tokens", anchor);
  const multiplier = html.indexOf("priced at 2x input and 1.5x output", anchor);
  if (anchor < 0 || threshold < 0 || multiplier < 0) {
    throw new Error("Could not find OpenAI long-context multiplier text");
  }
  return {
    longContextThresholdTokens: 272_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
  };
}

function parseContextWindow(html, contextLabel) {
  const escaped = contextLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}<!-- --> context window`));
  if (!match) throw new Error(`Could not find context window ${contextLabel}`);
  return Number(contextLabel.replace(/,/g, ""));
}

function parseAnthropicContextWindows(html) {
  const anchor = html.indexOf("<strong class=\"font-semibold\">Context window</strong>");
  if (anchor < 0) throw new Error("Could not find Anthropic context window row");
  const segment = html.slice(anchor, anchor + 3000);
  const matches = [...segment.matchAll(/>(200K|1M) tokens</g)].map((match) => match[1]);
  if (matches.length < 5) throw new Error("Could not parse Anthropic context window values");
  return {
    opus46DefaultTokens: matches[0] === "200K" ? 200_000 : 1_000_000,
    sonnet46DefaultTokens: matches[2] === "200K" ? 200_000 : 1_000_000,
    haiku45DefaultTokens: matches[4] === "200K" ? 200_000 : 1_000_000,
  };
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
  const [
    anthropicHtml,
    anthropicModelsHtml,
    openAiPricingHtml,
    openAiGpt52Html,
    openAiGpt52CodexHtml,
    openAiGpt54Html,
    openAiGpt53CodexHtml,
  ] = await Promise.all([
    fetchText(ANTHROPIC_PRICING_URL),
    fetchText(ANTHROPIC_MODELS_OVERVIEW_URL),
    fetchText(OPENAI_PRICING_URL),
    fetchText(OPENAI_GPT52_URL),
    fetchText(OPENAI_GPT52_CODEX_URL),
    fetchText(OPENAI_GPT54_URL),
    fetchText(OPENAI_GPT53_CODEX_URL),
  ]);

  const anthropicOpus46 = parseAnthropicStandardRow(anthropicHtml, "Claude Opus 4.6");
  const anthropicOpus45 = parseAnthropicStandardRow(anthropicHtml, "Claude Opus 4.5");
  const anthropicSonnet46 = parseAnthropicStandardRow(anthropicHtml, "Claude Sonnet 4.6");
  const anthropicSonnet45 = parseAnthropicStandardRow(anthropicHtml, "Claude Sonnet 4.5");
  const anthropicHaiku45 = parseAnthropicStandardRow(anthropicHtml, "Claude Haiku 4.5");
  const anthropicLongOpus46 = parseAnthropicLongContextRow(anthropicHtml, "Claude Opus 4.6");
  const anthropicLongSonnet = parseAnthropicLongContextRow(anthropicHtml, "Claude Sonnet 4.6 / 4.5 / 4");

  const openAiGpt54 = parseOpenAiPricingRow(openAiPricingHtml, "gpt-5.4 (&lt;272K context length)");
  const openAiGpt52 = parseOpenAiPricingRow(openAiPricingHtml, "gpt-5.2");
  const openAiGpt53Codex = parseOpenAiPricingRow(openAiPricingHtml, "gpt-5.3-codex");
  const openAiGpt52Codex = parseOpenAiPricingRow(openAiPricingHtml, "gpt-5.2-codex");
  const openAiLong = parseOpenAiLongContext(openAiPricingHtml);
  const anthropicContexts = parseAnthropicContextWindows(anthropicModelsHtml);
  const gpt52ContextWindowTokens = parseContextWindow(openAiGpt52Html, "400,000");
  const gpt52CodexContextWindowTokens = parseContextWindow(openAiGpt52CodexHtml, "400,000");
  const gpt54ContextWindowTokens = parseContextWindow(openAiGpt54Html, "1,050,000");
  const gpt53CodexContextWindowTokens = parseContextWindow(openAiGpt53CodexHtml, "400,000");

  const modelRates = [
    {
      model: "gpt-5.2-codex",
      inputPer1MUsd: openAiGpt52Codex.inputPer1MUsd,
      outputPer1MUsd: openAiGpt52Codex.outputPer1MUsd,
      cachedReadPer1MUsd: openAiGpt52Codex.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: 0,
      reasoningOutputPer1MUsd: 0,
      contextWindowTokens: gpt52CodexContextWindowTokens,
    },
    {
      model: "gpt-5.3-codex",
      inputPer1MUsd: openAiGpt53Codex.inputPer1MUsd,
      outputPer1MUsd: openAiGpt53Codex.outputPer1MUsd,
      cachedReadPer1MUsd: openAiGpt53Codex.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: 0,
      reasoningOutputPer1MUsd: 0,
      contextWindowTokens: gpt53CodexContextWindowTokens,
    },
    {
      model: "gpt-5.2",
      inputPer1MUsd: openAiGpt52.inputPer1MUsd,
      outputPer1MUsd: openAiGpt52.outputPer1MUsd,
      cachedReadPer1MUsd: openAiGpt52.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: 0,
      reasoningOutputPer1MUsd: 0,
      contextWindowTokens: gpt52ContextWindowTokens,
    },
    {
      model: "gpt-5.4",
      inputPer1MUsd: openAiGpt54.inputPer1MUsd,
      outputPer1MUsd: openAiGpt54.outputPer1MUsd,
      cachedReadPer1MUsd: openAiGpt54.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: 0,
      reasoningOutputPer1MUsd: 0,
      longContextThresholdTokens: openAiLong.longContextThresholdTokens,
      longContextInputPer1MUsd: openAiGpt54.inputPer1MUsd * openAiLong.inputMultiplier,
      longContextOutputPer1MUsd: openAiGpt54.outputPer1MUsd * openAiLong.outputMultiplier,
      contextWindowTokens: gpt54ContextWindowTokens,
    },
    {
      model: "claude-opus-4.6",
      inputPer1MUsd: anthropicOpus46.inputPer1MUsd,
      outputPer1MUsd: anthropicOpus46.outputPer1MUsd,
      cachedReadPer1MUsd: anthropicOpus46.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: anthropicOpus46.cachedCreate5mPer1MUsd,
      cachedCreate5mPer1MUsd: anthropicOpus46.cachedCreate5mPer1MUsd,
      cachedCreate1hPer1MUsd: anthropicOpus46.cachedCreate1hPer1MUsd,
      reasoningOutputPer1MUsd: 0,
      longContextThresholdTokens: 200_000,
      longContextInputPer1MUsd: anthropicLongOpus46.longContextInputPer1MUsd,
      longContextOutputPer1MUsd: anthropicLongOpus46.longContextOutputPer1MUsd,
      longContextCachedReadPer1MUsd: anthropicOpus46.cachedReadPer1MUsd * 2,
      longContextCachedCreatePer1MUsd: anthropicOpus46.cachedCreate5mPer1MUsd * 2,
      longContextCachedCreate5mPer1MUsd: anthropicOpus46.cachedCreate5mPer1MUsd * 2,
      longContextCachedCreate1hPer1MUsd: anthropicOpus46.cachedCreate1hPer1MUsd * 2,
      contextWindowTokens: anthropicContexts.opus46DefaultTokens,
    },
    {
      model: "claude-opus-4-5-20251101",
      inputPer1MUsd: anthropicOpus45.inputPer1MUsd,
      outputPer1MUsd: anthropicOpus45.outputPer1MUsd,
      cachedReadPer1MUsd: anthropicOpus45.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: anthropicOpus45.cachedCreate5mPer1MUsd,
      cachedCreate5mPer1MUsd: anthropicOpus45.cachedCreate5mPer1MUsd,
      cachedCreate1hPer1MUsd: anthropicOpus45.cachedCreate1hPer1MUsd,
      reasoningOutputPer1MUsd: 0,
      contextWindowTokens: anthropicContexts.opus46DefaultTokens,
    },
    {
      model: "claude-sonnet-4.6",
      inputPer1MUsd: anthropicSonnet46.inputPer1MUsd,
      outputPer1MUsd: anthropicSonnet46.outputPer1MUsd,
      cachedReadPer1MUsd: anthropicSonnet46.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: anthropicSonnet46.cachedCreate5mPer1MUsd,
      cachedCreate5mPer1MUsd: anthropicSonnet46.cachedCreate5mPer1MUsd,
      cachedCreate1hPer1MUsd: anthropicSonnet46.cachedCreate1hPer1MUsd,
      reasoningOutputPer1MUsd: 0,
      longContextThresholdTokens: 200_000,
      longContextInputPer1MUsd: anthropicLongSonnet.longContextInputPer1MUsd,
      longContextOutputPer1MUsd: anthropicLongSonnet.longContextOutputPer1MUsd,
      longContextCachedReadPer1MUsd: anthropicSonnet46.cachedReadPer1MUsd * 2,
      longContextCachedCreatePer1MUsd: anthropicSonnet46.cachedCreate5mPer1MUsd * 2,
      longContextCachedCreate5mPer1MUsd: anthropicSonnet46.cachedCreate5mPer1MUsd * 2,
      longContextCachedCreate1hPer1MUsd: anthropicSonnet46.cachedCreate1hPer1MUsd * 2,
      contextWindowTokens: anthropicContexts.sonnet46DefaultTokens,
    },
    {
      model: "claude-sonnet-4-5-20250929",
      inputPer1MUsd: anthropicSonnet45.inputPer1MUsd,
      outputPer1MUsd: anthropicSonnet45.outputPer1MUsd,
      cachedReadPer1MUsd: anthropicSonnet45.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: anthropicSonnet45.cachedCreate5mPer1MUsd,
      cachedCreate5mPer1MUsd: anthropicSonnet45.cachedCreate5mPer1MUsd,
      cachedCreate1hPer1MUsd: anthropicSonnet45.cachedCreate1hPer1MUsd,
      reasoningOutputPer1MUsd: 0,
      longContextThresholdTokens: 200_000,
      longContextInputPer1MUsd: anthropicLongSonnet.longContextInputPer1MUsd,
      longContextOutputPer1MUsd: anthropicLongSonnet.longContextOutputPer1MUsd,
      longContextCachedReadPer1MUsd: anthropicSonnet45.cachedReadPer1MUsd * 2,
      longContextCachedCreatePer1MUsd: anthropicSonnet45.cachedCreate5mPer1MUsd * 2,
      longContextCachedCreate5mPer1MUsd: anthropicSonnet45.cachedCreate5mPer1MUsd * 2,
      longContextCachedCreate1hPer1MUsd: anthropicSonnet45.cachedCreate1hPer1MUsd * 2,
      contextWindowTokens: anthropicContexts.sonnet46DefaultTokens,
    },
    {
      model: "claude-haiku-4.5",
      inputPer1MUsd: anthropicHaiku45.inputPer1MUsd,
      outputPer1MUsd: anthropicHaiku45.outputPer1MUsd,
      cachedReadPer1MUsd: anthropicHaiku45.cachedReadPer1MUsd,
      cachedCreatePer1MUsd: anthropicHaiku45.cachedCreate5mPer1MUsd,
      cachedCreate5mPer1MUsd: anthropicHaiku45.cachedCreate5mPer1MUsd,
      cachedCreate1hPer1MUsd: anthropicHaiku45.cachedCreate1hPer1MUsd,
      reasoningOutputPer1MUsd: 0,
      contextWindowTokens: anthropicContexts.haiku45DefaultTokens,
    },
  ];

  const generated = renderGeneratedFile(
    modelRates,
    modelRates.map((rate) => ({
      model: rate.model,
      contextWindowTokens: assertFound(rate.contextWindowTokens, `Missing context window for ${rate.model}`),
    })),
    [
      ANTHROPIC_PRICING_URL,
      ANTHROPIC_MODELS_OVERVIEW_URL,
      OPENAI_PRICING_URL,
      OPENAI_GPT52_URL,
      OPENAI_GPT52_CODEX_URL,
      OPENAI_GPT54_URL,
      OPENAI_GPT53_CODEX_URL,
    ],
  );
  await writeFile(OUTPUT_PATH, generated, "utf8");
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
