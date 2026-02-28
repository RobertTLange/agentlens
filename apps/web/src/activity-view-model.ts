import type { AgentActivityBin, AgentActivityDay, AgentKind } from "@agentlens/contracts";
import { kindClassSuffix } from "./view-model.js";

const AGENT_KIND_ORDER: AgentKind[] = ["codex", "claude", "cursor", "opencode", "gemini", "pi", "unknown"];
const EVENT_KIND_ORDER = ["system", "assistant", "user", "tool_use", "tool_result", "reasoning", "compaction", "meta"] as const;
type EventKindKey = (typeof EVENT_KIND_ORDER)[number];
const EVENT_KIND_PASTEL_BY_KIND: Record<EventKindKey, string> = {
  system: "var(--event-system-bg)",
  assistant: "var(--event-assistant-bg)",
  user: "var(--event-user-bg)",
  tool_use: "var(--event-tool-use-bg)",
  tool_result: "var(--event-tool-result-bg)",
  reasoning: "var(--event-reasoning-bg)",
  compaction: "var(--event-compaction-bg)",
  meta: "var(--event-meta-bg)",
};

export interface ActivityTimelineRowModel {
  key: string;
  startMs: number;
  endMs: number;
  timeLabel: string;
  showTimeTick: boolean;
  activeTraceIds: string[];
  barHeightPct: number;
  fillClassName: string;
  borderClassName: string;
  isBreak: boolean;
  isMultiAgent: boolean;
  hasNoAgents: boolean;
  primaryTraceId: string;
  activeSessionCount: number;
  activeAgentCount: number;
  eventKindGradient: string | null;
  tooltip: string;
}

export interface ActivityViewModel {
  rows: ActivityTimelineRowModel[];
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
  peakActiveAgentsInBin: number;
  breakCount: number;
  breakMinutes: number;
  activeBinCount: number;
  inactiveBinCount: number;
}

function countActiveAgents(bin: AgentActivityBin): number {
  let active = 0;
  for (const agent of AGENT_KIND_ORDER) {
    if ((bin.activeByAgent[agent] ?? 0) > 0) active += 1;
  }
  return active;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAgentMix(bin: AgentActivityBin): string {
  const parts = AGENT_KIND_ORDER
    .map((agent) => ({ agent, count: bin.activeByAgent[agent] ?? 0 }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.agent} ${entry.count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function shouldShowTimeTick(startMs: number, rowIndex: number): boolean {
  if (rowIndex === 0) return true;
  const date = new Date(startMs);
  return date.getMinutes() === 0;
}

function buildEventKindGradient(bin: AgentActivityBin): string | null {
  const total = EVENT_KIND_ORDER.reduce((sum, key) => sum + (bin.eventKindCounts[key] ?? 0), 0);
  if (total <= 0) return null;

  let start = 0;
  const stops: string[] = [];
  for (const key of EVENT_KIND_ORDER) {
    const count = bin.eventKindCounts[key] ?? 0;
    if (count <= 0) continue;
    const end = start + (count / total) * 100;
    const color = EVENT_KIND_PASTEL_BY_KIND[key];
    stops.push(`${color} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    start = end;
  }
  if (stops.length === 0) return null;
  return `linear-gradient(180deg, ${stops.join(", ")})`;
}

export function activityAgentBorderClass(agent: AgentKind | "none"): string {
  const suffix = agent.replace(/[^a-z_]/g, "");
  return `agent-border-${suffix || "none"}`;
}

export function buildActivityViewModel(day: AgentActivityDay): ActivityViewModel {
  const maxActiveSessions = day.bins.reduce((maxValue, bin) => Math.max(maxValue, bin.activeSessionCount), 0);

  const rows: ActivityTimelineRowModel[] = day.bins.map((bin, rowIndex) => {
    const activeAgentCount = countActiveAgents(bin);
    const hasNoAgents = bin.activeSessionCount === 0;
    const heightByLoad = maxActiveSessions > 0 ? (bin.activeSessionCount / maxActiveSessions) * 100 : 0;
    const barHeightPct = bin.activeSessionCount > 0 ? Math.max(14, Math.round(heightByLoad)) : 6;
    const dominantEventKind = bin.dominantEventKind;
    const fillClassName = dominantEventKind === "none" ? "kind-none" : `kind-${kindClassSuffix(dominantEventKind)}`;
    const borderClassName = activityAgentBorderClass(bin.dominantAgent);
    const eventKindGradient = buildEventKindGradient(bin);
    const timeLabel = formatClock(bin.startMs);
    const endLabel = formatClock(bin.endMs);
    const tooltip = [
      `${timeLabel}-${endLabel}`,
      `sessions ${bin.activeSessionCount}`,
      hasNoAgents ? "agents none (no agents ran)" : `agents ${activeAgentCount}`,
      `agent mix ${formatAgentMix(bin)}`,
      `event kind ${bin.dominantEventKind}`,
      `events ${bin.eventCount}`,
      `break ${bin.isBreak ? "yes" : "no"}`,
    ].join(" · ");
    return {
      key: `${bin.startMs}-${bin.endMs}`,
      startMs: bin.startMs,
      endMs: bin.endMs,
      timeLabel,
      showTimeTick: shouldShowTimeTick(bin.startMs, rowIndex),
      activeTraceIds: [...bin.activeTraceIds],
      barHeightPct,
      fillClassName,
      borderClassName,
      isBreak: bin.isBreak,
      isMultiAgent: activeAgentCount > 1 || bin.activeSessionCount > 1,
      hasNoAgents,
      primaryTraceId: bin.primaryTraceId,
      activeSessionCount: bin.activeSessionCount,
      activeAgentCount,
      eventKindGradient,
      tooltip,
    };
  });

  let breakCount = 0;
  let breakMinutes = 0;
  let inBreak = false;
  let peakActiveAgentsInBin = 0;
  let activeBinCount = 0;

  for (const row of rows) {
    if (row.activeSessionCount > 0) activeBinCount += 1;
    peakActiveAgentsInBin = Math.max(peakActiveAgentsInBin, row.activeAgentCount);
    if (row.isBreak) {
      breakMinutes += Math.max(0, row.endMs - row.startMs) / 60_000;
      if (!inBreak) {
        breakCount += 1;
        inBreak = true;
      }
    } else {
      inBreak = false;
    }
  }

  return {
    rows,
    peakConcurrentSessions: day.peakConcurrentSessions,
    peakConcurrentAtMs: day.peakConcurrentAtMs,
    peakActiveAgentsInBin,
    breakCount,
    breakMinutes,
    activeBinCount,
    inactiveBinCount: Math.max(0, rows.length - activeBinCount),
  };
}
