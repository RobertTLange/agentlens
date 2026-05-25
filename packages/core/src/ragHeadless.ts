import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, DailyWorkSummaryContent, RagTraceSummaryContent } from "@agentlens/contracts";
import { parseDailyWorkSummaryContent, parseRagTraceSummaryContent } from "./ragCorpus.js";

export interface HeadlessSummaryResult {
  content: RagTraceSummaryContent;
  model: string;
  rawBytes: number;
  internalSummarySessionIds: string[];
}

export interface HeadlessDailySummaryResult {
  content: DailyWorkSummaryContent;
  model: string;
  rawBytes: number;
  internalSummarySessionIds: string[];
}

const ENV_ALLOWLIST = new Set([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "HEADLESS_AUTH_TOKEN",
  "HEADLESS_API_KEY",
]);

function allowedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function addSessionId(value: unknown, sessionIds: Set<string>): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) sessionIds.add(trimmed);
}

function collectHeadlessSessionIds(value: unknown, sessionIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectHeadlessSessionIds(item, sessionIds);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  addSessionId(record.session_id, sessionIds);
  addSessionId(record.sessionId, sessionIds);
  addSessionId(record.sessionID, sessionIds);
  if (record.type === "thread.started") addSessionId(record.thread_id, sessionIds);
  collectHeadlessSessionIds(record["thread.started"], sessionIds);
  const thread = asRecord(record.thread);
  collectHeadlessSessionIds(thread?.started, sessionIds);
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") collectHeadlessSessionIds(nested, sessionIds);
  }
}

function extractHeadlessSessionIds(stdout: string): string[] {
  const sessionIds = new Set<string>();
  const trimmed = stdout.trim();
  try {
    collectHeadlessSessionIds(JSON.parse(trimmed) as unknown, sessionIds);
  } catch {
    // Headless normally emits JSONL, handled below.
  }
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    try {
      collectHeadlessSessionIds(JSON.parse(line) as unknown, sessionIds);
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  return Array.from(sessionIds).sort();
}

function attachHeadlessSessionIds(error: unknown, sessionIds: string[]): Error {
  const next = error instanceof Error ? error : new Error(String(error));
  if (sessionIds.length > 0) {
    Object.assign(next, {
      internalSummarySessionId: sessionIds[0],
      internalSummarySessionIds: sessionIds,
    });
  }
  return next;
}

function extractJsonStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("headless produced no output");
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] ?? "") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.type === "result" && typeof record.result === "string") return record.result;
        const message = record.message;
        if (message && typeof message === "object" && !Array.isArray(message)) {
          const content = (message as Record<string, unknown>).content;
          if (Array.isArray(content)) {
            const text = content
              .map((part) => (part && typeof part === "object" && (part as Record<string, unknown>).type === "text" ? (part as Record<string, unknown>).text : ""))
              .filter((part): part is string => typeof part === "string" && part.length > 0)
              .join("\n");
            if (text) return text;
          }
        }
      }
    } catch {
      // Keep compatibility with older Headless outputs below.
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.output === "string") return record.output;
      if (typeof record.text === "string") return record.text;
      if (typeof record.response === "string") return record.response;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

async function runHeadlessJson<TContent>(
  config: AppConfig,
  prompt: string,
  parseContent: (raw: string) => TContent,
): Promise<{
  content: TContent;
  model: string;
  rawBytes: number;
  internalSummarySessionIds: string[];
}> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agentlens-rag-"));
  const promptPath = path.join(tmpDir, "prompt.md");
  await writeFile(promptPath, prompt, "utf8");
  const timeoutSeconds = Math.max(1, Math.ceil(config.rag.summaryTimeoutMs / 1000));
  const args = [
    config.rag.summaryAgent,
    "--prompt-file",
    promptPath,
    "--work-dir",
    tmpDir,
    "--allow",
    config.rag.summaryPermissionMode || "read-only",
    "--timeout",
    String(timeoutSeconds),
    "--json",
  ];
  if (config.rag.summaryModel) {
    args.push("--model", config.rag.summaryModel);
  }
  if (config.rag.summaryReasoningEffort) {
    args.push("--reasoning-effort", config.rag.summaryReasoningEffort);
  }

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.rag.headlessExecutable, args, {
        cwd: tmpDir,
        env: allowedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdoutText = "";
      let stderrText = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, config.rag.summaryTimeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutText += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrText += String(chunk).slice(0, 4_000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`failed to start headless: ${asErrorMessage(error)}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error("headless summarization timed out"));
          return;
        }
        if (code !== 0) {
          const sessionIds = extractHeadlessSessionIds(stdoutText);
          const diagnostic = [stderrText.trim(), stdoutText.trim()].filter(Boolean).join("\n").slice(-4_000);
          reject(attachHeadlessSessionIds(new Error(`headless exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${diagnostic}`), sessionIds));
          return;
        }
        resolve(stdoutText);
      });
    });
    const sessionIds = extractHeadlessSessionIds(stdout);
    const raw = extractJsonStdout(stdout);
    try {
      return {
        content: parseContent(raw),
        model: config.rag.summaryModel || config.rag.summaryAgent,
        rawBytes: Buffer.byteLength(stdout, "utf8"),
        internalSummarySessionIds: sessionIds,
      };
    } catch (error) {
      throw attachHeadlessSessionIds(error, sessionIds);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function runHeadlessSummary(config: AppConfig, prompt: string): Promise<HeadlessSummaryResult> {
  return runHeadlessJson(config, prompt, parseRagTraceSummaryContent);
}

export async function runHeadlessDailySummary(config: AppConfig, prompt: string): Promise<HeadlessDailySummaryResult> {
  return runHeadlessJson(config, prompt, parseDailyWorkSummaryContent);
}
