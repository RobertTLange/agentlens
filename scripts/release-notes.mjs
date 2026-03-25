import { readFileSync } from "node:fs";

function usage() {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}

const version = process.argv[2]?.trim();
if (!version) usage();

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split(/\r?\n/);
const heading = `## [${version}]`;
const startIndex = lines.findIndex((line) => line.startsWith(heading));
if (startIndex < 0) {
  console.error(`Version ${version} not found in CHANGELOG.md`);
  process.exit(1);
}

let endIndex = lines.length;
for (let index = startIndex + 1; index < lines.length; index += 1) {
  if (lines[index]?.startsWith("## [")) {
    endIndex = index;
    break;
  }
}

const body = lines
  .slice(startIndex + 1, endIndex)
  .join("\n")
  .trim();

if (!body) {
  console.error(`Version ${version} has no release notes body in CHANGELOG.md`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
