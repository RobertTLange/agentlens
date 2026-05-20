import type {
  AgentKind,
  AnalysisResponse,
  AnalysisSkillUsageRow,
  AnalysisSourceAgentRow,
  AnalysisSubagentUsageRow,
  AnalysisTopSessionRow,
} from "@agentlens/contracts";
import { formatCompactNumber, iconForAgent, kindClassSuffix } from "./view-model.js";

export interface AnalysisOverviewMetric {
  label: string;
  value: string;
  detail: string;
  tone: "sessions" | "skills" | "subagents" | "inventory";
}

export interface AnalysisSkillBarRow extends AnalysisSkillUsageRow {
  totalWidthPct: number;
  explicitPct: number;
  inferredPct: number;
  byAgentLabel: string;
}

export interface AnalysisAgentCardRow extends AnalysisSourceAgentRow {
  icon: string | null;
  kindClass: string;
  skillSharePct: number;
  sessionSharePct: number;
}

export interface AnalysisSubagentBarRow extends AnalysisSubagentUsageRow {
  widthPct: number;
  byAgentLabel: string;
}

export interface AnalysisSessionCardRow extends AnalysisTopSessionRow {
  activityCount: number;
  activityWidthPct: number;
  topSkillsLabel: string;
  topSubagentsLabel: string;
}

export interface AnalysisDashboardModel {
  overview: AnalysisOverviewMetric[];
  skillBars: AnalysisSkillBarRow[];
  agentCards: AnalysisAgentCardRow[];
  subagentBars: AnalysisSubagentBarRow[];
  sessionCards: AnalysisSessionCardRow[];
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function namedCountsLabel(rows: Array<{ name: string; count: number }>): string {
  if (rows.length === 0) return "-";
  return rows.map((row) => `${row.name} ${row.count}`).join(", ");
}

function byAgentLabel(rows: Array<{ agent: AgentKind; count: number }>): string {
  if (rows.length === 0) return "-";
  return rows.map((row) => `${row.agent} ${row.count}`).join(", ");
}

export function buildAnalysisDashboardModel(analysis: AnalysisResponse): AnalysisDashboardModel {
  const maxSkillTotal = Math.max(1, ...analysis.skills.map((row) => row.totalCount));
  const maxSubagentTotal = Math.max(1, ...analysis.subagents.map((row) => row.spawnCount));
  const maxSessionActivity = Math.max(
    1,
    ...analysis.topSessions.map((row) => row.explicitSkillCount + row.inferredSkillCount + row.subagentSpawnCount),
  );
  const totalAgentSkillUses = Math.max(1, analysis.byAgent.reduce((sum, row) => sum + row.totalSkillCount, 0));
  const totalAgentSessions = Math.max(1, analysis.byAgent.reduce((sum, row) => sum + row.sessionCount, 0));

  return {
    overview: [
      {
        label: "Sessions scanned",
        value: formatCompactNumber(analysis.summary.traceCount),
        detail: `${formatCompactNumber(analysis.summary.supportedTraceCount)} supported`,
        tone: "sessions",
      },
      {
        label: "Skill uses",
        value: formatCompactNumber(analysis.summary.totalSkillCount),
        detail: `${formatCompactNumber(analysis.summary.explicitSkillCount)} explicit / ${formatCompactNumber(analysis.summary.inferredSkillCount)} inferred`,
        tone: "skills",
      },
      {
        label: "Subagent spawns",
        value: formatCompactNumber(analysis.summary.subagentSpawnCount),
        detail: `${formatCompactNumber(analysis.subagents.length)} roles observed`,
        tone: "subagents",
      },
      {
        label: "Inventory health",
        value: formatCompactNumber(analysis.summary.configuredSkillCount),
        detail: `${formatCompactNumber(analysis.summary.unusedConfiguredSkillCount)} unused / ${formatCompactNumber(analysis.summary.observedUnconfiguredSkillCount)} unconfigured`,
        tone: "inventory",
      },
    ],
    skillBars: analysis.skills.slice(0, 8).map((row) => ({
      ...row,
      totalWidthPct: percent(row.totalCount, maxSkillTotal),
      explicitPct: percent(row.explicitCount, row.totalCount),
      inferredPct: percent(row.inferredCount, row.totalCount),
      byAgentLabel: byAgentLabel(row.byAgent),
    })),
    agentCards: analysis.byAgent.map((row) => ({
      ...row,
      icon: iconForAgent(row.agent),
      kindClass: `kind-${kindClassSuffix(row.agent)}`,
      skillSharePct: percent(row.totalSkillCount, totalAgentSkillUses),
      sessionSharePct: percent(row.sessionCount, totalAgentSessions),
    })),
    subagentBars: analysis.subagents.slice(0, 6).map((row) => ({
      ...row,
      widthPct: percent(row.spawnCount, maxSubagentTotal),
      byAgentLabel: byAgentLabel(row.byAgent),
    })),
    sessionCards: analysis.topSessions.slice(0, 8).map((row) => {
      const activityCount = row.explicitSkillCount + row.inferredSkillCount + row.subagentSpawnCount;
      return {
        ...row,
        activityCount,
        activityWidthPct: percent(activityCount, maxSessionActivity),
        topSkillsLabel: namedCountsLabel(row.topSkills),
        topSubagentsLabel: namedCountsLabel(row.topSubagents),
      };
    }),
  };
}
