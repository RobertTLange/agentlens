import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AgentKind,
  AnalysisCountByAgent,
  AnalysisDetectorSupport,
  AnalysisResponse,
  AnalysisSkillUsageRow,
  AnalysisSourceAgentRow,
  AnalysisSubagentUsageRow,
  AnalysisTopSessionRow,
  NamedCount,
  NormalizedEvent,
  TraceSummary,
} from "@agentlens/contracts";
import type { TraceIndex } from "./traceIndex.js";
import { asArray, asRecord, asString, expandHome, nowMs } from "./utils.js";

const AGENT_ORDER: AgentKind[] = ["claude", "codex", "cursor", "opencode", "gemini", "pi", "unknown"];
const SUPPORTED_DETECTOR_AGENTS = new Set<AgentKind>(["codex", "claude"]);
const SKILL_PATH_PATTERN = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md\b/g;

export interface BuildAnalysisOptions {
  agent?: AgentKind;
  since?: number;
  topSessionLimit?: number;
}

interface SkillAggregate {
  name: string;
  explicitCount: number;
  inferredCount: number;
  sessions: Set<string>;
  byAgent: Map<AgentKind, number>;
}

interface SubagentAggregate {
  name: string;
  spawnCount: number;
  sessions: Set<string>;
  byAgent: Map<AgentKind, number>;
}

interface SessionAnalysisCounts {
  explicitSkills: Map<string, number>;
  inferredSkills: Map<string, number>;
  subagents: Map<string, number>;
}

interface InferredSkillMatchers {
  names: string[];
  skillByLowerName: Map<string, string>;
  dollarPattern: RegExp;
  skillWordPattern: RegExp;
  nameInSkillWindowPattern: RegExp;
}

interface SessionAnalysisCacheEntry {
  stamp: string;
  counts: SessionAnalysisCounts;
}

interface AnalysisBuildState {
  inventory: ReturnType<typeof inventoryConfiguredSkills>;
  configuredSkillSet: Set<string>;
  summaries: TraceSummary[];
  byAgent: Map<AgentKind, AnalysisSourceAgentRow>;
  skillAggregates: Map<string, SkillAggregate>;
  subagentAggregates: Map<string, SubagentAggregate>;
  topSessions: AnalysisTopSessionRow[];
  explicitSkillCount: number;
  inferredSkillCount: number;
  subagentSpawnCount: number;
  supportedTraceCount: number;
  topSessionLimit: number;
}

const sessionAnalysisCacheByIndex = new WeakMap<TraceIndex, Map<string, SessionAnalysisCacheEntry>>();

function detectorSupportForAgent(agent: AgentKind): AnalysisDetectorSupport {
  return SUPPORTED_DETECTOR_AGENTS.has(agent) ? "supported" : "unsupported";
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function incrementAgent(map: Map<AgentKind, number>, agent: AgentKind, amount = 1): void {
  map.set(agent, (map.get(agent) ?? 0) + amount);
}

function sortedNamedCounts(counts: Map<string, number>, limit?: number): NamedCount[] {
  const rows = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
  return limit === undefined ? rows : rows.slice(0, Math.max(0, limit));
}

function byAgentRows(counts: Map<AgentKind, number>): AnalysisCountByAgent[] {
  return AGENT_ORDER
    .map((agent) => ({ agent, count: counts.get(agent) ?? 0 }))
    .filter((row) => row.count > 0);
}

function isValidSkillName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function normalizeSkillRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of roots) {
    const expanded = path.resolve(expandHome(root));
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    normalized.push(expanded);
  }
  return normalized;
}

function inventoryConfiguredSkills(skillRoots: string[]): {
  configuredSkills: string[];
  skillRoots: string[];
  warnings: string[];
} {
  const configured = new Set<string>();
  const warnings: string[] = [];
  const roots = normalizeSkillRoots(skillRoots);

  for (const root of roots) {
    if (!existsSync(root)) {
      warnings.push(`Skill root not found: ${root}`);
      continue;
    }
    let rootStat;
    try {
      rootStat = statSync(root);
    } catch (error) {
      warnings.push(`Skill root unavailable: ${root}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!rootStat.isDirectory()) {
      warnings.push(`Skill root is not a directory: ${root}`);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      warnings.push(`Skill root unreadable: ${root}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (!isValidSkillName(entry)) continue;
      const skillMdPath = path.join(root, entry, "SKILL.md");
      if (existsSync(skillMdPath)) {
        configured.add(entry);
      }
    }
  }

  return {
    configuredSkills: Array.from(configured).sort((left, right) => left.localeCompare(right)),
    skillRoots: roots,
    warnings,
  };
}

function rawShallowValueStrings(raw: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const value of Object.values(raw)) {
    if (typeof value === "string") {
      values.push(value);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      values.push(String(value));
    }
  }
  return values;
}

function skillPathSourceTexts(event: NormalizedEvent): string[] {
  return [
    event.toolArgsText,
    event.toolResultText,
    ...event.textBlocks,
    event.preview,
    ...rawShallowValueStrings(event.raw),
  ].filter((value) => value.length > 0);
}

function inferredSkillSourceTexts(event: NormalizedEvent): string[] {
  return [...event.textBlocks, event.preview]
    .map((value) => {
      SKILL_PATH_PATTERN.lastIndex = 0;
      return value.replace(SKILL_PATH_PATTERN, " ");
    })
    .filter((value) => value.length > 0);
}

function extractExplicitSkills(event: NormalizedEvent): string[] {
  const names: string[] = [];
  const seenMatches = new Set<string>();
  for (const source of skillPathSourceTexts(event)) {
    if (!source.includes("SKILL.md") || !source.includes("skills")) continue;
    SKILL_PATH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SKILL_PATH_PATTERN.exec(source)) !== null) {
      const name = match[1] ?? "";
      if (!isValidSkillName(name)) continue;
      const key = `${name}\0${match[0]}`;
      if (seenMatches.has(key)) continue;
      seenMatches.add(key);
      names.push(name);
    }
  }
  return names;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyInferredSkillMatchers(): InferredSkillMatchers {
  return {
    names: [],
    skillByLowerName: new Map(),
    dollarPattern: /$a/,
    skillWordPattern: /\bskill\b/gi,
    nameInSkillWindowPattern: /$a/,
  };
}

function buildInferredSkillMatchers(configuredSkills: string[]): InferredSkillMatchers {
  if (configuredSkills.length === 0) return emptyInferredSkillMatchers();
  const skillByLowerName = new Map(configuredSkills.map((name) => [name.toLowerCase(), name] as const));
  const alternation = configuredSkills
    .slice()
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegExp)
    .join("|");
  const tokenBoundary = `(?![\\w-])`;
  return {
    names: configuredSkills,
    skillByLowerName,
    dollarPattern: new RegExp(`(^|[^\\w-])\\$(${alternation})${tokenBoundary}`, "gi"),
    skillWordPattern: /\bskill\b/gi,
    nameInSkillWindowPattern: new RegExp(`(^|[^\\w-])(${alternation})${tokenBoundary}`, "gi"),
  };
}

function addInferredSkillName(names: string[], seen: Set<string>, matchers: InferredSkillMatchers, rawName: string): void {
  const skillName = matchers.skillByLowerName.get(rawName.toLowerCase());
  if (!skillName || seen.has(skillName)) return;
  seen.add(skillName);
  names.push(skillName);
}

function extractInferredSkills(event: NormalizedEvent, matchers: InferredSkillMatchers): string[] {
  if (matchers.names.length === 0) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  const sources = inferredSkillSourceTexts(event);
  if (sources.length === 0) return [];

  for (const source of sources) {
    if (source.includes("$")) {
      matchers.dollarPattern.lastIndex = 0;
      let dollarMatch: RegExpExecArray | null;
      while ((dollarMatch = matchers.dollarPattern.exec(source)) !== null) {
        addInferredSkillName(names, seen, matchers, dollarMatch[2] ?? "");
      }
    }

    matchers.skillWordPattern.lastIndex = 0;
    let skillMatch: RegExpExecArray | null;
    while ((skillMatch = matchers.skillWordPattern.exec(source)) !== null) {
      const start = Math.max(0, skillMatch.index - 60);
      const end = Math.min(source.length, skillMatch.index + skillMatch[0].length + 60);
      const window = source.slice(start, end);
      matchers.nameInSkillWindowPattern.lastIndex = 0;
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = matchers.nameInSkillWindowPattern.exec(window)) !== null) {
        addInferredSkillName(names, seen, matchers, nameMatch[2] ?? "");
      }
    }
  }
  return names;
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function extractCodexSpawnAgentRoles(event: NormalizedEvent): string[] {
  const roles: string[] = [];
  const toolName = event.toolName || event.functionName;
  if (event.eventKind === "tool_use" && toolName === "spawn_agent") {
    const args = parseJsonObject(event.toolArgsText);
    roles.push(asString(args.agent_type || args.agentType).trim() || "default");
  }

  const rawType = asString(event.raw.type);
  if (rawType === "collab_agent_spawn_end") {
    roles.push(asString(event.raw.new_agent_role).trim() || "unknown");
  }

  const payload = asRecord(event.raw.payload);
  const payloadType = asString(payload.type);
  const payloadName = asString(payload.name || payload.function || payload.tool_name);
  if ((payloadType === "function_call" || payloadType === "custom_tool_call") && payloadName === "spawn_agent") {
    const args = parseJsonObject(asString(payload.arguments || payload.input));
    roles.push(asString(args.agent_type || args.agentType).trim() || "default");
  }

  return roles;
}

function findClaudeTaskInput(event: NormalizedEvent): Record<string, unknown> {
  const args = parseJsonObject(event.toolArgsText);
  if (Object.keys(args).length > 0) return args;

  const message = asRecord(event.raw.message);
  for (const item of asArray(message.content)) {
    const record = asRecord(item);
    if (asString(record.type).toLowerCase() !== "tool_use") continue;
    if (asString(record.name) !== "Task") continue;
    return asRecord(record.input || record.arguments || record.params);
  }
  return {};
}

function extractClaudeTaskRoles(event: NormalizedEvent): string[] {
  if (event.eventKind !== "tool_use" || event.toolName !== "Task") return [];
  const input = findClaudeTaskInput(event);
  return [asString(input.subagent_type || input.agent_type || input.agentType).trim() || "task"];
}

function extractSubagentSpawns(event: NormalizedEvent, agent: AgentKind): string[] {
  if (agent === "codex") return extractCodexSpawnAgentRoles(event);
  if (agent === "claude") return extractClaudeTaskRoles(event);
  return [];
}

function analyzeSession(events: NormalizedEvent[], summary: TraceSummary, matchers: InferredSkillMatchers): SessionAnalysisCounts {
  const explicitSkills = new Map<string, number>();
  const inferredSkills = new Map<string, number>();
  const subagents = new Map<string, number>();
  const seenSubagentEvents = new Set<string>();

  if (!SUPPORTED_DETECTOR_AGENTS.has(summary.agent)) {
    return { explicitSkills, inferredSkills, subagents };
  }

  for (const event of events) {
    for (const skillName of extractExplicitSkills(event)) {
      increment(explicitSkills, skillName);
    }
    for (const skillName of extractInferredSkills(event, matchers)) {
      increment(inferredSkills, skillName);
    }
    for (const role of extractSubagentSpawns(event, summary.agent)) {
      const key = `${event.eventId}\0${role}`;
      if (seenSubagentEvents.has(key)) continue;
      seenSubagentEvents.add(key);
      increment(subagents, role);
    }
  }

  return { explicitSkills, inferredSkills, subagents };
}

function sessionAnalysisStamp(summary: TraceSummary, configuredSkills: string[]): string {
  return [
    summary.eventCount,
    summary.mtimeMs,
    summary.lastEventTs ?? "",
    summary.agent,
    configuredSkills.join("\0"),
  ].join("|");
}

function sessionAnalysisCache(traceIndex: TraceIndex): Map<string, SessionAnalysisCacheEntry> {
  const existing = sessionAnalysisCacheByIndex.get(traceIndex);
  if (existing) return existing;
  const created = new Map<string, SessionAnalysisCacheEntry>();
  sessionAnalysisCacheByIndex.set(traceIndex, created);
  return created;
}

function getSessionAnalysis(
  traceIndex: TraceIndex,
  summary: TraceSummary,
  configuredSkills: string[],
  matchers: InferredSkillMatchers,
): SessionAnalysisCounts {
  const stamp = sessionAnalysisStamp(summary, configuredSkills);
  const cache = sessionAnalysisCache(traceIndex);
  const cached = cache.get(summary.id);
  if (cached?.stamp === stamp) {
    return cached.counts;
  }

  const detail = traceIndex.getSessionDetailUncached(summary.id);
  const counts = analyzeSession(detail.events, detail.summary, matchers);
  cache.set(summary.id, { stamp, counts });
  return counts;
}

function ensureSkillAggregate(aggregates: Map<string, SkillAggregate>, name: string): SkillAggregate {
  const existing = aggregates.get(name);
  if (existing) return existing;
  const created: SkillAggregate = {
    name,
    explicitCount: 0,
    inferredCount: 0,
    sessions: new Set<string>(),
    byAgent: new Map<AgentKind, number>(),
  };
  aggregates.set(name, created);
  return created;
}

function ensureSubagentAggregate(aggregates: Map<string, SubagentAggregate>, name: string): SubagentAggregate {
  const existing = aggregates.get(name);
  if (existing) return existing;
  const created: SubagentAggregate = {
    name,
    spawnCount: 0,
    sessions: new Set<string>(),
    byAgent: new Map<AgentKind, number>(),
  };
  aggregates.set(name, created);
  return created;
}

function totalSessionActivity(row: AnalysisTopSessionRow): number {
  return row.explicitSkillCount + row.inferredSkillCount + row.subagentSpawnCount;
}

function createAnalysisBuildState(traceIndex: TraceIndex, options: BuildAnalysisOptions): AnalysisBuildState {
  const config = traceIndex.getConfig();
  const inventory = inventoryConfiguredSkills(config.analysis.skillRoots);
  const configuredSkillSet = new Set(inventory.configuredSkills);
  const topSessionLimit = Math.max(1, options.topSessionLimit ?? config.analysis.topSessionLimit);
  const sinceCutoff = options.since && options.since > 0 ? nowMs() - options.since : 0;
  const summaries = traceIndex
    .getSummaries()
    .filter((summary) => (options.agent ? summary.agent === options.agent : true))
    .filter((summary) => (sinceCutoff > 0 ? (summary.lastEventTs ?? summary.mtimeMs) >= sinceCutoff : true));

  const byAgent = new Map<AgentKind, AnalysisSourceAgentRow>();
  for (const agent of AGENT_ORDER) {
    byAgent.set(agent, {
      agent,
      detectorSupport: detectorSupportForAgent(agent),
      sessionCount: 0,
      explicitSkillCount: 0,
      inferredSkillCount: 0,
      totalSkillCount: 0,
      subagentSpawnCount: 0,
    });
  }

  const skillAggregates = new Map<string, SkillAggregate>();
  const subagentAggregates = new Map<string, SubagentAggregate>();
  const topSessions: AnalysisTopSessionRow[] = [];
  let explicitSkillCount = 0;
  let inferredSkillCount = 0;
  let subagentSpawnCount = 0;
  let supportedTraceCount = 0;

  return {
    inventory,
    configuredSkillSet,
    summaries,
    byAgent,
    skillAggregates,
    subagentAggregates,
    topSessions,
    explicitSkillCount,
    inferredSkillCount,
    subagentSpawnCount,
    supportedTraceCount,
    topSessionLimit,
  };
}

function processAnalysisSummary(
  state: AnalysisBuildState,
  traceIndex: TraceIndex,
  summary: TraceSummary,
  matchers: InferredSkillMatchers,
): void {
  const sourceRow = state.byAgent.get(summary.agent);
  if (sourceRow) {
    sourceRow.sessionCount += 1;
  }
  if (!SUPPORTED_DETECTOR_AGENTS.has(summary.agent)) {
    return;
  }
  state.supportedTraceCount += 1;

  const sessionCounts = getSessionAnalysis(traceIndex, summary, state.inventory.configuredSkills, matchers);
  const sessionExplicitTotal = Array.from(sessionCounts.explicitSkills.values()).reduce((acc, count) => acc + count, 0);
  const sessionInferredTotal = Array.from(sessionCounts.inferredSkills.values()).reduce((acc, count) => acc + count, 0);
  const sessionSubagentTotal = Array.from(sessionCounts.subagents.values()).reduce((acc, count) => acc + count, 0);

  state.explicitSkillCount += sessionExplicitTotal;
  state.inferredSkillCount += sessionInferredTotal;
  state.subagentSpawnCount += sessionSubagentTotal;
  if (sourceRow) {
    sourceRow.explicitSkillCount += sessionExplicitTotal;
    sourceRow.inferredSkillCount += sessionInferredTotal;
    sourceRow.totalSkillCount += sessionExplicitTotal + sessionInferredTotal;
    sourceRow.subagentSpawnCount += sessionSubagentTotal;
  }

  for (const [name, count] of sessionCounts.explicitSkills) {
    const aggregate = ensureSkillAggregate(state.skillAggregates, name);
    aggregate.explicitCount += count;
    aggregate.sessions.add(summary.id);
    incrementAgent(aggregate.byAgent, summary.agent, count);
  }
  for (const [name, count] of sessionCounts.inferredSkills) {
    const aggregate = ensureSkillAggregate(state.skillAggregates, name);
    aggregate.inferredCount += count;
    aggregate.sessions.add(summary.id);
    incrementAgent(aggregate.byAgent, summary.agent, count);
  }
  for (const [name, count] of sessionCounts.subagents) {
    const aggregate = ensureSubagentAggregate(state.subagentAggregates, name);
    aggregate.spawnCount += count;
    aggregate.sessions.add(summary.id);
    incrementAgent(aggregate.byAgent, summary.agent, count);
  }

  if (sessionExplicitTotal + sessionInferredTotal + sessionSubagentTotal > 0) {
    state.topSessions.push({
      traceId: summary.id,
      sessionId: summary.sessionId,
      agent: summary.agent,
      path: summary.path,
      lastEventTs: summary.lastEventTs,
      mtimeMs: summary.mtimeMs,
      explicitSkillCount: sessionExplicitTotal,
      inferredSkillCount: sessionInferredTotal,
      subagentSpawnCount: sessionSubagentTotal,
      topSkills: sortedNamedCounts(
        new Map([
          ...Array.from(sessionCounts.explicitSkills.entries()),
          ...Array.from(sessionCounts.inferredSkills.entries()).map(([name, count]) => [
            name,
            (sessionCounts.explicitSkills.get(name) ?? 0) + count,
          ] as const),
        ]),
        5,
      ),
      topSubagents: sortedNamedCounts(sessionCounts.subagents, 5),
    });
  }
}

function finalizeAnalysis(state: AnalysisBuildState): AnalysisResponse {
  const skills: AnalysisSkillUsageRow[] = Array.from(state.skillAggregates.values())
    .map((row) => ({
      name: row.name,
      inventoryStatus: state.configuredSkillSet.has(row.name) ? ("configured" as const) : ("unconfigured" as const),
      explicitCount: row.explicitCount,
      inferredCount: row.inferredCount,
      totalCount: row.explicitCount + row.inferredCount,
      sessionCount: row.sessions.size,
      byAgent: byAgentRows(row.byAgent),
    }))
    .sort((left, right) => right.totalCount - left.totalCount || left.name.localeCompare(right.name));

  const subagents: AnalysisSubagentUsageRow[] = Array.from(state.subagentAggregates.values())
    .map((row) => ({
      name: row.name,
      spawnCount: row.spawnCount,
      sessionCount: row.sessions.size,
      byAgent: byAgentRows(row.byAgent),
    }))
    .sort((left, right) => right.spawnCount - left.spawnCount || left.name.localeCompare(right.name));

  const usedConfiguredSkills = new Set(skills.filter((row) => row.inventoryStatus === "configured").map((row) => row.name));
  const unusedConfiguredSkills = state.inventory.configuredSkills.filter((name) => !usedConfiguredSkills.has(name));
  const observedUnconfiguredSkills = skills
    .filter((row) => row.inventoryStatus === "unconfigured")
    .map((row) => row.name)
    .sort((left, right) => left.localeCompare(right));

  return {
    summary: {
      generatedAtMs: nowMs(),
      traceCount: state.summaries.length,
      supportedTraceCount: state.supportedTraceCount,
      explicitSkillCount: state.explicitSkillCount,
      inferredSkillCount: state.inferredSkillCount,
      totalSkillCount: state.explicitSkillCount + state.inferredSkillCount,
      subagentSpawnCount: state.subagentSpawnCount,
      configuredSkillCount: state.inventory.configuredSkills.length,
      unusedConfiguredSkillCount: unusedConfiguredSkills.length,
      observedUnconfiguredSkillCount: observedUnconfiguredSkills.length,
    },
    inventory: {
      configuredSkills: state.inventory.configuredSkills,
      unusedConfiguredSkills,
      observedUnconfiguredSkills,
      skillRoots: state.inventory.skillRoots,
      warnings: state.inventory.warnings,
    },
    byAgent: AGENT_ORDER
      .map((agent) => state.byAgent.get(agent))
      .filter((row): row is AnalysisSourceAgentRow => Boolean(row)),
    skills,
    subagents,
    topSessions: state.topSessions
      .sort(
        (left, right) =>
          totalSessionActivity(right) - totalSessionActivity(left) ||
          (right.lastEventTs ?? right.mtimeMs) - (left.lastEventTs ?? left.mtimeMs) ||
          left.traceId.localeCompare(right.traceId),
      )
      .slice(0, state.topSessionLimit),
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function buildAnalysis(traceIndex: TraceIndex, options: BuildAnalysisOptions = {}): AnalysisResponse {
  const state = createAnalysisBuildState(traceIndex, options);
  const matchers = buildInferredSkillMatchers(state.inventory.configuredSkills);
  for (const summary of state.summaries) {
    processAnalysisSummary(state, traceIndex, summary, matchers);
  }
  return finalizeAnalysis(state);
}

export async function buildAnalysisAsync(
  traceIndex: TraceIndex,
  options: BuildAnalysisOptions & { yieldEvery?: number } = {},
): Promise<AnalysisResponse> {
  const state = createAnalysisBuildState(traceIndex, options);
  const matchers = buildInferredSkillMatchers(state.inventory.configuredSkills);
  const yieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 12));
  for (const [index, summary] of state.summaries.entries()) {
    processAnalysisSummary(state, traceIndex, summary, matchers);
    if ((index + 1) % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }
  return finalizeAnalysis(state);
}
