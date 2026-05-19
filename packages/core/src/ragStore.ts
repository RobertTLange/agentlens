import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AgentKind,
  AppConfig,
  RagDocumentKind,
  RagEmbeddingStatus,
  RagIndexStatus,
  RagRefreshStatus,
  RagSearchMode,
  RagSearchResult,
  RagSummaryRecord,
  RagTraceSummaryContent,
  TraceSummary,
} from "@agentlens/contracts";
import { expandHome } from "./utils.js";
import type { RagDocumentInput } from "./ragCorpus.js";
import {
  addKind,
  bufferToVector,
  cosine,
  dbPathFromConfig,
  normalizeFtsQuery,
  pidIsRunning,
  readDaemonPid,
  snippet,
  toSummaryRecord,
  vectorToBuffer,
  type RagSessionRow,
} from "./ragStoreHelpers.js";

export interface RagDocumentRecord extends RagDocumentInput {
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RagSessionUpsert {
  summary: TraceSummary;
  fingerprint: string;
  status: RagRefreshStatus;
  skipReason?: string;
  error?: string;
  content?: RagTraceSummaryContent | null;
  summaryText?: string;
  summaryModel?: string;
  summaryGeneratedAtMs?: number | null;
  nowMs: number;
}

export interface RagSearchOptions {
  query: string;
  mode: RagSearchMode;
  limit: number;
  agent?: AgentKind;
  sinceMs?: number;
  candidateMultiplier: number;
  rrfK: number;
  queryVector?: Float32Array;
}

interface DocumentRow {
  document_id: string;
  trace_id: string;
  kind: RagDocumentKind;
  chunk_index: number;
  content: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface LexicalHitRow extends DocumentRow {
  rank: number;
}

interface EmbeddingRow {
  document_id: string;
  model: string;
  dimension: number;
  vector: Buffer;
}

export interface RagSummaryEmbeddingRow {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  path: string;
  title: string;
  summaryGeneratedAtMs: number | null;
  updatedAtMs: number;
  lastEventTs: number | null;
  mtimeMs: number;
  model: string;
  dimension: number;
  vector: Buffer;
}

export interface RagSummaryEmbeddingList {
  total: number;
  rows: RagSummaryEmbeddingRow[];
}

const RAG_SCHEMA_VERSION = "1";
const INTERNAL_SUMMARY_SESSION_IDS_META_KEY = "internal_summary_session_ids";

function titleFromSummaryJson(value: string | null, fallback: string): string {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<RagTraceSummaryContent>;
    return typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : fallback;
  } catch {
    return fallback;
  }
}

export class RagStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    this.dbPath = dbPathFromConfig(config);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rag_sessions (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        parser TEXT NOT NULL,
        source_profile TEXT NOT NULL,
        path TEXT NOT NULL,
        first_event_ts INTEGER,
        last_event_ts INTEGER,
        mtime_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        skip_reason TEXT,
        error TEXT,
        summary_json TEXT,
        summary_text TEXT,
        summary_model TEXT,
        summary_generated_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rag_documents (
        document_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL REFERENCES rag_sessions(trace_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rag_embeddings (
        document_id TEXT PRIMARY KEY REFERENCES rag_documents(document_id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS rag_document_fts USING fts5(
        document_id UNINDEXED,
        trace_id UNINDEXED,
        kind UNINDEXED,
        content
      );
    `);
    this.setMeta("schema_version", RAG_SCHEMA_VERSION);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO rag_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(key: string): string {
    return (this.db.prepare("SELECT value FROM rag_meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value ?? "";
  }

  getInternalSummarySessionIds(): Set<string> {
    try {
      const parsed = JSON.parse(this.getMeta(INTERNAL_SUMMARY_SESSION_IDS_META_KEY)) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
    } catch {
      return new Set();
    }
  }

  addInternalSummarySessionIds(sessionIds: Iterable<string>): void {
    const merged = this.getInternalSummarySessionIds();
    for (const sessionId of sessionIds) {
      const trimmed = sessionId.trim();
      if (trimmed) merged.add(trimmed);
    }
    if (merged.size === 0) return;
    this.setMeta(INTERNAL_SUMMARY_SESSION_IDS_META_KEY, JSON.stringify(Array.from(merged).sort()));
  }

  getSession(traceId: string): RagSummaryRecord | null {
    const row = this.db.prepare("SELECT * FROM rag_sessions WHERE trace_id = ?").get(traceId) as RagSessionRow | undefined;
    return row ? toSummaryRecord(row) : null;
  }

  upsertSession(input: RagSessionUpsert): void {
    const previous = this.getSession(input.summary.id);
    const keepPreviousSummary = input.status === "failed" || input.status === "stale";
    const summaryJson = input.content ? JSON.stringify(input.content) : keepPreviousSummary ? previous?.summary ? JSON.stringify(previous.summary) : null : null;
    const summaryText = input.summaryText ?? (keepPreviousSummary ? previous?.summaryText ?? "" : "");
    const summaryModel = input.summaryModel ?? (keepPreviousSummary ? previous?.summaryModel ?? "" : "");
    const summaryGeneratedAtMs = input.summaryGeneratedAtMs ?? (keepPreviousSummary ? previous?.summaryGeneratedAtMs ?? null : null);

    this.db.prepare(`
      INSERT INTO rag_sessions (
        trace_id, session_id, agent, parser, source_profile, path,
        first_event_ts, last_event_ts, mtime_ms, size_bytes, event_count,
        fingerprint, status, skip_reason, error, summary_json, summary_text,
        summary_model, summary_generated_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        @traceId, @sessionId, @agent, @parser, @sourceProfile, @path,
        @firstEventTs, @lastEventTs, @mtimeMs, @sizeBytes, @eventCount,
        @fingerprint, @status, @skipReason, @error, @summaryJson, @summaryText,
        @summaryModel, @summaryGeneratedAtMs, @nowMs, @nowMs
      )
      ON CONFLICT(trace_id) DO UPDATE SET
        session_id = excluded.session_id,
        agent = excluded.agent,
        parser = excluded.parser,
        source_profile = excluded.source_profile,
        path = excluded.path,
        first_event_ts = excluded.first_event_ts,
        last_event_ts = excluded.last_event_ts,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        event_count = excluded.event_count,
        fingerprint = excluded.fingerprint,
        status = excluded.status,
        skip_reason = excluded.skip_reason,
        error = excluded.error,
        summary_json = excluded.summary_json,
        summary_text = excluded.summary_text,
        summary_model = excluded.summary_model,
        summary_generated_at_ms = excluded.summary_generated_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run({
      traceId: input.summary.id,
      sessionId: input.summary.sessionId,
      agent: input.summary.agent,
      parser: input.summary.parser,
      sourceProfile: input.summary.sourceProfile,
      path: input.summary.path,
      firstEventTs: input.summary.firstEventTs ?? null,
      lastEventTs: input.summary.lastEventTs ?? null,
      mtimeMs: input.summary.mtimeMs,
      sizeBytes: input.summary.sizeBytes,
      eventCount: input.summary.eventCount,
      fingerprint: input.fingerprint,
      status: input.status,
      skipReason: input.skipReason ?? "",
      error: input.error ?? "",
      summaryJson,
      summaryText,
      summaryModel,
      summaryGeneratedAtMs,
      nowMs: input.nowMs,
    });
  }

  replaceDocuments(traceId: string, documents: RagDocumentInput[], nowMs: number): void {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT document_id FROM rag_documents WHERE trace_id = ?").all(traceId) as Array<{ document_id: string }>;
      for (const row of existing) {
        this.db.prepare("DELETE FROM rag_document_fts WHERE document_id = ?").run(row.document_id);
      }
      this.db.prepare("DELETE FROM rag_documents WHERE trace_id = ?").run(traceId);
      const insertDocument = this.db.prepare(`
        INSERT INTO rag_documents(document_id, trace_id, kind, chunk_index, content, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare("INSERT INTO rag_document_fts(document_id, trace_id, kind, content) VALUES (?, ?, ?, ?)");
      for (const document of documents) {
        insertDocument.run(document.documentId, document.traceId, document.kind, document.chunkIndex, document.content, nowMs, nowMs);
        insertFts.run(document.documentId, document.traceId, document.kind, document.content);
      }
    });
    tx();
  }

  listDocumentsWithoutEmbeddings(model: string, limit: number, options: { kind?: RagDocumentKind } = {}): RagDocumentRecord[] {
    const kindFilter = options.kind ? "AND d.kind = ?" : "";
    const rows = this.db.prepare(`
      SELECT d.* FROM rag_documents d
      LEFT JOIN rag_embeddings e ON e.document_id = d.document_id AND e.model = ?
      WHERE e.document_id IS NULL
        ${kindFilter}
      ORDER BY
        CASE d.kind WHEN 'summary' THEN 0 ELSE 1 END,
        d.updated_at_ms DESC,
        d.document_id
      LIMIT ?
    `).all(...(options.kind ? [model, options.kind, Math.max(1, limit)] : [model, Math.max(1, limit)])) as DocumentRow[];
    return rows.map((row) => ({
      documentId: row.document_id,
      traceId: row.trace_id,
      kind: row.kind,
      chunkIndex: row.chunk_index,
      content: row.content,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  upsertEmbedding(documentId: string, model: string, vector: Float32Array, nowMs: number): void {
    this.db.prepare(`
      INSERT INTO rag_embeddings(document_id, model, dimension, vector, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        model = excluded.model,
        dimension = excluded.dimension,
        vector = excluded.vector,
        updated_at_ms = excluded.updated_at_ms
    `).run(documentId, model, vector.length, vectorToBuffer(vector), nowMs);
  }

  listSummaries(options: { status?: RagRefreshStatus; agent?: AgentKind; sinceMs?: number; limit?: number } = {}): RagSummaryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM rag_sessions
      WHERE (@status = '' OR status = @status)
        AND (@agent = '' OR agent = @agent)
        AND (@sinceMs = 0 OR updated_at_ms >= @sinceMs)
      ORDER BY updated_at_ms DESC, trace_id
      LIMIT @limit
    `).all({
      status: options.status ?? "",
      agent: options.agent ?? "",
      sinceMs: options.sinceMs ?? 0,
      limit: Math.max(1, Math.min(5000, options.limit ?? 200)),
    }) as RagSessionRow[];
    return rows.map(toSummaryRecord);
  }

  listSummaryEmbeddings(options: { status?: RagRefreshStatus; agent?: AgentKind; limit?: number; model?: string } = {}): RagSummaryEmbeddingList {
    const limit = Math.max(1, Math.min(5000, options.limit ?? 5000));
    const filters = {
      status: options.status ?? "complete",
      agent: options.agent ?? "",
      model: options.model ?? this.getMeta("embedding_model") ?? "",
      limit,
    };
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT trace_id FROM rag_sessions
        WHERE (@status = '' OR status = @status)
          AND (@agent = '' OR agent = @agent)
        ORDER BY COALESCE(last_event_ts, mtime_ms) DESC, trace_id
        LIMIT @limit
      )
    `).get(filters) as { count: number }).count;
    const rows = this.db.prepare(`
      WITH filtered_sessions AS (
        SELECT * FROM rag_sessions
        WHERE (@status = '' OR status = @status)
          AND (@agent = '' OR agent = @agent)
        ORDER BY COALESCE(last_event_ts, mtime_ms) DESC, trace_id
        LIMIT @limit
      )
      SELECT
        s.trace_id,
        s.session_id,
        s.agent,
        s.path,
        s.summary_json,
        s.summary_generated_at_ms,
        s.updated_at_ms,
        s.last_event_ts,
        s.mtime_ms,
        e.model,
        e.dimension,
        e.vector
      FROM filtered_sessions s
      JOIN rag_documents d ON d.trace_id = s.trace_id AND d.kind = 'summary'
      JOIN rag_embeddings e ON e.document_id = d.document_id
      WHERE (@model = '' OR e.model = @model)
      ORDER BY COALESCE(s.last_event_ts, s.mtime_ms) DESC, s.trace_id
    `).all(filters) as Array<{
      trace_id: string;
      session_id: string;
      agent: AgentKind;
      path: string;
      summary_json: string | null;
      summary_generated_at_ms: number | null;
      updated_at_ms: number;
      last_event_ts: number | null;
      mtime_ms: number;
      model: string;
      dimension: number;
      vector: Buffer;
    }>;
    return {
      total: Math.min(total, limit),
      rows: rows.map((row) => ({
        traceId: row.trace_id,
        sessionId: row.session_id,
        agent: row.agent,
        path: row.path,
        title: titleFromSummaryJson(row.summary_json, row.trace_id),
        summaryGeneratedAtMs: row.summary_generated_at_ms,
        updatedAtMs: row.updated_at_ms,
        lastEventTs: row.last_event_ts,
        mtimeMs: row.mtime_ms,
        model: row.model,
        dimension: row.dimension,
        vector: row.vector,
      })),
    };
  }

  getStatus(config: AppConfig, embeddingStatus?: Partial<RagIndexStatus["embeddings"]>): RagIndexStatus {
    const pid = readDaemonPid(config.rag.daemonPidPath);
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS stale,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM rag_sessions
    `).get() as Record<string, number | null>;
    const documents = (this.db.prepare("SELECT COUNT(*) AS count FROM rag_documents").get() as { count: number }).count;
    const embedding = this.db.prepare("SELECT COUNT(*) AS count, MAX(dimension) AS dimension FROM rag_embeddings").get() as { count: number; dimension: number | null };
    const dirty = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM rag_documents d
      LEFT JOIN rag_embeddings e ON e.document_id = d.document_id AND e.model = ?
      WHERE e.document_id IS NULL
    `).get(config.rag.embeddingModel) as { count: number }).count;
    const defaultEmbeddingStatus: RagEmbeddingStatus =
      config.rag.embeddingBackend === "disabled" ? "disabled" : embedding.count === 0 ? "missing" : dirty > 0 ? "dirty" : "ready";

    return {
      enabled: config.rag.enabled,
      dbPath: this.dbPath,
      daemon: {
        running: pid !== null && pidIsRunning(pid),
        pid,
        pidPath: expandHome(config.rag.daemonPidPath),
        logPath: expandHome(config.rag.daemonLogPath),
      },
      sessions: {
        total: counts.total ?? 0,
        complete: counts.complete ?? 0,
        pending: counts.pending ?? 0,
        stale: counts.stale ?? 0,
        failed: counts.failed ?? 0,
        skipped: counts.skipped ?? 0,
      },
      documents,
      embeddings: {
        status: embeddingStatus?.status ?? defaultEmbeddingStatus,
        model: embeddingStatus?.model ?? config.rag.embeddingModel,
        dimension: embeddingStatus?.dimension ?? embedding.dimension,
        count: embeddingStatus?.count ?? embedding.count,
        ...(embeddingStatus?.error ? { error: embeddingStatus.error } : {}),
      },
      lastRunAtMs: Number(this.getMeta("last_run_at_ms")) || null,
      lastRunError: this.getMeta("last_run_error"),
    };
  }

  search(options: RagSearchOptions): RagSearchResult[] {
    if (!options.query.trim()) {
      return this.listSummaries({
        status: "complete",
        limit: options.limit,
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
      }).map((summary, index) => ({
        traceId: summary.traceId,
        sessionId: summary.sessionId,
        agent: summary.agent,
        path: summary.path,
        title: summary.summary?.title ?? "",
        userGoal: summary.summary?.userGoal ?? "",
        outcome: summary.summary?.outcome ?? "",
        updatedAtMs: summary.updatedAtMs,
        summaryGeneratedAtMs: summary.summaryGeneratedAtMs,
        score: 1 / (index + 1),
        matchedKinds: ["summary"],
        snippets: summary.summaryText ? [snippet(summary.summaryText, "")] : [],
      }));
    }

    const candidates = Math.max(options.limit, options.limit * Math.max(1, options.candidateMultiplier));
    const byTrace = new Map<string, RagSearchResult>();
    const sessionsByTrace = new Map(
      this.listSummaries({
        limit: 5000,
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
      }).map((row) => [row.traceId, row] as const),
    );
    const addHit = (traceId: string, kind: RagDocumentKind, content: string, lexicalRank?: number, semanticRank?: number, semanticScore?: number): void => {
      const summary = sessionsByTrace.get(traceId);
      if (!summary || summary.status !== "complete") return;
      const existing = byTrace.get(traceId);
      const lexicalScore = lexicalRank ? 1 / (options.rrfK + lexicalRank) : 0;
      const vectorScore = semanticRank ? 1 / (options.rrfK + semanticRank) : 0;
      const score = options.mode === "semantic" ? semanticScore ?? vectorScore : lexicalScore + vectorScore;
      if (!existing) {
        byTrace.set(traceId, {
          traceId,
          sessionId: summary.sessionId,
          agent: summary.agent,
          path: summary.path,
          title: summary.summary?.title ?? "",
          userGoal: summary.summary?.userGoal ?? "",
          outcome: summary.summary?.outcome ?? "",
          updatedAtMs: summary.updatedAtMs,
          summaryGeneratedAtMs: summary.summaryGeneratedAtMs,
          score,
          ...(lexicalRank ? { lexicalRank } : {}),
          ...(semanticRank ? { semanticRank } : {}),
          matchedKinds: [kind],
          snippets: [snippet(content, options.query)],
        });
        return;
      }
      existing.score += score;
      if (lexicalRank && (!existing.lexicalRank || lexicalRank < existing.lexicalRank)) existing.lexicalRank = lexicalRank;
      if (semanticRank && (!existing.semanticRank || semanticRank < existing.semanticRank)) existing.semanticRank = semanticRank;
      existing.matchedKinds = addKind(existing.matchedKinds, kind);
      if (existing.snippets.length < 3) existing.snippets.push(snippet(content, options.query));
    };

    if (options.mode !== "semantic") {
      const fts = normalizeFtsQuery(options.query);
      if (fts) {
        const rows = this.db.prepare(`
          SELECT d.*, bm25(rag_document_fts) AS rank
          FROM rag_document_fts
          JOIN rag_documents d ON d.document_id = rag_document_fts.document_id
          JOIN rag_sessions s ON s.trace_id = d.trace_id
          WHERE rag_document_fts MATCH ?
            AND s.status = 'complete'
            AND (? = '' OR s.agent = ?)
            AND (? = 0 OR s.updated_at_ms >= ?)
          ORDER BY rank ASC
          LIMIT ?
        `).all(fts, options.agent ?? "", options.agent ?? "", options.sinceMs ?? 0, options.sinceMs ?? 0, candidates) as LexicalHitRow[];
        rows.forEach((row, index) => addHit(row.trace_id, row.kind, row.content, index + 1));
      }
    }

    if (options.mode !== "lexical" && options.queryVector) {
      const rows = this.db.prepare(`
        SELECT d.*, e.model, e.dimension, e.vector FROM rag_embeddings e
        JOIN rag_documents d ON d.document_id = e.document_id
        JOIN rag_sessions s ON s.trace_id = d.trace_id
        WHERE e.model = ?
          AND s.status = 'complete'
          AND (? = '' OR s.agent = ?)
          AND (? = 0 OR s.updated_at_ms >= ?)
      `).all(options.queryVector.length > 0 ? this.getMeta("embedding_model") || "" : "", options.agent ?? "", options.agent ?? "", options.sinceMs ?? 0, options.sinceMs ?? 0) as Array<DocumentRow & EmbeddingRow>;
      rows
        .map((row) => ({ row, score: cosine(options.queryVector as Float32Array, bufferToVector(row.vector)) }))
        .sort((left, right) => right.score - left.score || left.row.document_id.localeCompare(right.row.document_id))
        .slice(0, candidates)
        .forEach(({ row, score }, index) => addHit(row.trace_id, row.kind, row.content, undefined, index + 1, score));
    }

    return Array.from(byTrace.values())
      .sort((left, right) => right.score - left.score || right.updatedAtMs - left.updatedAtMs || left.traceId.localeCompare(right.traceId))
      .slice(0, options.limit);
  }
}

export function missingRagStatus(config: AppConfig): RagIndexStatus {
  const pid = readDaemonPid(config.rag.daemonPidPath);
  return {
    enabled: config.rag.enabled,
    dbPath: dbPathFromConfig(config),
    daemon: {
      running: pid !== null && pidIsRunning(pid),
      pid,
      pidPath: expandHome(config.rag.daemonPidPath),
      logPath: expandHome(config.rag.daemonLogPath),
    },
    sessions: { total: 0, complete: 0, pending: 0, stale: 0, failed: 0, skipped: 0 },
    documents: 0,
    embeddings: {
      status: config.rag.embeddingBackend === "disabled" ? "disabled" : "missing",
      model: config.rag.embeddingModel,
      dimension: null,
      count: 0,
    },
    lastRunAtMs: null,
    lastRunError: "",
  };
}
