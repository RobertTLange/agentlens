import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cliRoot, "../..");
const cliPackageJsonPath = path.join(cliRoot, "package.json");
const sourceNodeModulesRoot = path.join(repoRoot, "node_modules");
const targetNodeModulesRoot = path.join(cliRoot, "node_modules");
const manifestPath = path.join(cliRoot, ".bundle-manifest.json");

const internalBundleTargets = [
  {
    packageName: "@agentlens/contracts",
    sourceDir: path.join(repoRoot, "packages/contracts"),
    requiredBuildOutputs: ["dist/index.js"],
  },
  {
    packageName: "@agentlens/core",
    sourceDir: path.join(repoRoot, "packages/core"),
    requiredBuildOutputs: ["dist/index.js"],
  },
  {
    packageName: "@agentlens/server",
    sourceDir: path.join(repoRoot, "apps/server"),
    requiredBuildOutputs: ["dist/main.js", "dist/web/index.html"],
  },
];

const optionalPackageFiles = ["README.md", "LICENSE", "LICENSE.md", "LICENSE.txt"];

function splitPackageName(packageName) {
  return packageName.split("/");
}

function packageDir(baseDir, packageName) {
  return path.join(baseDir, ...splitPackageName(packageName));
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function assertExists(filePath, description) {
  if (existsSync(filePath)) return;
  throw new Error(`missing ${description}: ${filePath}`);
}

function assertBuildOutputs(sourceDir, requiredBuildOutputs) {
  const missing = requiredBuildOutputs.filter((relPath) => !existsSync(path.join(sourceDir, relPath)));
  if (missing.length === 0) return;
  throw new Error(`missing build output(s) for ${sourceDir}: ${missing.join(", ")}`);
}

async function removePreviousBundle() {
  if (!existsSync(manifestPath)) return;

  const manifest = await readJson(manifestPath).catch(() => []);
  if (!Array.isArray(manifest)) {
    await rm(manifestPath, { force: true });
    return;
  }

  for (const relPath of manifest) {
    if (typeof relPath !== "string" || relPath.length === 0) continue;
    await rm(path.join(cliRoot, relPath), { recursive: true, force: true });
  }
  await rm(manifestPath, { force: true });
}

async function copyIfExists(sourcePath, targetPath) {
  if (!existsSync(sourcePath)) return;
  await cp(sourcePath, targetPath, { recursive: true, dereference: true });
}

const copiedRelativePaths = new Set();

function markCopied(targetPath) {
  copiedRelativePaths.add(path.relative(cliRoot, targetPath));
}

async function bundleInternalPackage({ packageName, sourceDir, requiredBuildOutputs }) {
  const sourcePackageJson = path.join(sourceDir, "package.json");
  const sourceDist = path.join(sourceDir, "dist");
  const targetDir = packageDir(targetNodeModulesRoot, packageName);

  assertExists(sourcePackageJson, "package.json");
  assertExists(sourceDist, "dist directory");
  assertBuildOutputs(sourceDir, requiredBuildOutputs);

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  markCopied(targetDir);

  await cp(sourcePackageJson, path.join(targetDir, "package.json"), { dereference: true });
  await cp(sourceDist, path.join(targetDir, "dist"), { recursive: true, dereference: true });

  for (const fileName of optionalPackageFiles) {
    await copyIfExists(path.join(sourceDir, fileName), path.join(targetDir, fileName));
  }
}

const externalDependencySeen = new Set();

async function bundleExternalDependencyTree(packageName) {
  if (externalDependencySeen.has(packageName)) return;
  if (packageName.startsWith("@agentlens/")) return;
  externalDependencySeen.add(packageName);

  const sourceDir = packageDir(sourceNodeModulesRoot, packageName);
  const sourcePackageJson = path.join(sourceDir, "package.json");
  const targetDir = packageDir(targetNodeModulesRoot, packageName);

  assertExists(sourcePackageJson, "installed dependency package.json");

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true, dereference: true });
  markCopied(targetDir);

  const packageJson = await readJson(sourcePackageJson);
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];

  for (const dependencyName of dependencyNames) {
    await bundleExternalDependencyTree(dependencyName);
  }
}

await removePreviousBundle();

for (const target of internalBundleTargets) {
  await bundleInternalPackage(target);
}

const cliPackageJson = await readJson(cliPackageJsonPath);
const directDependencies = Object.keys(cliPackageJson.dependencies ?? {}).filter(
  (packageName) => !packageName.startsWith("@agentlens/"),
);

for (const dependencyName of directDependencies) {
  await bundleExternalDependencyTree(dependencyName);
}

await writeFile(
  manifestPath,
  JSON.stringify([...copiedRelativePaths].sort((a, b) => a.localeCompare(b)), null, 2) + "\n",
  "utf8",
);
