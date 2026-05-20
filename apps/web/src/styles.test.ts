/* @vitest-environment node */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
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

function renderResponsiveInspector(widthPx: number) {
  const window = new Window({ width: widthPx, height: 720 });
  window.document.head.innerHTML = `<style>${styles}</style>`;
  window.document.body.innerHTML = `
    <div class="grid">
      <section class="panel list-panel"></section>
      <section class="panel toc-panel"></section>
      <section class="panel detail-panel">
        <section class="detail-summary-cards">
          <article class="detail-summary-card"></article>
          <article class="detail-summary-card"></article>
          <article class="detail-summary-card"></article>
        </section>
        <div class="events-scroll">
          <article class="event-card">
            <div class="event-top mono">
              <span class="kind kind-tool_use">tool_use</span>
            </div>
            <h3>verylongeventpreviewwithoutnaturalbreakpoints</h3>
          </article>
        </div>
      </section>
    </div>
  `;

  return window.document;
}

function computedStyle(document: ReturnType<typeof renderResponsiveInspector>) {
  return (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing rendered element for selector ${selector}`);
    const view = document.defaultView;
    if (!view) throw new Error(`Missing defaultView for selector ${selector}`);
    return view.getComputedStyle(element);
  };
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

  it("keeps analysis content inside its own scrollable viewport", () => {
    expect(styles).toMatch(/\.analysis-view\s*{[^}]*grid-row:\s*2\s*\/\s*4;/s);
    expect(styles).toMatch(/\.analysis-view\s*{[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.analysis-view\s*{[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/\.analysis-dashboard-grid\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.45fr\)\s*minmax\(0,\s*0\.9fr\);/s);
  });

  it("renders the responsive inspector breakpoints with computed viewport styles", () => {
    const narrowDesktop = renderResponsiveInspector(960);
    const narrowDesktopStyle = computedStyle(narrowDesktop);
    expect(narrowDesktopStyle(".toc-panel").display).toBe("none");
    expect(narrowDesktopStyle(".grid").gridTemplateColumns).toBe("minmax(260px, 0.9fr) minmax(0, 1.4fr)");

    const narrowInspector = renderResponsiveInspector(530);
    const narrowInspectorStyle = computedStyle(narrowInspector);
    expect(narrowInspectorStyle(".detail-summary-cards").gridTemplateColumns).toBe("1fr");
    expect(narrowInspectorStyle(".event-card h3").overflowWrap).toBe("anywhere");

    const phone = renderResponsiveInspector(520);
    const phoneStyle = computedStyle(phone);
    expect(phoneStyle(".grid").gridTemplateColumns).toBe("1fr");
  });
});
