import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { CursorParser } from "./cursor.js";
import { GeminiParser } from "./gemini.js";
import { GenericParser } from "./generic.js";
import { OpencodeParser } from "./opencode.js";
import { PiParser } from "./pi.js";

export class ParserRegistry {
  private readonly parsers: TraceParser[];

  constructor(parsers?: TraceParser[]) {
    this.parsers = parsers ?? [
      new ClaudeParser(),
      new CodexParser(),
      new CursorParser(),
      new OpencodeParser(),
      new GeminiParser(),
      new PiParser(),
      new GenericParser(),
    ];
  }

  private byName(name: string): TraceParser | undefined {
    return this.parsers.find((parser) => parser.name === name);
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

  parseText(file: DiscoveredTraceFile, text: string, parserNameHint?: string): ParseOutput {
    const hinted = parserNameHint ? this.byName(parserNameHint) : undefined;
    const parser = hinted ?? this.choose(file, text.slice(0, 8192));
    return parser.parse(file, text);
  }

  async parseFile(file: DiscoveredTraceFile): Promise<ParseOutput> {
    const text = await readFile(file.path, "utf8");
    return this.parseText(file, text);
  }

  parseFileSync(file: DiscoveredTraceFile, parserNameHint?: string): ParseOutput {
    const text = readFileSync(file.path, "utf8");
    const headText = text.slice(0, 8192);
    const hinted = parserNameHint ? this.byName(parserNameHint) : undefined;
    const parser = hinted ?? this.choose(file, headText);
    return parser.parse(file, text);
  }
}
