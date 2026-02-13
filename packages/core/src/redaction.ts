import type { AppConfig, NormalizedEvent } from "@agentlens/contracts";

interface CompiledPatterns {
  key: RegExp;
  value: RegExp;
}

function toGlobalRegex(regex: RegExp): RegExp {
  if (regex.global) return regex;
  return new RegExp(regex.source, `${regex.flags}g`);
}

function compilePattern(pattern: string, fallback: RegExp): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) return fallback;

  let source = trimmed;
  let flags = "";
  if (source.startsWith("(?i)")) {
    source = source.slice(4);
    flags = "i";
  }

  try {
    return new RegExp(source, flags);
  } catch {
    return fallback;
  }
}

function compilePatterns(config: AppConfig["redaction"]): CompiledPatterns {
  const keyFallback = /api[_-]?key|token|secret|password|private[_-]?key|access[_-]?key|auth|credential|cookie/i;
  const valueFallback = /sk-[a-z0-9_-]+|ghp_[a-z0-9]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----/i;
  return {
    key: compilePattern(config.keyPattern, keyFallback),
    value: compilePattern(config.valuePattern, valueFallback),
  };
}

function shouldRedact(config: AppConfig["redaction"]): boolean {
  if (config.alwaysOn) return true;
  return config.mode !== "off";
}

function redactString(value: string, replacement: string, valuePattern: RegExp): string {
  if (!value) return value;
  const matcher = toGlobalRegex(valuePattern);
  return value.replace(matcher, replacement);
}

function redactUnknown(
  value: unknown,
  replacement: string,
  patterns: CompiledPatterns,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, replacement, patterns.value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, replacement, patterns, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const cached = seen.get(value as object);
  if (cached !== undefined) return cached;

  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (patterns.key.test(key)) {
      out[key] = replacement;
      continue;
    }
    out[key] = redactUnknown(nested, replacement, patterns, seen);
  }
  return out;
}

function redactEventWithCompiled(
  event: NormalizedEvent,
  replacement: string,
  patterns: CompiledPatterns,
): NormalizedEvent {
  const seen = new WeakMap<object, unknown>();

  const preview = redactString(event.preview, replacement, patterns.value);
  const textBlocks = event.textBlocks.map((text) => redactString(text, replacement, patterns.value));
  const toolArgsText = redactString(event.toolArgsText, replacement, patterns.value);
  const toolResultText = redactString(event.toolResultText, replacement, patterns.value);
  const tocLabel = redactString(event.tocLabel, replacement, patterns.value);
  const raw = redactUnknown(event.raw, replacement, patterns, seen) as Record<string, unknown>;

  return {
    ...event,
    preview,
    textBlocks,
    toolArgsText,
    toolResultText,
    tocLabel,
    raw,
    searchText: `${preview}\n${event.rawType}\n${textBlocks.join("\n")}\n${toolArgsText}\n${toolResultText}`.toLowerCase(),
  };
}

export function redactEvent(event: NormalizedEvent, config: AppConfig["redaction"]): NormalizedEvent {
  if (!shouldRedact(config)) return event;
  const patterns = compilePatterns(config);
  return redactEventWithCompiled(event, config.replacement, patterns);
}

export function redactEvents(events: NormalizedEvent[], config: AppConfig["redaction"]): NormalizedEvent[] {
  if (!shouldRedact(config)) return events;
  const patterns = compilePatterns(config);
  return events.map((event) => redactEventWithCompiled(event, config.replacement, patterns));
}
