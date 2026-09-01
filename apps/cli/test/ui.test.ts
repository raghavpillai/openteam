import { describe, expect, test } from "bun:test";
import {
  createSetupPresentation,
  renderSelectionPrompt,
  renderSelectionResult,
  renderSetupHeader,
} from "../src/ui";

const stages = [
  { label: "Access", description: "Choose access." },
  { label: "Owner", description: "Create owner." },
  { label: "Launch", description: "Start services." },
] as const;

describe("setup presentation", () => {
  test("renders a restrained interactive selection and a clean settled result", () => {
    const prompt = renderSelectionPrompt({
      message: "Access mode",
      label: "Existing HTTPS proxy",
      index: 1,
      count: 5,
      color: false,
      width: 72,
    });

    expect(prompt).toEqual([
      "? Access mode",
      "  › Existing HTTPS proxy                                             2/5",
      "  ↑/↓/←/→ move · Enter select",
    ]);
    expect(renderSelectionResult("Access mode", "Existing HTTPS proxy", false, 72)).toBe(
      "✓ Access mode  Existing HTTPS proxy"
    );
  });

  test("keeps interactive selections inside narrow terminals", () => {
    const prompt = renderSelectionPrompt({
      message: "Choose an intentionally long setting",
      label: "An intentionally long selection label",
      index: 2,
      count: 5,
      color: false,
      width: 24,
    });

    expect(prompt).toEqual([
      "? Choose an intentional…",
      "  › An intentionall… 3/5",
      "  arrows move · Enter",
    ]);
    expect(prompt.every((line) => line.length <= 24)).toBe(true);
    expect(renderSelectionResult("Deployment exposure", "This machine only", false, 24)).toBe(
      "✓ Deploymen…  This mach…"
    );
    expect(renderSelectionResult("Deployment exposure", "This machine only", false, 16)).toBe(
      "✓ Depl…  This m…"
    );
  });

  test("keeps ANSI styling out of width calculations", () => {
    const prompt = renderSelectionPrompt({
      message: "Access mode",
      label: "Existing HTTPS proxy",
      index: 1,
      count: 5,
      color: true,
      width: 32,
    });
    const stripAnsi = (value: string) =>
      ["\u001b[36m", "\u001b[1m", "\u001b[2m", "\u001b[0m"].reduce(
        (plain, sequence) => plain.replaceAll(sequence, ""),
        value
      );

    expect(prompt[0]).toContain("\u001b[36m?\u001b[0m");
    expect(prompt[1]).toContain("\u001b[1mExisting HTTPS proxy\u001b[0m");
    expect(prompt.every((line) => stripAnsi(line).length <= 32)).toBe(true);
  });

  test("uses the standard width when a PTY reports zero columns", () => {
    const prompt = renderSelectionPrompt({
      message: "Access mode",
      label: "Public HTTPS",
      index: 0,
      count: 5,
      color: false,
      width: 0,
    });
    const header = renderSetupHeader({
      version: "1.2.3",
      stages,
      activeStage: 0,
      color: false,
      width: 0,
    });

    expect(prompt[1]?.length).toBe(78);
    expect(header.split("\n").every((line) => line.length <= 78)).toBe(true);
    expect(header).toContain("● Access");
  });

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

  test("wraps all guided content within a narrow SSH terminal", () => {
    const output: string[] = [];
    const presentation = createSetupPresentation({
      version: "1.2.3",
      stages,
      color: false,
      width: 40,
      write: (value) => output.push(value),
    });
    presentation.start();
    presentation.stage(0);
    presentation.choices([
      {
        title: "Existing HTTPS proxy",
        description: "Use nginx, Caddy, Traefik, or a cloud load balancer you already manage.",
      },
    ]);
    presentation.message(
      "The proxy must replace inbound forwarding headers with values from its own connection.",
      "warning"
    );
    presentation.summary("Configuration ready", [
      { label: "Address", value: "https://an-intentionally-long-openbot-host.example.com" },
    ]);

    expect(output.join("\n")).toContain("     cloud load balancer you already");
    expect(output.flatMap((value) => value.split("\n")).every((line) => line.length <= 40)).toBe(
      true
    );
  });
});
