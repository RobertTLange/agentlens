import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asString, normalizePreview } from "../utils.js";
import { guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

export class GenericParser implements TraceParser {
  name = "generic";
  agent = "unknown" as const;

  canParse(): number {
    return 0.01;
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    const rows = parseJsonLines(text);
    const events = rows.map((row, idx) =>
      makeEvent({
        traceId: file.id,
        index: idx + 1,
        offset: row.offset,
        timestampMs: guessTimestamp(row.value),
        sessionId: "",
        eventKind: "meta",
        rawType: asString(row.value.type) || "event",
        role: "system",
        preview: normalizePreview(asString(row.value.type) || "event"),
        raw: row.value,
      }),
    );

    return {
      agent: file.agentHint,
      parser: this.name,
      sessionId: "",
      events,
      parseError: "",
    };
  }
}
