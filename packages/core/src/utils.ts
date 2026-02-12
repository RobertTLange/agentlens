import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function stableId(parts: string[]): string {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 24);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function nowMs(): number {
  return Date.now();
}

export function parseEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }
    if (value > 1_000_000_000) {
      return Math.round(value * 1000);
    }
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function normalizePreview(text: string, maxLen = 140): string {
  const first = text.trim().split(/\r?\n/, 1)[0] ?? "";
  if (first.length <= maxLen) {
    return first;
  }
  return `${first.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function compactText(value: unknown, maxLen = 220): string {
  if (value === null || value === undefined) {
    return "";
  }

  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function toMsWindow(since: string): number {
  const value = since.trim().toLowerCase();
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) {
    const parsed = Date.parse(since);
    if (!Number.isNaN(parsed)) {
      return Date.now() - parsed;
    }
    return 0;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const unitMs = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * unitMs;
}
