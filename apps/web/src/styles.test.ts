/* @vitest-environment node */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

function mediaBlock(maxWidthPx: number): string {
  const marker = `@media (max-width: ${maxWidthPx}px)`;
  const start = styles.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const blockStart = styles.indexOf("{", start);
  expect(blockStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = blockStart; index < styles.length; index += 1) {
    const char = styles[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return styles.slice(blockStart + 1, index);
  }

  throw new Error(`Unclosed media block for max-width ${maxWidthPx}px`);
}

describe("responsive inspector layout styles", () => {
  it("hides the timeline toc and keeps a two-pane inspector layout at narrow desktop widths", () => {
    const block = mediaBlock(960);

    expect(block).toMatch(/\.toc-panel\s*{[^}]*display:\s*none;/s);
    expect(block).toMatch(/\.grid\s*{[^}]*grid-template-columns:\s*minmax\(260px,\s*0\.9fr\)\s*minmax\(0,\s*1\.4fr\);/s);
    expect(block).toMatch(/\.grid\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s);
  });

  it("stacks the primary inspector panes only at phone widths", () => {
    const block = mediaBlock(520);

    expect(block).toMatch(/\.grid\s*{[^}]*grid-template-columns:\s*1fr;/s);
    expect(block).toMatch(/\.grid\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*0\.62fr\)\s*minmax\(0,\s*1\.38fr\);/s);
  });

  it("allows trace inspector event text to shrink and wrap inside narrow cards", () => {
    expect(styles).toMatch(/\.event-card\s*{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.event-card\s*{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.event-card h3\s*{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.event-top\s*{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.subtle\s*{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.event-card \.kind,\s*\.event-card \.event-agent-badge\s*{[^}]*white-space:\s*normal;/s);
  });
});
