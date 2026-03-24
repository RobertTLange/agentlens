import type { AgentActivityDay, AgentActivityWeek, AgentActivityYear } from "@agentlens/contracts";
import type { BuildAgentActivityDayOptions, BuildAgentActivityWeekOptions, BuildAgentActivityYearOptions } from "./activity.js";

interface CacheEntry<T> {
  expiresAtMs: number;
  value: T;
}

type WindowActivityValue = {
  bins: AgentActivityDay["bins"];
  totalSessionsInWindow: number;
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
};

const DEFAULT_ACTIVITY_CACHE_TTL_MS = 30_000;

function stableParamsKey(params: Readonly<Record<string, number | string>>): string {
  return Object.entries(params)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export class ActivityResponseCache {
  private readonly responseCache = new Map<string, CacheEntry<AgentActivityDay | AgentActivityWeek | AgentActivityYear>>();
  private readonly windowCache = new Map<string, CacheEntry<WindowActivityValue>>();

  constructor(private readonly ttlMs = DEFAULT_ACTIVITY_CACHE_TTL_MS) {}

  getOrBuildDay(
    version: number,
    nowMs: number,
    options: Readonly<Required<Pick<BuildAgentActivityDayOptions, "dateLocal" | "tzOffsetMinutes" | "binMinutes" | "breakMinutes">>>,
    build: () => AgentActivityDay,
  ): AgentActivityDay {
    return this.getOrBuild(this.responseCache, this.buildDayKey(version, options), nowMs, build) as AgentActivityDay;
  }

  getOrBuildWeek(
    version: number,
    nowMs: number,
    options: Readonly<
      Required<
        Pick<
          BuildAgentActivityWeekOptions,
          "endDateLocal" | "tzOffsetMinutes" | "dayCount" | "slotMinutes" | "hourStartLocal" | "hourEndLocal"
        >
      >
    >,
    build: () => AgentActivityWeek,
  ): AgentActivityWeek {
    return this.getOrBuild(this.responseCache, this.buildWeekKey(version, options), nowMs, build) as AgentActivityWeek;
  }

  getOrBuildYear(
    version: number,
    nowMs: number,
    options: Readonly<
      Required<
        Pick<
          BuildAgentActivityYearOptions,
          "endDateLocal" | "tzOffsetMinutes" | "dayCount"
        >
      >
    >,
    build: () => AgentActivityYear,
  ): AgentActivityYear {
    return this.getOrBuild(this.responseCache, this.buildYearKey(version, options), nowMs, build) as AgentActivityYear;
  }

  getOrBuildWindow(
    version: number,
    nowMs: number,
    options: Readonly<{
      windowStartMs: number;
      windowEndMs: number;
      binMinutes: number;
      breakMinutes: number;
    }>,
    build: () => WindowActivityValue,
  ): WindowActivityValue {
    return this.getOrBuild(this.windowCache, this.buildWindowKey(version, options), nowMs, build);
  }

  private getOrBuild<T>(cache: Map<string, CacheEntry<T>>, key: string, nowMs: number, build: () => T): T {
    const current = cache.get(key);
    if (current && current.expiresAtMs > nowMs) {
      return current.value;
    }
    const value = build();
    cache.set(key, {
      value,
      expiresAtMs: nowMs + this.ttlMs,
    });
    this.pruneExpired(cache, nowMs);
    return value;
  }

  private pruneExpired<T>(cache: Map<string, CacheEntry<T>>, nowMs: number): void {
    if (cache.size < 256) return;
    for (const [key, entry] of cache) {
      if (entry.expiresAtMs > nowMs) continue;
      cache.delete(key);
    }
  }

  private buildDayKey(
    version: number,
    options: Readonly<Required<Pick<BuildAgentActivityDayOptions, "dateLocal" | "tzOffsetMinutes" | "binMinutes" | "breakMinutes">>>,
  ): string {
    return `day|v=${version}|${stableParamsKey(options)}`;
  }

  private buildWeekKey(
    version: number,
    options: Readonly<
      Required<
        Pick<
          BuildAgentActivityWeekOptions,
          "endDateLocal" | "tzOffsetMinutes" | "dayCount" | "slotMinutes" | "hourStartLocal" | "hourEndLocal"
        >
      >
    >,
  ): string {
    return `week|v=${version}|${stableParamsKey(options)}`;
  }

  private buildWindowKey(
    version: number,
    options: Readonly<{
      windowStartMs: number;
      windowEndMs: number;
      binMinutes: number;
      breakMinutes: number;
    }>,
  ): string {
    return `window|v=${version}|${stableParamsKey(options)}`;
  }

  private buildYearKey(
    version: number,
    options: Readonly<Required<Pick<BuildAgentActivityYearOptions, "endDateLocal" | "tzOffsetMinutes" | "dayCount">>>,
  ): string {
    return `year|v=${version}|${stableParamsKey(options)}`;
  }
}

export { DEFAULT_ACTIVITY_CACHE_TTL_MS };
