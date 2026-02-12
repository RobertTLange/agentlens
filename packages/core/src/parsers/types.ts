import type { AgentKind, NormalizedEvent } from "@agentlens/contracts";
import type { DiscoveredTraceFile } from "../discovery.js";

export interface ParseOutput {
  agent: AgentKind;
  parser: string;
  sessionId: string;
  events: NormalizedEvent[];
  parseError: string;
}

export interface TraceParser {
  name: string;
  agent: AgentKind;
  canParse(file: DiscoveredTraceFile, headText: string): number;
  parse(file: DiscoveredTraceFile, text: string): ParseOutput;
}
