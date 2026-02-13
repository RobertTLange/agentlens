import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "@agentlens/contracts";
import { DEFAULT_CONFIG_PATH, mergeConfig, saveConfig, TraceIndex } from "@agentlens/core";

export interface CreateServerOptions {
  traceIndex: TraceIndex;
  configPath?: string;
  webDistPath?: string;
  enableStatic?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      out[key] = deepMergeConfig(baseValue, value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function resolveDefaultWebDistPath(packagedWebDistPath: string, monorepoWebDistPath: string): string {
  if (existsSync(monorepoWebDistPath)) {
    return monorepoWebDistPath;
  }
  if (existsSync(packagedWebDistPath)) {
    return packagedWebDistPath;
  }
  return monorepoWebDistPath;
}

export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  const traceIndex = options.traceIndex;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const packagedWebDistPath = fileURLToPath(new URL("./web", import.meta.url));
  const monorepoWebDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const defaultWebDistPath = resolveDefaultWebDistPath(packagedWebDistPath, monorepoWebDistPath);
  const webDistPath = options.webDistPath ?? defaultWebDistPath;

  if ((options.enableStatic ?? true) && existsSync(webDistPath)) {
    await server.register(fastifyStatic, {
      root: webDistPath,
      prefix: "/",
    });
  }

  server.get("/api/healthz", async () => ({ ok: true }));

  server.get("/api/overview", async () => ({ overview: traceIndex.getOverview() }));

  server.get("/api/traces", async (request) => {
    const query = request.query as { agent?: string };
    const agent = query.agent?.trim().toLowerCase();
    const traces = traceIndex
      .getSummaries()
      .filter((summary) => (agent ? summary.agent === agent : true));
    return { traces };
  });

  server.get("/api/trace/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { limit?: string; before?: string; include_meta?: string };

    try {
      const resolvedId = traceIndex.resolveId(params.id);
      const pageOptions: { limit?: number; before?: string; includeMeta?: boolean } = {};
      if (query.include_meta !== undefined) {
        pageOptions.includeMeta = query.include_meta === "1" || query.include_meta === "true";
      }
      if (query.limit) {
        pageOptions.limit = Number(query.limit);
      }
      if (query.before) {
        pageOptions.before = query.before;
      }
      const page = traceIndex.getTracePage(resolvedId, pageOptions);
      return page;
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.get("/api/config", async () => ({ config: traceIndex.getConfig() }));

  server.post("/api/config", async (request) => {
    const body = request.body as Partial<AppConfig>;
    const mergedInput = deepMergeConfig(
      traceIndex.getConfig() as unknown as Record<string, unknown>,
      (body ?? {}) as Record<string, unknown>,
    ) as Partial<AppConfig>;
    const merged = mergeConfig(mergedInput);
    await saveConfig(merged, configPath);
    traceIndex.setConfig(merged);
    await traceIndex.refresh();
    return { config: merged };
  });

  server.get("/api/stream", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    reply.raw.write(
      `event: snapshot\ndata: ${JSON.stringify({
        id: "0",
        type: "snapshot",
        version: 0,
        payload: {
          traces: traceIndex.getSummaries(),
          overview: traceIndex.getOverview(),
        },
      })}\n\n`,
    );

    const onStream = ({ envelope }: { envelope: Record<string, unknown> }) => {
      reply.raw.write(`event: ${String(envelope.type ?? "message")}\ndata: ${JSON.stringify(envelope)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    traceIndex.on("stream", onStream);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      traceIndex.off("stream", onStream);
      reply.raw.end();
    });
  });

  server.get("/", async (_request, reply) => {
    if (!existsSync(webDistPath)) {
      reply.type("text/html");
      return `<!doctype html>
<html><body style="font-family: sans-serif; padding: 2rem;">
<h1>AgentLens server running</h1>
<p>Web app not built yet.</p>
<p>Build once: <code>npm -w apps/web run build</code></p>
<p>Or run dev UI: <code>npm -w apps/web run dev</code> then open <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>.</p>
<p>API: <a href="/api/overview">/api/overview</a></p>
</body></html>`;
    }
    return reply.sendFile("index.html");
  });

  return server;
}

export interface RunServerOptions {
  host?: string;
  port?: number;
  configPath?: string;
  enableStatic?: boolean;
}

export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const host = options.host ?? process.env.AGENTLENS_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.AGENTLENS_PORT ?? "8787");
  const configPath = options.configPath ?? process.env.AGENTLENS_CONFIG ?? DEFAULT_CONFIG_PATH;

  const traceIndex = await TraceIndex.fromConfigPath(configPath);
  await traceIndex.start();

  const createOptions: CreateServerOptions = {
    traceIndex,
    configPath,
  };
  if (options.enableStatic !== undefined) {
    createOptions.enableStatic = options.enableStatic;
  }
  const server = await createServer(createOptions);

  await server.listen({ host, port });

  process.on("SIGINT", async () => {
    traceIndex.stop();
    await server.close();
    process.exit(0);
  });

  // eslint-disable-next-line no-console
  console.log(`AgentLens server: http://${host}:${port}`);
}
