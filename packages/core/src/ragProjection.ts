import type { AgentKind, AppConfig, RagProjectionItem, RagProjectionResponse, RagRefreshStatus } from "@agentlens/contracts";
import { RagStore, type RagSummaryEmbeddingRow } from "./ragStore.js";
import { bufferToVector, dbPathFromConfig } from "./ragStoreHelpers.js";
import { existsSync } from "node:fs";

const POWER_ITERATIONS = 32;
const LOCAL_EDGE_RATIO = 2.2;

interface ProjectableRow extends RagSummaryEmbeddingRow {
  vectorValues: number[];
}

function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(dot(vector, vector));
  if (!Number.isFinite(norm) || norm <= 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

function multiplyCovariance(centered: readonly number[][], axis: readonly number[]): number[] {
  const out = Array.from({ length: axis.length }, () => 0);
  if (centered.length === 0) return out;
  for (const row of centered) {
    const projection = dot(row, axis);
    for (let index = 0; index < out.length; index += 1) {
      out[index] = (out[index] ?? 0) + projection * (row[index] ?? 0);
    }
  }
  return out.map((value) => value / centered.length);
}

function principalAxis(centered: readonly number[][], seedIndex: number, previous?: readonly number[]): number[] {
  const dimension = centered[0]?.length ?? 0;
  let axis: number[] = Array.from({ length: dimension }, (_, index) => (index === seedIndex % Math.max(1, dimension) ? 1 : 0));
  axis = normalize(axis);
  for (let iteration = 0; iteration < POWER_ITERATIONS; iteration += 1) {
    let next = multiplyCovariance(centered, axis);
    if (previous) {
      const previousScale = dot(next, previous);
      next = next.map((value, index) => value - previousScale * (previous[index] ?? 0));
    }
    const normalized = normalize(next);
    if (normalized.every((value) => value === 0)) break;
    axis = normalized;
  }
  return axis;
}

function centerVectors(rows: readonly ProjectableRow[]): number[][] {
  const dimension = rows[0]?.vectorValues.length ?? 0;
  const mean = Array.from({ length: dimension }, () => 0);
  for (const row of rows) {
    for (let index = 0; index < dimension; index += 1) {
      mean[index] = (mean[index] ?? 0) + (row.vectorValues[index] ?? 0);
    }
  }
  for (let index = 0; index < dimension; index += 1) {
    mean[index] = (mean[index] ?? 0) / rows.length;
  }
  return rows.map((row) => row.vectorValues.map((value, index) => value - (mean[index] ?? 0)));
}

function projectRows(rows: readonly ProjectableRow[]): Array<{ x: number; y: number }> {
  const centered = centerVectors(rows);
  const firstAxis = principalAxis(centered, 0);
  const secondAxis = principalAxis(centered, 1, firstAxis);
  return centered.map((row) => ({
    x: dot(row, firstAxis),
    y: dot(row, secondAxis),
  }));
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function adaptiveNeighborCount(pointCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, pointCount))));
}

interface NeighborDistance {
  index: number;
  distance: number;
}

function buildNeighborDistances(
  rows: ReadonlyArray<{ traceId: string }>,
  points: ReadonlyArray<{ x: number; y: number }>,
): NeighborDistance[][] {
  return points.map((point, index) => (
    points
      .map((otherPoint, otherIndex) => ({
        index: otherIndex,
        distance: index === otherIndex ? Number.POSITIVE_INFINITY : distance(point, otherPoint),
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => (
        left.distance - right.distance ||
        (rows[left.index]?.traceId ?? String(left.index)).localeCompare(rows[right.index]?.traceId ?? String(right.index))
      ))
  ));
}

function localDistanceScale(neighbors: readonly NeighborDistance[]): number {
  return neighbors.find((neighbor) => Number.isFinite(neighbor.distance) && neighbor.distance > 0)?.distance ?? Number.EPSILON;
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index] ?? index;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    this.parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  }
}

export function assignAdaptiveClusters(
  rows: ReadonlyArray<{ traceId: string }>,
  points: ReadonlyArray<{ x: number; y: number }>,
): number[] {
  if (points.length <= 1) return points.map(() => 0);
  const neighborCount = adaptiveNeighborCount(points.length);
  const neighborDistances = buildNeighborDistances(rows, points);
  const localScales = neighborDistances.map((neighbors) => localDistanceScale(neighbors));
  if (localScales.every((value) => !Number.isFinite(value) || value <= Number.EPSILON)) return points.map(() => 0);
  const neighborSets = neighborDistances.map((neighbors) => new Set(neighbors.slice(0, neighborCount).map((neighbor) => neighbor.index)));
  const sets = new DisjointSet(points.length);

  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (!neighborSets[left]?.has(right) || !neighborSets[right]?.has(left)) continue;
      const pairDistance = distance(points[left] ?? { x: 0, y: 0 }, points[right] ?? { x: 0, y: 0 });
      const leftRatio = pairDistance / Math.max(localScales[left] ?? Number.EPSILON, Number.EPSILON);
      const rightRatio = pairDistance / Math.max(localScales[right] ?? Number.EPSILON, Number.EPSILON);
      if (leftRatio <= LOCAL_EDGE_RATIO && rightRatio <= LOCAL_EDGE_RATIO) sets.union(left, right);
    }
  }

  const componentTraceIds = new Map<number, string>();
  for (let index = 0; index < points.length; index += 1) {
    const root = sets.find(index);
    const traceId = rows[index]?.traceId ?? String(index);
    const current = componentTraceIds.get(root);
    if (!current || traceId.localeCompare(current) < 0) componentTraceIds.set(root, traceId);
  }
  const orderedRoots = Array.from(componentTraceIds.entries())
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([root]) => root);
  const clusterByRoot = new Map(orderedRoots.map((root, index) => [root, index] as const));
  return points.map((_, index) => clusterByRoot.get(sets.find(index)) ?? 0);
}

function normalizeProjectionCoordinates(points: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return points.map((point) => ({
    x: (point.x - minX) / spanX,
    y: (point.y - minY) / spanY,
  }));
}

export function buildProjectionFromRows(input: {
  rows: RagSummaryEmbeddingRow[];
  sourceCount: number;
  model: string;
}): RagProjectionResponse {
  const warnings: string[] = [];
  const dimension = input.rows[0]?.dimension ?? null;
  const rows = input.rows
    .filter((row) => row.dimension === dimension)
    .map((row) => ({
      ...row,
      vectorValues: Array.from(bufferToVector(row.vector)),
    }));
  const missingEmbeddingCount = Math.max(0, input.sourceCount - input.rows.length);
  if (missingEmbeddingCount > 0) warnings.push(`${missingEmbeddingCount} filtered summaries are missing summary embeddings`);
  if (rows.length !== input.rows.length) warnings.push("some embeddings were skipped because dimensions did not match");
  if (rows.length < 2) {
    warnings.push("at least two summary embeddings are required for projection");
    return {
      items: [],
      model: input.model,
      dimension,
      sourceCount: input.sourceCount,
      embeddedCount: rows.length,
      missingEmbeddingCount,
      warnings,
    };
  }

  const projected = normalizeProjectionCoordinates(projectRows(rows));
  const clusters = assignAdaptiveClusters(rows, projected);
  return {
    items: rows.map((row, index): RagProjectionItem => ({
      traceId: row.traceId,
      sessionId: row.sessionId,
      agent: row.agent,
      path: row.path,
      title: row.title || row.traceId,
      summaryGeneratedAtMs: row.summaryGeneratedAtMs,
      updatedAtMs: row.updatedAtMs,
      lastEventTs: row.lastEventTs,
      mtimeMs: row.mtimeMs,
      summaryAtMs: row.summaryGeneratedAtMs ?? row.updatedAtMs,
      originalTraceAtMs: row.lastEventTs ?? row.mtimeMs,
      x: projected[index]?.x ?? 0,
      y: projected[index]?.y ?? 0,
      clusterId: clusters[index] ?? 0,
    })),
    model: input.model,
    dimension,
    sourceCount: input.sourceCount,
    embeddedCount: rows.length,
    missingEmbeddingCount,
    warnings,
  };
}

export async function getRagProjection(
  config: AppConfig,
  options: { status?: RagRefreshStatus; agent?: AgentKind; limit?: number } = {},
): Promise<RagProjectionResponse> {
  if (!existsSync(dbPathFromConfig(config))) {
    return {
      items: [],
      model: config.rag.embeddingModel,
      dimension: null,
      sourceCount: 0,
      embeddedCount: 0,
      missingEmbeddingCount: 0,
      warnings: ["RAG database does not exist"],
    };
  }
  const store = new RagStore(config);
  try {
    const model = store.getMeta("embedding_model") || config.rag.embeddingModel;
    const projectionInput = store.listSummaryEmbeddings({
      ...(options.status ? { status: options.status } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      model,
    });
    return buildProjectionFromRows({
      rows: projectionInput.rows,
      sourceCount: projectionInput.total,
      model,
    });
  } finally {
    store.close();
  }
}
