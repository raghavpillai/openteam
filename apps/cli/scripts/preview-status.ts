import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectStatus } from "../src/status";
import { renderStatus } from "../src/status-ui";
import {
  normalizeStatusPreview,
  statusFixture,
  statusScenarios,
} from "../test/fixtures/status-scenarios";
import {
  galleryWidths,
  writeTerminalGallery,
  type TerminalGalleryScenario,
} from "./terminal-gallery";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
if (args.includes("--list")) {
  for (const [id, title] of statusScenarios) console.log(`${id.padEnd(24)} ${title}`);
} else {
  const gallery = option("--gallery");
  const id = option("--scenario") ?? (gallery ? "all" : "healthy");
  const scenarios = statusScenarios.filter((s) => id === "all" || id === s[0]);
  if (!scenarios.length)
    throw new Error(`Unknown scenario: ${id}. Run with --list to see available scenarios.`);
  const width = Number(option("--width") ?? process.stdout.columns ?? 90);
  if (!Number.isFinite(width) || width < 24) throw new Error("--width must be at least 24 columns");
  const color =
    !args.includes("--no-color") && (args.includes("--color") || Boolean(process.stdout.isTTY));
  const output = option("--output");
  if (output) mkdirSync(resolve(output), { recursive: true });
  const data: TerminalGalleryScenario[] = [];
  for (const [id, title] of scenarios) {
    const fixture = statusFixture(id);
    try {
      const report = await collectStatus(fixture.paths, fixture.runner);
      const normalized = normalizeStatusPreview(report, fixture);
      if (gallery)
        data.push({
          id,
          title,
          reports: Object.fromEntries(
            galleryWidths.map((width) => [
              width,
              { full: renderStatus(normalized, { width, color: true }) },
            ])
          ),
        });
      else {
        const rendered = renderStatus(normalized, { width, color });
        if (output)
          writeFileSync(
            resolve(output, `${id}-${width}.${color ? "ansi" : "txt"}`),
            rendered + "\n"
          );
        else console.log(rendered);
      }
    } finally {
      fixture.cleanup();
    }
  }
  if (gallery) console.log(writeTerminalGallery(gallery, data, "status"));
  if (output)
    console.log(`Wrote ${scenarios.length} simulated status reports to ${resolve(output)}.`);
}
