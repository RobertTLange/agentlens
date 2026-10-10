import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(cliRoot, ".bundle-manifest.json");
const backupPath = path.join(cliRoot, ".bundle-node_modules");

if (!existsSync(manifestPath) && !existsSync(backupPath)) {
  process.exit(0);
}

const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : [];
if (Array.isArray(manifest)) {
  for (const relPath of manifest) {
    if (typeof relPath !== "string" || relPath.length === 0) continue;
    await rm(path.join(cliRoot, relPath), { recursive: true, force: true });
  }
}

await rm(manifestPath, { force: true });
if (existsSync(backupPath)) {
  await rm(path.join(cliRoot, "node_modules"), { recursive: true, force: true });
  await rename(backupPath, path.join(cliRoot, "node_modules"));
}
