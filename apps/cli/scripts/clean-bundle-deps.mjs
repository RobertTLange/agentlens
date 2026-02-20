import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(cliRoot, ".bundle-manifest.json");

if (!existsSync(manifestPath)) {
  process.exit(0);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (Array.isArray(manifest)) {
  for (const relPath of manifest) {
    if (typeof relPath !== "string" || relPath.length === 0) continue;
    await rm(path.join(cliRoot, relPath), { recursive: true, force: true });
  }
}

await rm(manifestPath, { force: true });
