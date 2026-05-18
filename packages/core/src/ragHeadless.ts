import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, RagTraceSummaryContent } from "@agentlens/contracts";
import { parseRagTraceSummaryContent } from "./ragCorpus.js";

export interface HeadlessSummaryResult {
  content: RagTraceSummaryContent;
  model: string;
  rawBytes: number;
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

function extractJsonStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("headless produced no output");
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

export async function runHeadlessSummary(config: AppConfig, prompt: string): Promise<HeadlessSummaryResult> {
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
          reject(new Error(`headless exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderrText.trim()}`));
          return;
        }
        resolve(stdoutText);
      });
    });
    const raw = extractJsonStdout(stdout);
    return {
      content: parseRagTraceSummaryContent(raw),
      model: config.rag.summaryModel || config.rag.summaryAgent,
      rawBytes: Buffer.byteLength(stdout, "utf8"),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
