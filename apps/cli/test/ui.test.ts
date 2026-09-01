import { describe, expect, test } from "bun:test";
import { createSetupPresentation, renderSetupHeader } from "../src/ui";

const stages = [
  { label: "Access", description: "Choose access." },
  { label: "Owner", description: "Create owner." },
  { label: "Launch", description: "Start services." },
] as const;

describe("setup presentation", () => {
  test("renders completed, active, and pending stages without terminal escape codes", () => {
    const header = renderSetupHeader({
      version: "1.2.3",
      stages,
      activeStage: 1,
      color: false,
      width: 72,
    });
    expect(header).toContain("OPENBOT SETUP · v1.2.3");
    expect(header).toContain("✓ Access");
    expect(header).toContain("● Owner");
    expect(header).toContain("○ Launch");
    expect(header).not.toContain("\u001b[");
  });

  test("prints a scannable final summary", () => {
    const output: string[] = [];
    const presentation = createSetupPresentation({
      version: "1.2.3",
      stages,
      color: false,
      write: (value) => output.push(value),
    });
    presentation.start();
    presentation.stage(2);
    presentation.summary("OpenBot is ready", [
      { label: "Server", value: "https://bot.example.com" },
      { label: "Manage", value: "openbot status" },
    ]);
    expect(output.join("\n")).toContain("✓ OpenBot is ready");
    expect(output.join("\n")).toContain("https://bot.example.com");
  });

  test("uses a compact progress bar in narrow SSH terminals", () => {
    const header = renderSetupHeader({
      version: "1.2.3",
      stages,
      activeStage: 1,
      color: false,
      width: 40,
    });
    expect(header).toContain("2/3 Owner");
    expect(header.split("\n").every((line) => line.length <= 40)).toBe(true);
  });
});
