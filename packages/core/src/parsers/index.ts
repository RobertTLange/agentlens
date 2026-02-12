import { readFile } from "node:fs/promises";
import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { CursorParser } from "./cursor.js";
import { OpenCodeParser } from "./opencode.js";
import { GenericParser } from "./generic.js";

export class ParserRegistry {
  private readonly parsers: TraceParser[];

  constructor(parsers?: TraceParser[]) {
    this.parsers = parsers ?? [new ClaudeParser(), new CodexParser(), new CursorParser(), new OpenCodeParser(), new GenericParser()];
  }

  private choose(file: DiscoveredTraceFile, headText: string): TraceParser {
    if (file.parserHint && file.parserHint !== "unknown") {
      const hinted = this.parsers.find((parser) => parser.agent === file.parserHint);
      if (hinted) {
        return hinted;
      }
    }

    let best = this.parsers[0];
    let bestScore = -1;

    for (const parser of this.parsers) {
      const score = parser.canParse(file, headText);
      if (score > bestScore) {
        best = parser;
        bestScore = score;
      }
    }

    return best ?? new GenericParser();
  }

  async parseFile(file: DiscoveredTraceFile): Promise<ParseOutput> {
    const text = await readFile(file.path, "utf8");
    const headText = text.slice(0, 8192);
    const parser = this.choose(file, headText);
    return parser.parse(file, text);
  }
}
