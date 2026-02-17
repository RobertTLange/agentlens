import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview, parseEpochMs } from "../utils.js";
import { eventKindFromRole, makeEvent } from "./common.js";

function listJsonFiles(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) return [];
  try {
    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(directoryPath, entry.name));
    entries.sort((left, right) => left.localeCompare(right));
    return entries;
  } catch {
    return [];
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseMessageTime(message: Record<string, unknown>): { createdMs: number | null; completedMs: number | null } {
  const time = asRecord(message.time);
  return {
    createdMs: parseEpochMs(time.created),
    completedMs: parseEpochMs(time.completed),
  };
}

function parsePartTimestamp(
  part: Record<string, unknown>,
  fallbackMs: number | null,
  preferEnd: boolean,
): number | null {
  const time = asRecord(part.time);
  if (preferEnd) {
    return parseEpochMs(time.end) ?? parseEpochMs(time.start) ?? parseEpochMs(time.created) ?? fallbackMs ?? null;
  }
  return parseEpochMs(time.start) ?? parseEpochMs(time.created) ?? parseEpochMs(time.end) ?? fallbackMs ?? null;
}

function asFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizeToolType(rawName: string): string {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return "";

  const compact = normalized.replace(/[\s_-]+/g, "");
  if (
    compact === "bash" ||
    compact === "execcommand" ||
    compact === "shellcommand" ||
    compact === "commandexecution" ||
    compact === "writestdin"
  ) {
    return "bash";
  }
  if (compact === "applypatch" || compact === "patch") return "patch";
  if (compact === "askuserquestion" || compact === "requestuserinput") return "input";
  if (compact === "updateplan") return "plan";
  if (compact === "todoread" || compact === "todowrite") return "todo";
  if (compact === "read") return "read";
  if (compact === "edit" || compact === "multiedit") return "edit";
  if (compact === "write") return "write";
  if (compact === "webfetch") return "web:open";
  if (compact === "websearch") return "web:search";
  return normalized.replace(/\s+/g, "_");
}

function resolveStorageRootFromSessionPath(sessionPath: string): string {
  const absolutePath = path.resolve(sessionPath);
  const segments = absolutePath.split(path.sep);
  const storageIndex = segments.findIndex((segment) => segment.toLowerCase() === "storage");

  if (storageIndex > -1) {
    const rootParts = segments.slice(0, storageIndex);
    const joined = rootParts.join(path.sep);
    return joined || path.parse(absolutePath).root;
  }

  return path.resolve(path.dirname(path.dirname(absolutePath)));
}

function parseSessionIdFromPath(filePath: string): string {
  const baseName = path.basename(filePath, path.extname(filePath)).trim();
  return baseName;
}

function escapedSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function runSqliteJsonQuery(dbPath: string, sql: string): Record<string, unknown>[] {
  if (!existsSync(dbPath)) return [];
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => Object.keys(row).length > 0);
  } catch {
    return [];
  }
}

function mergeTimeFields(
  baseTime: Record<string, unknown>,
  rowCreated: number | null,
  rowUpdated: number | null,
): Record<string, unknown> {
  const created = parseEpochMs(baseTime.created) ?? rowCreated ?? null;
  const updated = parseEpochMs(baseTime.updated) ?? rowUpdated ?? null;
  const completed = parseEpochMs(baseTime.completed) ?? updated ?? null;
  const start = parseEpochMs(baseTime.start) ?? created ?? null;
  const end = parseEpochMs(baseTime.end) ?? completed ?? updated ?? null;
  return {
    ...baseTime,
    ...(created !== null ? { created } : {}),
    ...(updated !== null ? { updated } : {}),
    ...(completed !== null ? { completed } : {}),
    ...(start !== null ? { start } : {}),
    ...(end !== null ? { end } : {}),
  };
}

function loadSessionRecordFromSqlite(opencodeRoot: string, sessionId: string): Record<string, unknown> | null {
  if (!sessionId) return null;
  const dbPath = path.join(opencodeRoot, "opencode.db");
  const escapedSessionId = escapedSqlLiteral(sessionId);
  const rows = runSqliteJsonQuery(
    dbPath,
    `select id, project_id as projectID, slug, directory, title, version, time_created as timeCreated, time_updated as timeUpdated from session where id='${escapedSessionId}' limit 1;`,
  );
  const row = rows[0];
  if (!row) return null;

  const created = asFiniteNumber(row.timeCreated);
  const updated = asFiniteNumber(row.timeUpdated);
  return {
    id: asString(row.id),
    projectID: asString(row.projectID),
    slug: asString(row.slug),
    directory: asString(row.directory),
    title: asString(row.title),
    version: asString(row.version),
    time: {
      ...(created !== null ? { created } : {}),
      ...(updated !== null ? { updated } : {}),
    },
  };
}

function loadSessionMessagesFromSqlite(opencodeRoot: string, sessionId: string): MessageWithParts[] {
  if (!sessionId) return [];
  const dbPath = path.join(opencodeRoot, "opencode.db");
  const escapedSessionId = escapedSqlLiteral(sessionId);
  const messageRows = runSqliteJsonQuery(
    dbPath,
    `select id, data, time_created as timeCreated, time_updated as timeUpdated from message where session_id='${escapedSessionId}' order by time_created asc, id asc;`,
  );
  if (messageRows.length === 0) return [];

  const partRows = runSqliteJsonQuery(
    dbPath,
    `select id, message_id as messageID, data, time_created as timeCreated, time_updated as timeUpdated from part where session_id='${escapedSessionId}' order by time_created asc, id asc;`,
  );

  const partsByMessageId = new Map<string, Record<string, unknown>[]>();
  for (const row of partRows) {
    const messageId = asString(row.messageID).trim();
    if (!messageId) continue;
    const partPayload = (() => {
      try {
        const parsed = JSON.parse(asString(row.data)) as unknown;
        return asRecord(parsed);
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const rowCreated = asFiniteNumber(row.timeCreated);
    const rowUpdated = asFiniteNumber(row.timeUpdated);
    const mergedPart = {
      ...partPayload,
      id: asString(partPayload.id) || asString(row.id),
      sessionID: asString(partPayload.sessionID) || sessionId,
      messageID: asString(partPayload.messageID) || messageId,
      time: mergeTimeFields(asRecord(partPayload.time), rowCreated, rowUpdated),
    };
    const bucket = partsByMessageId.get(messageId) ?? [];
    bucket.push(mergedPart);
    partsByMessageId.set(messageId, bucket);
  }

  const messages: MessageWithParts[] = [];
  for (const row of messageRows) {
    const messageId = asString(row.id).trim();
    if (!messageId) continue;
    const messagePayload = (() => {
      try {
        const parsed = JSON.parse(asString(row.data)) as unknown;
        return asRecord(parsed);
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const rowCreated = asFiniteNumber(row.timeCreated);
    const rowUpdated = asFiniteNumber(row.timeUpdated);
    const mergedMessage = {
      ...messagePayload,
      id: asString(messagePayload.id) || messageId,
      sessionID: asString(messagePayload.sessionID) || sessionId,
      time: mergeTimeFields(asRecord(messagePayload.time), rowCreated, rowUpdated),
    };
    const parts = partsByMessageId.get(messageId) ?? [];
    messages.push({ message: mergedMessage, parts });
  }

  return messages;
}

function summarizeTokens(tokens: Record<string, unknown>): string {
  if (Object.keys(tokens).length === 0) return "";
  const cache = asRecord(tokens.cache);
  const input = Number(tokens.input ?? 0);
  const output = Number(tokens.output ?? 0);
  const reasoning = Number(tokens.reasoning ?? 0);
  const cachedRead = Number(cache.read ?? 0);
  const cachedWrite = Number(cache.write ?? 0);
  const total = Number(tokens.total ?? input + output + reasoning + cachedRead + cachedWrite);
  return `tokens: total=${total} input=${input} output=${output} reasoning=${reasoning} cache_read=${cachedRead} cache_write=${cachedWrite}`;
}

interface MessageWithParts {
  message: Record<string, unknown>;
  parts: Record<string, unknown>[];
}

function loadSessionMessages(opencodeRoot: string, sessionId: string): MessageWithParts[] {
  const messageDir = path.join(opencodeRoot, "storage", "message", sessionId);
  const messageFiles = listJsonFiles(messageDir);
  const messages = messageFiles
    .map((filePath) => readJsonRecord(filePath))
    .filter((message): message is Record<string, unknown> => message !== null)
    .filter((message) => {
      const rowSessionId = asString(message.sessionID).trim();
      return rowSessionId ? rowSessionId === sessionId : true;
    });

  const sortedMessages = [...messages].sort((left, right) => {
    const leftCreated = parseMessageTime(left).createdMs ?? 0;
    const rightCreated = parseMessageTime(right).createdMs ?? 0;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return asString(left.id).localeCompare(asString(right.id));
  });
  if (sortedMessages.length === 0) {
    return loadSessionMessagesFromSqlite(opencodeRoot, sessionId);
  }
  return sortedMessages.map((message) => {
    const messageId = asString(message.id).trim();
    const partDir = path.join(opencodeRoot, "storage", "part", messageId);
    const parts = listJsonFiles(partDir)
      .map((filePath) => readJsonRecord(filePath))
      .filter((part): part is Record<string, unknown> => part !== null)
      .filter((part) => {
        const rowSessionId = asString(part.sessionID).trim();
        if (!rowSessionId) return true;
        return rowSessionId === sessionId;
      });
    return { message, parts };
  });
}

export class OpencodeParser implements TraceParser {
  name = "opencode";
  agent = "opencode" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/opencode/")) confidence += 0.2;
    if (filePath.includes("/storage/session/")) confidence += 0.55;
    if (filePath.endsWith(".json")) confidence += 0.1;
    if (head.includes('"slug"') && head.includes('"projectid"') && head.includes('"directory"')) confidence += 0.25;

    return Math.min(confidence, 1);
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    let session = {} as Record<string, unknown>;
    const sessionIdFromPath = parseSessionIdFromPath(file.path);
    const normalizedPath = file.path.replace(/\\/g, "/").toLowerCase();
    const isSessionDiffPath = normalizedPath.includes("/storage/session_diff/");
    const opencodeRoot = resolveStorageRootFromSessionPath(file.path);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        session = parsed as Record<string, unknown>;
      } else if (!(Array.isArray(parsed) && isSessionDiffPath)) {
        return {
          agent: "opencode",
          parser: this.name,
          sessionId: sessionIdFromPath,
          events: [],
          parseError: "invalid OpenCode session payload",
        };
      }
    } catch (error) {
      return {
        agent: "opencode",
        parser: this.name,
        sessionId: sessionIdFromPath,
        events: [],
        parseError: error instanceof Error ? error.message : String(error),
      };
    }

    const sqliteSession = loadSessionRecordFromSqlite(opencodeRoot, sessionIdFromPath);
    if (sqliteSession) {
      const mergedTime = {
        ...asRecord(sqliteSession.time),
        ...asRecord(session.time),
      };
      session = {
        ...sqliteSession,
        ...session,
        ...(Object.keys(mergedTime).length > 0 ? { time: mergedTime } : {}),
      };
    }

    const events: ParseOutput["events"] = [];
    let eventIndex = 1;
    let offset = 0;
    const sessionId = asString(session.id).trim() || sessionIdFromPath;
    const sessionTime = asRecord(session.time);
    const sessionCreatedMs = parseEpochMs(sessionTime.created);
    const sessionUpdatedMs = parseEpochMs(sessionTime.updated);
    const sessionCwd = asString(session.directory).trim();
    const sessionTitle = asString(session.title).trim();
    const sessionVersion = asString(session.version).trim();
    const sessionSlug = asString(session.slug).trim();
    const sessionProjectId = asString(session.projectID).trim();

    const pushEvent = (seed: Omit<Parameters<typeof makeEvent>[0], "traceId" | "index" | "offset">): void => {
      events.push(
        makeEvent({
          traceId: file.id,
          index: eventIndex,
          offset,
          ...seed,
        }),
      );
      eventIndex += 1;
      offset += 1;
    };

    pushEvent({
      timestampMs: sessionCreatedMs ?? sessionUpdatedMs,
      sessionId,
      eventKind: "meta",
      rawType: isSessionDiffPath ? "session_diff_meta" : "session_meta",
      role: "system",
      preview: normalizePreview(`session_meta: ${sessionId || "session"}`),
      textBlocks: [sessionCwd, sessionTitle, sessionVersion].filter(Boolean),
      tocLabel: "Session metadata",
      searchChunks: [
        "session_meta",
        sessionId,
        sessionSlug,
        sessionCwd,
        sessionTitle,
        sessionProjectId,
        sessionVersion,
      ],
      raw: {
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: sessionCwd,
          title: sessionTitle,
          version: sessionVersion,
          slug: sessionSlug,
          project_id: sessionProjectId,
          updated: sessionUpdatedMs,
          created: sessionCreatedMs,
        },
      },
    });

    const messages = loadSessionMessages(opencodeRoot, sessionId);

    for (const { message, parts } of messages) {
      const role = asString(message.role).trim().toLowerCase();
      const messageId = asString(message.id).trim();
      const messageSessionId = asString(message.sessionID).trim() || sessionId;
      const messageParentId = asString(message.parentID).trim();
      const { createdMs: messageCreatedMs, completedMs: messageCompletedMs } = parseMessageTime(message);

      if (parts.length === 0) {
        const preview =
          role === "assistant"
            ? normalizePreview(asString(message.finish) || asString(message.modelID) || messageId || "assistant message")
            : normalizePreview(asString(asRecord(message.summary).title) || messageId || "user message");
        pushEvent({
          timestampMs: messageCreatedMs ?? sessionUpdatedMs,
          sessionId: messageSessionId,
          eventKind: eventKindFromRole(role),
          rawType: "message",
          role: role || "assistant",
          preview,
          parentEventId: messageParentId,
          tocLabel: preview,
          searchChunks: [role, messageId, preview],
          raw: { message },
        });
        continue;
      }

      for (const part of parts) {
        const partType = asString(part.type).trim().toLowerCase();
        const partId = asString(part.id).trim();
        const timestampStart = parsePartTimestamp(part, messageCreatedMs ?? sessionCreatedMs, false);
        const timestampEnd = parsePartTimestamp(part, messageCompletedMs ?? messageCreatedMs ?? sessionUpdatedMs, true);

        if (partType === "text") {
          const textValue = asString(part.text);
          const preview = normalizePreview(textValue || `${role || "assistant"} text`);
          const eventKind = role === "user" ? "user" : "assistant";
          pushEvent({
            timestampMs: timestampStart,
            sessionId: messageSessionId,
            eventKind,
            rawType: "text",
            role: role || (eventKind === "user" ? "user" : "assistant"),
            preview,
            textBlocks: textValue ? [textValue] : [],
            parentEventId: messageParentId,
            tocLabel: preview,
            searchChunks: [role, messageId, partId, partType, textValue],
            raw: { message, part },
          });
          continue;
        }

        if (partType === "reasoning") {
          const reasoningText = asString(part.text);
          const preview = normalizePreview(reasoningText || "thinking");
          pushEvent({
            timestampMs: timestampStart,
            sessionId: messageSessionId,
            eventKind: "reasoning",
            rawType: "reasoning",
            role: "assistant",
            preview,
            textBlocks: reasoningText ? [reasoningText] : [],
            parentEventId: messageParentId,
            tocLabel: "Thinking",
            searchChunks: [role, messageId, partId, partType, reasoningText],
            raw: { message, part },
          });
          continue;
        }

        if (partType === "tool") {
          const state = asRecord(part.state);
          const status = asString(state.status).trim().toLowerCase();
          const toolName = asString(part.tool) || "tool";
          const toolCallId = asString(part.callID) || partId || messageId;
          const toolType = normalizeToolType(toolName);
          const toolArgsText = compactText(state.input || state.raw);
          const toolTitle = asString(state.title).trim();
          const usePreview = normalizePreview(toolArgsText ? `${toolName}: ${toolArgsText}` : toolTitle || `tool ${toolName}`);

          pushEvent({
            timestampMs: timestampStart,
            sessionId: messageSessionId,
            eventKind: "tool_use",
            rawType: "tool",
            role: "assistant",
            preview: usePreview,
            textBlocks: toolArgsText ? [toolArgsText] : toolTitle ? [toolTitle] : [],
            toolUseId: toolCallId,
            toolCallId,
            toolName,
            toolType,
            functionName: toolName,
            toolArgsText,
            parentEventId: messageParentId,
            tocLabel: `Tool: ${toolName}`,
            searchChunks: [role, messageId, partId, partType, toolName, toolCallId, toolType, toolArgsText, status, toolTitle],
            raw: { message, part },
          });

          if (status === "completed" || status === "error") {
            const toolResultText =
              status === "error"
                ? compactText(state.error || state.output || state.metadata)
                : compactText(state.output || state.metadata || state.title);
            const resultPreview = normalizePreview(toolResultText || `tool result ${toolCallId}`);
            pushEvent({
              timestampMs: timestampEnd ?? timestampStart,
              sessionId: messageSessionId,
              eventKind: "tool_result",
              rawType: "tool",
              role: "assistant",
              preview: resultPreview,
              textBlocks: toolResultText ? [toolResultText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName,
              toolType,
              toolResultText,
              hasError: status === "error",
              parentEventId: messageParentId,
              tocLabel: `Result: ${toolCallId}`,
              searchChunks: [role, messageId, partId, partType, toolName, toolCallId, toolType, toolResultText, status],
              raw: { message, part },
            });
          }
          continue;
        }

        const metaPreview = (() => {
          if (partType === "step-start") return "Step started";
          if (partType === "step-finish") {
            const reason = asString(part.reason);
            return normalizePreview(reason ? `Step finished: ${reason}` : "Step finished");
          }
          if (partType === "patch") {
            const hash = asString(part.hash).trim();
            return normalizePreview(hash ? `Patch: ${hash}` : "Patch");
          }
          if (partType === "snapshot") return "Snapshot";
          if (partType === "file") {
            return normalizePreview(asString(part.filename) || asString(part.url) || "File attachment");
          }
          if (partType === "subtask") return normalizePreview(`Subtask: ${asString(part.description) || asString(part.prompt)}`);
          if (partType === "agent") return normalizePreview(`Agent: ${asString(part.name) || "agent"}`);
          if (partType === "retry") return normalizePreview(`Retry: ${asString(asRecord(part.error).message) || asString(part.attempt)}`);
          if (partType === "compaction") return "Compaction";
          return normalizePreview(partType || compactText(part) || "meta");
        })();

        const metaTextBlocks = (() => {
          if (partType === "step-start") {
            return [asString(part.snapshot)].filter(Boolean);
          }
          if (partType === "step-finish") {
            const tokens = summarizeTokens(asRecord(part.tokens));
            const cost = typeof part.cost === "number" && Number.isFinite(part.cost) ? `cost: ${part.cost.toFixed(6)}` : "";
            return [asString(part.reason), tokens, cost, asString(part.snapshot)].filter(Boolean);
          }
          if (partType === "patch") {
            return [asString(part.hash), ...asArray(part.files).map((value) => asString(value)).filter(Boolean)];
          }
          if (partType === "file") {
            return [asString(part.mime), asString(part.url), asString(part.filename)].filter(Boolean);
          }
          if (partType === "subtask") {
            return [asString(part.prompt), asString(part.description), asString(part.agent)].filter(Boolean);
          }
          if (partType === "agent") {
            return [asString(part.name)].filter(Boolean);
          }
          if (partType === "retry") {
            return [asString(part.attempt), asString(asRecord(part.error).message)].filter(Boolean);
          }
          if (partType === "compaction") {
            return [asString(part.auto)].filter(Boolean);
          }
          if (partType === "snapshot") {
            return [asString(part.snapshot)].filter(Boolean);
          }
          return [compactText(part)].filter(Boolean);
        })();

        pushEvent({
          timestampMs: timestampEnd ?? timestampStart,
          sessionId: messageSessionId,
          eventKind: "meta",
          rawType: partType || "meta",
          role: "system",
          preview: metaPreview,
          textBlocks: metaTextBlocks,
          parentEventId: messageParentId,
          tocLabel: metaPreview,
          searchChunks: [role, messageId, partId, partType, metaPreview, ...metaTextBlocks],
          raw: { message, part },
        });
      }
    }

    return {
      agent: "opencode",
      parser: this.name,
      sessionId,
      events,
      parseError: "",
    };
  }
}
