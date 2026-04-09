import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  fetchPricingCatalog,
  renderGeneratedPricingFile,
} from "../packages/core/src/pricingSync.ts";

const OUTPUT_PATH = path.resolve("packages/core/src/generatedPricing.ts");

async function main(): Promise<void> {
  const catalog = await fetchPricingCatalog();
  const generated = renderGeneratedPricingFile(catalog);
  await writeFile(OUTPUT_PATH, generated, "utf8");
  process.stdout.write(
    `Wrote ${OUTPUT_PATH} (${catalog.modelRates.length} rates, ${catalog.contextWindows.length} context windows)\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
