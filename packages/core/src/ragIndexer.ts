import { existsSync, mkdirSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AgentKind,
  AppConfig,
  RagDocumentKind,
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
import {
  isLiveRagDaemon,
  RAG_DAEMON_COMMAND,
  readPidValue,
  readRagDaemonPidFile,
  type RagDaemonPidFile,
} from "./ragStoreHelpers.js";

export interface RagIndexOptions {
  once?: boolean;
  limit?: number;
  /** Caps trace-document embeddings; summary-document embeddings are drained first for projection freshness. */
  embeddingLimit?: number;
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
  embeddedDocuments: number;
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

interface RagWorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RagSupervisorRuntimeOptions {
  entrypoint?: string;
  maxPasses?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
}

const INTERNAL_RAG_MARKER = "agentlens-rag-";
const INTERNAL_RAG_SKIP_REASON = "internal_rag_summary_trace";
const DEFAULT_RAG_WORKER_HEAP_MB = 8192;
const DEFAULT_RAG_WORKER_RESTART_DELAY_MS = 1_000;
const DEFAULT_RAG_WORKER_MAX_RESTART_DELAY_MS = 60_000;

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

function isCurrentTerminalRagSession(existing: RagSummaryRecord | null, fingerprint: string): boolean {
  if (!existing || existing.fingerprint !== fingerprint) return false;
  return existing.status === "complete" || existing.status === "skipped";
}

function containsInternalRagMarker(value: string): boolean {
  return value.toLowerCase().includes(INTERNAL_RAG_MARKER);
}

function eventContainsInternalRagMarker(event: ReturnType<TraceIndex["getSessionDetail"]>["events"][number]): boolean {
  if (event.eventKind !== "meta") return false;
  if (containsInternalRagMarker(event.preview) || containsInternalRagMarker(event.searchText)) return true;
  return [...event.textBlocks, event.toolArgsText, event.toolResultText].some(containsInternalRagMarker);
}

function isInternalRagSummaryTrace(
  summary: TraceSummary,
  ignoredSessionIds: ReadonlySet<string>,
  detail: ReturnType<TraceIndex["getSessionDetail"]> | null,
): boolean {
  if (summary.sessionId && ignoredSessionIds.has(summary.sessionId)) return true;
  if (containsInternalRagMarker(summary.path)) return true;
  return detail?.events.some(eventContainsInternalRagMarker) ?? false;
}

function internalRagFingerprint(summary: TraceSummary): string {
  return `internal-rag:${summary.id}:${summary.mtimeMs}:${summary.sizeBytes}:${summary.eventCount}`;
}

function internalSummarySessionIdsFromError(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const record = error as Record<string, unknown>;
  const many = record.internalSummarySessionIds;
  if (Array.isArray(many)) {
    return many.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  const single = record.internalSummarySessionId;
  return typeof single === "string" && single.trim() ? [single.trim()] : [];
}

export function ragWorkerNodeOptions(current = process.env.NODE_OPTIONS ?? ""): string {
  if (/--max[-_]old[-_]space[-_]size(?:=|\s|$)/.test(current)) return current;
  return [current.trim(), `--max-old-space-size=${DEFAULT_RAG_WORKER_HEAP_MB}`].filter(Boolean).join(" ");
}

async function embedChangedDocuments(
  store: RagStore,
  provider: EmbeddingProvider | null,
  config: AppConfig,
  maxDocuments?: number,
  options: { kind?: RagDocumentKind; traceId?: string } = {},
): Promise<{ status: RagIndexStatus["embeddings"]; embeddedDocuments: number }> {
  if (!provider) {
    return {
      status: { status: "disabled", model: config.rag.embeddingModel, dimension: null, count: 0 },
      embeddedDocuments: 0,
    };
  }
  let embeddedDocuments = 0;
  const budget = maxDocuments === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxDocuments);
  try {
    store.setMeta("embedding_model", provider.model);
    while (embeddedDocuments < budget) {
      const remaining = budget - embeddedDocuments;
      const batchLimit = Math.min(config.rag.embeddingBatchSize, remaining);
      if (batchLimit <= 0) break;
      const batch = store.listDocumentsWithoutEmbeddings(provider.model, batchLimit, options);
      if (batch.length === 0) break;
      const vectors = await provider.embed(batch.map((document) => document.content));
      const nowMs = Date.now();
      for (let index = 0; index < batch.length; index += 1) {
        const vector = vectors[index];
        const document = batch[index];
        if (vector && document) {
          store.upsertEmbedding(document.documentId, provider.model, vector, nowMs);
          embeddedDocuments += 1;
        }
      }
    }
    return { status: store.getStatus(config).embeddings, embeddedDocuments };
  } catch (error) {
    return { status: unavailableEmbeddingStatus(config, error), embeddedDocuments };
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
  let embeddedDocuments = 0;
  let traceEmbeddedDocuments = 0;
  let embeddingStatus: RagIndexStatus["embeddings"] = options.lexicalOnly
    ? { status: "disabled", model: config.rag.embeddingModel, dimension: null, count: 0 }
    : store.getStatus(config).embeddings;
  const embeddingProvider = options.lexicalOnly ? null : createEmbeddingProvider(config);
  const traceEmbeddingBudget = options.embeddingLimit ?? options.limit;
  const embedAllMissingSummaryDocuments = async (traceId?: string): Promise<void> => {
    if (options.lexicalOnly) return;
    const result = await embedChangedDocuments(store, embeddingProvider, config, undefined, {
      kind: "summary",
      ...(traceId ? { traceId } : {}),
    });
    embeddedDocuments += result.embeddedDocuments;
    embeddingStatus = result.status;
  };
  const embedTraceDocumentsWithinBudget = async (): Promise<void> => {
    if (options.lexicalOnly) return;
    const remainingBudget = traceEmbeddingBudget === undefined ? undefined : Math.max(0, traceEmbeddingBudget - traceEmbeddedDocuments);
    if (remainingBudget !== undefined && remainingBudget <= 0) return;
    const result = await embedChangedDocuments(store, embeddingProvider, config, remainingBudget, { kind: "trace" });
    embeddedDocuments += result.embeddedDocuments;
    traceEmbeddedDocuments += result.embeddedDocuments;
    embeddingStatus = result.status;
  };
  try {
    await embedAllMissingSummaryDocuments();
    if (options.limit === undefined) {
      await traceIndex.refresh();
    } else {
      await traceIndex.refreshRecent();
    }
    const nowMs = Date.now();
    const summaries = traceIndex.getSummaries();
    const discoveredTraceCount = traceIndex.getStartupStatus().discoveredTraceCount || summaries.length;
    const ignoredSessionIds = store.getInternalSummarySessionIds();
    const internalTraceIds = new Set<string>();
    const getDetail = (summary: TraceSummary): ReturnType<TraceIndex["getSessionDetail"]> | null => {
      if (!summary.parseable) return null;
      return traceIndex.getSessionDetailUncached(summary.id);
    };

    const markInternalSummaries = (): void => {
      for (const summary of traceIndex.getSummaries()) {
        if (internalTraceIds.has(summary.id)) continue;
        const detail = summary.parseable ? getDetail(summary) : null;
        if (!isInternalRagSummaryTrace(summary, ignoredSessionIds, detail)) continue;
        internalTraceIds.add(summary.id);
        const existing = store.getSession(summary.id);
        const fingerprint = detail ? buildPromptInput(detail).fingerprint : existing?.fingerprint || internalRagFingerprint(summary);
        const alreadySkipped = existing?.status === "skipped" && existing.skipReason === INTERNAL_RAG_SKIP_REASON && existing.fingerprint === fingerprint;
        store.upsertSession({
          summary,
          fingerprint,
          status: "skipped",
          skipReason: INTERNAL_RAG_SKIP_REASON,
          nowMs,
        });
        store.replaceDocuments(summary.id, [], nowMs);
        if (!alreadySkipped) skipped += 1;
      }
    };
    markInternalSummaries();

    for (const summary of summaries) {
      if (internalTraceIds.has(summary.id)) continue;
      if (!summary.parseable || !hasNonMetaEvent(summary) || isQuiet(summary, config.rag.quietPeriodMs, nowMs)) continue;
      const existing = store.getSession(summary.id);
      if (!existing?.summary || existing.status !== "complete") continue;
      const detail = getDetail(summary);
      if (!detail) continue;
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
    const eligibleSummaries = (): TraceSummary[] =>
      traceIndex
        .getSummaries()
        .filter((summary) => !internalTraceIds.has(summary.id) && isEligible(summary, config, nowMs));
    const limit = Math.max(1, options.limit ?? (eligibleSummaries().length || 1));
    let selectedCount = 0;
    const visitedEligibleTraceIds = new Set<string>();
    while (selectedCount < limit) {
      for (const summary of eligibleSummaries()) {
        if (visitedEligibleTraceIds.has(summary.id)) continue;
        visitedEligibleTraceIds.add(summary.id);
        const detail = getDetail(summary);
        if (!detail) continue;
        const promptInput = buildPromptInput(detail);
        const existing = store.getSession(summary.id);
        if (!options.force && isCurrentTerminalRagSession(existing, promptInput.fingerprint)) continue;
        selectedCount += 1;
        try {
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
          store.addInternalSummarySessionIds(result.internalSummarySessionIds);
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
          await embedAllMissingSummaryDocuments(summary.id);
          lexicalDocumentCount += corpus.documents.length;
          summarized += 1;
        } catch (error) {
          store.addInternalSummarySessionIds(internalSummarySessionIdsFromError(error));
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
        if (selectedCount >= limit) break;
      }
      if (selectedCount >= limit || traceIndex.getStartupStatus().fullReady) break;
      const hydratedCount = await traceIndex.hydrateNextPendingBatch();
      if (hydratedCount <= 0) break;
      markInternalSummaries();
    }

    await embedAllMissingSummaryDocuments();
    await embedTraceDocumentsWithinBudget();
    store.setMeta("last_run_at_ms", String(Date.now()));
    store.setMeta("last_run_error", lastError);
    return {
      dbPath: store.dbPath,
      discoveredTraces: discoveredTraceCount,
      quietEligibleTraces: eligibleSummaries().length,
      summarized,
      skipped,
      failed,
      lexicalDocumentCount,
      embeddedDocuments,
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
  options: { once?: boolean; limit?: number; embeddingLimit?: number; lexicalOnly?: boolean; intervalMs?: number } = {},
): Promise<void> {
  do {
    const config = await loadConfig(configPath);
    await runRagIndexOnce(config, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      embeddingLimit: options.embeddingLimit ?? config.rag.embeddingBatchSize,
      ...(options.lexicalOnly !== undefined ? { lexicalOnly: options.lexicalOnly } : {}),
    });
    if (options.once) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? config.rag.workerIntervalMs));
  } while (true);
}

function buildRagWorkerArgs(
  entrypoint: string,
  configPath: string,
  options: { limit?: number; embeddingLimit?: number; intervalMs?: number; lexicalOnly?: boolean },
  mode: "loop" | "once",
): string[] {
  const workerArgs = [entrypoint, "--config", configPath, "rag", "worker", "--foreground"];
  if (mode === "once") workerArgs.push("--once");
  if (options.limit !== undefined) workerArgs.push("--limit", String(options.limit));
  if (options.embeddingLimit !== undefined) workerArgs.push("--embedding-limit", String(options.embeddingLimit));
  if (options.intervalMs !== undefined && mode === "loop") workerArgs.push("--interval-ms", String(options.intervalMs));
  if (options.lexicalOnly) workerArgs.push("--lexical-only");
  return workerArgs;
}

function buildRagSupervisorArgs(
  entrypoint: string,
  configPath: string,
  options: { limit?: number; embeddingLimit?: number; intervalMs?: number; lexicalOnly?: boolean },
): string[] {
  const supervisorArgs = [entrypoint, "--config", configPath, "rag", "supervisor", "--foreground"];
  if (options.limit !== undefined) supervisorArgs.push("--limit", String(options.limit));
  if (options.embeddingLimit !== undefined) supervisorArgs.push("--embedding-limit", String(options.embeddingLimit));
  if (options.intervalMs !== undefined) supervisorArgs.push("--interval-ms", String(options.intervalMs));
  if (options.lexicalOnly) supervisorArgs.push("--lexical-only");
  return supervisorArgs;
}

function childExitOk(exit: RagWorkerExit): boolean {
  return exit.code === 0 && exit.signal === null;
}

function describeWorkerExit(exit: RagWorkerExit): string {
  return `code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`;
}

export async function runRagSupervisor(
  configPath: string,
  options: { limit?: number; embeddingLimit?: number; intervalMs?: number; lexicalOnly?: boolean } = {},
  runtime: RagSupervisorRuntimeOptions = {},
): Promise<void> {
  let stopping = false;
  let activeChild: ReturnType<typeof spawn> | null = null;
  let wakeSleep: (() => void) | null = null;
  let restartDelayMs = Math.max(0, runtime.restartDelayMs ?? DEFAULT_RAG_WORKER_RESTART_DELAY_MS);
  const maxRestartDelayMs = Math.max(restartDelayMs, runtime.maxRestartDelayMs ?? DEFAULT_RAG_WORKER_MAX_RESTART_DELAY_MS);
  const entrypoint = runtime.entrypoint ?? process.argv[1] ?? "";

  const wake = (): void => {
    const currentWake = wakeSleep;
    if (currentWake) currentWake();
  };
  const handleStop = (): void => {
    stopping = true;
    if (activeChild?.pid) activeChild.kill("SIGTERM");
    wake();
  };
  const sleep = async (delayMs: number): Promise<void> => {
    if (delayMs <= 0 || stopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delayMs);
      function done(): void {
        clearTimeout(timer);
        if (wakeSleep === done) wakeSleep = null;
        resolve();
      }
      wakeSleep = done;
    });
  };
  const runWorkerOnce = async (): Promise<RagWorkerExit> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, buildRagWorkerArgs(entrypoint, configPath, options, "once"), {
        stdio: ["ignore", "inherit", "inherit"],
        shell: false,
        env: {
          ...process.env,
          NODE_OPTIONS: ragWorkerNodeOptions(),
        },
      });
      activeChild = child;
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (activeChild === child) activeChild = null;
        resolve({ code, signal });
      });
    });

  process.once("SIGTERM", handleStop);
  process.once("SIGINT", handleStop);
  try {
    let passes = 0;
    while (!stopping) {
      const exit = await runWorkerOnce();
      passes += 1;
      if (stopping) break;
      if (runtime.maxPasses !== undefined && passes >= runtime.maxPasses) break;

      if (childExitOk(exit)) {
        restartDelayMs = Math.max(0, runtime.restartDelayMs ?? DEFAULT_RAG_WORKER_RESTART_DELAY_MS);
        const config = await loadConfig(configPath);
        await sleep(options.intervalMs ?? config.rag.workerIntervalMs);
      } else {
        console.error(`[agentlens-rag] worker exited (${describeWorkerExit(exit)}); restarting in ${restartDelayMs}ms`);
        await sleep(restartDelayMs);
        restartDelayMs = Math.min(maxRestartDelayMs, Math.max(1, restartDelayMs * 2));
      }
    }
  } finally {
    process.off("SIGTERM", handleStop);
    process.off("SIGINT", handleStop);
    const child = activeChild as ReturnType<typeof spawn> | null;
    if (child?.pid) child.kill("SIGTERM");
  }
}

export function startRagDaemon(
  configPath: string,
  config: AppConfig,
  options: { limit?: number; embeddingLimit?: number; intervalMs?: number; lexicalOnly?: boolean } = {},
): { reused: boolean; pid: number; pidPath: string; logPath: string } {
  const pidPath = path.resolve(expandHome(config.rag.daemonPidPath));
  const logPath = path.resolve(expandHome(config.rag.daemonLogPath));
  mkdirSync(path.dirname(pidPath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  const existing = readRagDaemonPidFile(pidPath);
  if (existing && isLiveRagDaemon(existing)) {
    return { reused: true, pid: existing.pid, pidPath, logPath };
  }
  const out = openSync(logPath, "a");
  const supervisorArgs = buildRagSupervisorArgs(process.argv[1] ?? "", configPath, options);
  const child = spawn(process.execPath, supervisorArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    shell: false,
    env: {
      ...process.env,
      NODE_OPTIONS: ragWorkerNodeOptions(),
    },
  });
  child.unref();
  closeSync(out);
  const metadata: RagDaemonPidFile = {
    command: RAG_DAEMON_COMMAND,
    pid: child.pid ?? 0,
    argv: [process.execPath, ...supervisorArgs],
    configPath,
    startedAtMs: Date.now(),
  };
  writeFileSync(pidPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  return { reused: false, pid: child.pid ?? 0, pidPath, logPath };
}

export function stopRagDaemon(config: AppConfig): { stopped: boolean; stale: boolean; pid: number | null } {
  const pidPath = path.resolve(expandHome(config.rag.daemonPidPath));
  const pid = readPidValue(pidPath);
  if (!pid) {
    return { stopped: false, stale: false, pid: null };
  }
  const metadata = readRagDaemonPidFile(pidPath);
  if (!metadata || !isLiveRagDaemon(metadata)) {
    unlinkSync(pidPath);
    return { stopped: false, stale: true, pid };
  }
  process.kill(pid, "SIGTERM");
  unlinkSync(pidPath);
  return { stopped: true, stale: false, pid };
}
