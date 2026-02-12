import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const webDistPath = path.resolve(serverRoot, "../web/dist");
const serverWebDistPath = path.resolve(serverRoot, "dist/web");

if (!existsSync(webDistPath)) {
  console.error(`[agentlens/server] Missing web build at ${webDistPath}`);
  console.error(`[agentlens/server] Run: npm -w apps/web run build`);
  process.exit(1);
}

await rm(serverWebDistPath, { recursive: true, force: true });
await cp(webDistPath, serverWebDistPath, { recursive: true });
