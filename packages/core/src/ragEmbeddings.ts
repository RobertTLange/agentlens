import type { AppConfig, RagIndexStatus } from "@agentlens/contracts";
import { expandHome } from "./utils.js";

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class LocalHfEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private extractor: ((text: string, options?: Record<string, unknown>) => Promise<unknown>) | null = null;
  private readonly cacheDir: string;

  constructor(config: AppConfig) {
    this.model = config.rag.embeddingModel;
    this.cacheDir = expandHome(config.rag.modelCacheDir);
  }

  private async load(): Promise<(text: string, options?: Record<string, unknown>) => Promise<unknown>> {
    if (this.extractor) return this.extractor;
    const transformers = await import("@huggingface/transformers");
    const env = (transformers as unknown as { env?: { cacheDir?: string } }).env;
    if (env) {
      env.cacheDir = this.cacheDir;
    }
    const pipeline = (transformers as unknown as { pipeline: (task: string, model: string) => Promise<unknown> }).pipeline;
    this.extractor = (await pipeline("feature-extraction", this.model)) as (text: string, options?: Record<string, unknown>) => Promise<unknown>;
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.load();
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      const output = await extractor(text, { pooling: "mean", normalize: true, truncation: true });
      vectors.push(normalizeVector(extractVector(output)));
    }
    return vectors;
  }
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "agentlens-hash-test";
  constructor(private readonly dimension = 64) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => normalizeVector(hashVector(text, this.dimension)));
  }
}

function extractVector(output: unknown): Float32Array {
  const maybe = output as {
    data?: Float32Array | number[];
    dims?: number[];
    tolist?: () => number[] | number[][];
  };
  if (maybe.data) {
    return new Float32Array(Array.from(maybe.data));
  }
  if (typeof maybe.tolist === "function") {
    const list = maybe.tolist();
    const flat = Array.isArray(list[0]) ? (list as number[][])[0] ?? [] : (list as number[]);
    return new Float32Array(flat);
  }
  if (Array.isArray(output)) {
    return new Float32Array(output as number[]);
  }
  throw new Error("embedding provider returned an unsupported vector shape");
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return vector;
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    out[index] = (vector[index] ?? 0) / norm;
  }
  return out;
}

function hashVector(text: string, dimension: number): Float32Array {
  const vector = new Float32Array(dimension);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}_./:@-]+/gu) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const slot = Math.abs(hash) % dimension;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return vector;
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider | null {
  if (config.rag.embeddingBackend === "disabled") return null;
  if (process.env.AGENTLENS_RAG_FAKE_EMBEDDINGS === "1") {
    return new HashEmbeddingProvider();
  }
  return new LocalHfEmbeddingProvider(config);
}

export function unavailableEmbeddingStatus(config: AppConfig, error: unknown): RagIndexStatus["embeddings"] {
  return {
    status: config.rag.embeddingBackend === "disabled" ? "disabled" : "unavailable",
    model: config.rag.embeddingModel,
    dimension: null,
    count: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}
