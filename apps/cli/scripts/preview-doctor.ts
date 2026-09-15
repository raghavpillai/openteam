import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderCompactDoctor, renderDoctor } from "../src/doctor-ui";
import { doctorScenarios } from "../test/fixtures/doctor-scenarios";
import { writeDoctorGallery } from "./doctor-gallery";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};

if (args.includes("--list")) {
  for (const scenario of doctorScenarios)
    console.log(`${scenario.id.padEnd(28)} ${scenario.title}`);
} else {
  const gallery = option("--gallery");
  const id = option("--scenario") ?? (gallery ? "all" : "docker-missing");
  const selected = id === "all" ? doctorScenarios : doctorScenarios.filter((s) => s.id === id);
  if (!selected.length)
    throw new Error(`Unknown scenario: ${id}. Run with --list to see available scenarios.`);
  if (gallery) {
    console.log(writeDoctorGallery(gallery, selected));
    process.exit(0);
  }
  const width = Number(option("--width") ?? process.stdout.columns ?? 90);
  if (!Number.isFinite(width) || width < 24)
    throw new Error("--width must be a number of at least 24 columns");
  const compact = args.includes("--compact");
  const render = compact ? renderCompactDoctor : renderDoctor;
  const color =
    !args.includes("--no-color") && (args.includes("--color") || Boolean(process.stdout.isTTY));
  const outputDirectory = option("--output");
  if (outputDirectory) mkdirSync(resolve(outputDirectory), { recursive: true });
  for (const scenario of selected) {
    const output = render(scenario.result, { width, color });
    if (outputDirectory) {
      const filename = `${scenario.id}-${compact ? "compact" : "full"}-${width}.${color ? "ansi" : "txt"}`;
      writeFileSync(resolve(outputDirectory, filename), output + "\n");
    } else {
      if (selected.length > 1) console.log(`\n${scenario.id}: ${scenario.title}`);
      console.log(output);
    }
  }
  if (outputDirectory)
    console.log(
      `Wrote ${selected.length} simulated doctor reports to ${resolve(outputDirectory)}.`
    );
}
