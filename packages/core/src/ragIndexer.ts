import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AgentKind,
  AppConfig,
  RagIndexStatus,
  RagRefreshStatus,
  RagSearchMode,
  RagSearchResponse,
  RagSummaryListResponse,
  RagSummaryRecord,
  TraceSummary,
} from "@agentlens/contracts";
import { loadConfig } from "./config.js";
import { TraceIndex } from "./traceIndex.js";
import { toMsWindow, expandHome } from "./utils.js";
import { buildPromptInput, buildRagCorpus } from "./ragCorpus.js";
import { createEmbeddingProvider, unavailableEmbeddingStatus, type EmbeddingProvider } from "./ragEmbeddings.js";
import { runHeadlessSummary } from "./ragHeadless.js";
import { missingRagStatus, RagStore } from "./ragStore.js";

export interface RagIndexOptions {
  once?: boolean;
  limit?: number;
  force?: boolean;
  forceLarge?: boolean;
  lexicalOnly?: boolean;
}

export interface RagIndexRunResult {
  dbPath: string;
  discoveredTraces: number;
  quietEligibleTraces: number;
  summarized: number;
  skipped: number;
  failed: number;
  lexicalDocumentCount: number;
  embeddingStatus: RagIndexStatus["embeddings"];
  lastError: string;
}

export interface RagSearchRequest {
  query: string;
  mode?: RagSearchMode;
  limit?: number;
  agent?: AgentKind;
  since?: string;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQuiet(summary: TraceSummary, quietPeriodMs: number, nowMs: number): boolean {
  return Math.max(summary.lastEventTs ?? 0, summary.mtimeMs) <= nowMs - quietPeriodMs;
}

function hasNonMetaEvent(summary: TraceSummary): boolean {
  return Object.entries(summary.eventKindCounts).some(([kind, count]) => kind !== "meta" && count > 0);
}

function isEligible(summary: TraceSummary, config: AppConfig, nowMs: number): boolean {
  return summary.parseable && hasNonMetaEvent(summary) && isQuiet(summary, config.rag.quietPeriodMs, nowMs);
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function embedChangedDocuments(store: RagStore, provider: EmbeddingProvider | null, config: AppConfig): Promise<RagIndexStatus["embeddings"]> {
  if (!provider) {
    return { status: "disabled", model: config.rag.embeddingModel, dimension: null, count: 0 };
  }
  try {
    store.setMeta("embedding_model", provider.model);
    for (;;) {
      const batch = store.listDocumentsWithoutEmbeddings(provider.model, config.rag.embeddingBatchSize);
      if (batch.length === 0) break;
      const vectors = await provider.embed(batch.map((document) => document.content));
      const nowMs = Date.now();
      for (let index = 0; index < batch.length; index += 1) {
        const vector = vectors[index];
        const document = batch[index];
        if (vector && document) {
          store.upsertEmbedding(document.documentId, provider.model, vector, nowMs);
        }
      }
    }
    return store.getStatus(config).embeddings;
  } catch (error) {
    return unavailableEmbeddingStatus(config, error);
  }
}

export async function runRagIndexOnce(config: AppConfig, options: RagIndexOptions = {}): Promise<RagIndexRunResult> {
  const store = new RagStore(config);
  const traceIndex = new TraceIndex(config);
  let lastError = "";
  let summarized = 0;
  let skipped = 0;
  let failed = 0;
  let lexicalDocumentCount = 0;
  try {
    await traceIndex.refresh();
    const nowMs = Date.now();
    const summaries = traceIndex.getSummaries();
    for (const summary of summaries) {
      if (!summary.parseable || !hasNonMetaEvent(summary) || isQuiet(summary, config.rag.quietPeriodMs, nowMs)) continue;
      const existing = store.getSession(summary.id);
      if (!existing?.summary || existing.status !== "complete") continue;
      const detail = traceIndex.getSessionDetail(summary.id);
      const promptInput = buildPromptInput(detail);
      if (promptInput.fingerprint !== existing.fingerprint) {
        store.upsertSession({
          summary,
          fingerprint: promptInput.fingerprint,
          status: "stale",
          nowMs,
        });
      }
    }
    const eligible = summaries.filter((summary) => isEligible(summary, config, nowMs));
    const selected = eligible.slice(0, Math.max(1, options.limit ?? (eligible.length || 1)));

    for (const summary of selected) {
      try {
        const detail = traceIndex.getSessionDetail(summary.id);
        const promptInput = buildPromptInput(detail);
        const existing = store.getSession(summary.id);
        if (!options.force && existing?.fingerprint === promptInput.fingerprint && existing.status === "complete") {
          continue;
        }
        if (promptInput.promptBytes > config.rag.summaryMaxPromptBytes && !options.forceLarge) {
          store.upsertSession({
            summary,
            fingerprint: promptInput.fingerprint,
            status: "skipped",
            skipReason: "input_too_large",
            nowMs,
          });
          skipped += 1;
          continue;
        }
        store.upsertSession({
          summary,
          fingerprint: promptInput.fingerprint,
          status: existing?.summary ? "stale" : "pending",
          nowMs,
        });
        const result = await runHeadlessSummary(config, promptInput.prompt);
        const corpus = buildRagCorpus(detail, result.content);
        store.upsertSession({
          summary,
          fingerprint: corpus.fingerprint,
          status: "complete",
          content: result.content,
          summaryText: corpus.summaryText,
          summaryModel: result.model,
          summaryGeneratedAtMs: Date.now(),
          nowMs: Date.now(),
        });
        store.replaceDocuments(summary.id, corpus.documents, Date.now());
        lexicalDocumentCount += corpus.documents.length;
        summarized += 1;
      } catch (error) {
        failed += 1;
        lastError = asErrorMessage(error);
        const detailSummary = traceIndex.getSummaries().find((row) => row.id === summary.id) ?? summary;
        const fingerprint = store.getSession(summary.id)?.fingerprint ?? "";
        store.upsertSession({
          summary: detailSummary,
          fingerprint,
          status: "failed",
          error: lastError,
          nowMs: Date.now(),
        });
      }
    }

    const embeddingStatus = options.lexicalOnly
      ? { status: "disabled" as const, model: config.rag.embeddingModel, dimension: null, count: 0 }
      : await embedChangedDocuments(store, createEmbeddingProvider(config), config);
    store.setMeta("last_run_at_ms", String(Date.now()));
    store.setMeta("last_run_error", lastError);
    return {
      dbPath: store.dbPath,
      discoveredTraces: summaries.length,
      quietEligibleTraces: eligible.length,
      summarized,
      skipped,
      failed,
      lexicalDocumentCount,
      embeddingStatus,
      lastError,
    };
  } finally {
    store.close();
    traceIndex.stop();
  }
}

export async function getRagStatus(config: AppConfig): Promise<RagIndexStatus> {
  const dbPath = path.resolve(expandHome(config.rag.dbPath));
  if (!existsSync(dbPath)) return missingRagStatus(config);
  const store = new RagStore(config);
  try {
    return store.getStatus(config);
  } finally {
    store.close();
  }
}

export async function searchRag(config: AppConfig, request: RagSearchRequest): Promise<RagSearchResponse> {
  const store = new RagStore(config);
  try {
    const mode = request.mode ?? "hybrid";
    const limit = Math.max(1, Math.min(100, request.limit ?? 20));
    const sinceMs = request.since ? Date.now() - toMsWindow(request.since) : undefined;
    let embeddings = store.getStatus(config).embeddings;
    let queryVector: Float32Array | undefined;
    if (mode !== "lexical" && request.query.trim()) {
      const provider = createEmbeddingProvider(config);
      if (provider) {
        try {
          store.setMeta("embedding_model", provider.model);
          queryVector = (await provider.embed([request.query]))[0];
        } catch (error) {
          embeddings = unavailableEmbeddingStatus(config, error);
        }
      }
    }
    const effectiveMode: RagSearchMode = mode === "semantic" && !queryVector ? "lexical" : mode;
    const searchOptions = {
      query: request.query,
      mode: effectiveMode,
      limit,
      candidateMultiplier: config.rag.searchCandidateMultiplier,
      rrfK: config.rag.rrfK,
      ...(request.agent ? { agent: request.agent } : {}),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(queryVector ? { queryVector } : {}),
    };
    return {
      query: request.query,
      mode,
      embeddings,
      results: store.search(searchOptions),
    };
  } finally {
    store.close();
  }
}

export async function listRagSummaries(
  config: AppConfig,
  options: { status?: RagRefreshStatus; agent?: AgentKind; since?: string; limit?: number } = {},
): Promise<RagSummaryListResponse> {
  const dbPath = path.resolve(expandHome(config.rag.dbPath));
  if (!existsSync(dbPath)) return { summaries: [] };
  const store = new RagStore(config);
  try {
    return {
      summaries: store.listSummaries({
        ...(options.status ? { status: options.status } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.since ? { sinceMs: Date.now() - toMsWindow(options.since) } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
    };
  } finally {
    store.close();
  }
}

export async function getRagSummary(config: AppConfig, traceId: string): Promise<RagSummaryRecord | null> {
  const dbPath = path.resolve(expandHome(config.rag.dbPath));
  if (!existsSync(dbPath)) return null;
  const store = new RagStore(config);
  try {
    return store.getSession(traceId);
  } finally {
    store.close();
  }
}

export async function runRagWorker(
  configPath: string,
  options: { once?: boolean; limit?: number; lexicalOnly?: boolean; intervalMs?: number } = {},
): Promise<void> {
  do {
    const config = await loadConfig(configPath);
    await runRagIndexOnce(config, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.lexicalOnly !== undefined ? { lexicalOnly: options.lexicalOnly } : {}),
    });
    if (options.once) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? config.rag.workerIntervalMs));
  } while (true);
}

export function startRagDaemon(
  configPath: string,
  config: AppConfig,
  options: { limit?: number; intervalMs?: number } = {},
): { reused: boolean; pid: number; pidPath: string; logPath: string } {
  const pidPath = path.resolve(expandHome(config.rag.daemonPidPath));
  const logPath = path.resolve(expandHome(config.rag.daemonLogPath));
  mkdirSync(path.dirname(pidPath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  const existingPid = readPid(pidPath);
  if (existingPid && pidIsRunning(existingPid)) {
    return { reused: true, pid: existingPid, pidPath, logPath };
  }
  const out = openSync(logPath, "a");
  const workerArgs = [process.argv[1] ?? "", "--config", configPath, "rag", "worker", "--foreground"];
  if (options.limit !== undefined) workerArgs.push("--limit", String(options.limit));
  if (options.intervalMs !== undefined) workerArgs.push("--interval-ms", String(options.intervalMs));
  const child = spawn(process.execPath, workerArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    shell: false,
  });
  child.unref();
  closeSync(out);
  writeFileSync(pidPath, String(child.pid ?? 0), "utf8");
  return { reused: false, pid: child.pid ?? 0, pidPath, logPath };
}

export function stopRagDaemon(config: AppConfig): { stopped: boolean; stale: boolean; pid: number | null } {
  const pidPath = path.resolve(expandHome(config.rag.daemonPidPath));
  const pid = readPid(pidPath);
  if (!pid) {
    return { stopped: false, stale: false, pid: null };
  }
  if (!pidIsRunning(pid)) {
    unlinkSync(pidPath);
    return { stopped: false, stale: true, pid };
  }
  process.kill(pid, "SIGTERM");
  unlinkSync(pidPath);
  return { stopped: true, stale: false, pid };
}
