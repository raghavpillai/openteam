import { describe, expect, test } from "bun:test";
import {
  clampViewport,
  createSetupPresentation,
  renderSelectionPrompt,
  renderSelectionResult,
  renderSetupHeader,
  renderSetupSession,
  type SessionRow,
} from "../src/ui";

const stages = [
  { label: "Access", description: "Choose access." },
  { label: "Owner", description: "Create owner." },
  { label: "Launch", description: "Start services." },
] as const;

const accessOptions = [
  { label: "Public HTTPS" },
  { label: "Existing HTTPS proxy" },
  { label: "Public HTTP" },
  { label: "Private network" },
  { label: "This machine only" },
];

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

describe("setup presentation", () => {
  test("renders a vertical selection list with the highlighted option and a clean settled result", () => {
    const prompt = renderSelectionPrompt({
      message: "Access mode",
      options: accessOptions,
      index: 1,
      color: false,
      width: 72,
    });

    expect(prompt).toEqual([
      "? Access mode",
      "    Public HTTPS",
      "  ❯ Existing HTTPS proxy",
      "    Public HTTP",
      "    Private network",
      "    This machine only",
      "  ↑/↓ move · Enter select",
    ]);
    expect(renderSelectionResult("Access mode", "Existing HTTPS proxy", false, 72)).toBe(
      "✓ Access mode  Existing HTTPS proxy"
    );
  });

  test("keeps interactive selections inside narrow terminals", () => {
    const prompt = renderSelectionPrompt({
      message: "Choose an intentionally long setting",
      options: [{ label: "An intentionally long selection label" }, { label: "Short" }],
      index: 0,
      color: false,
      width: 24,
    });

    expect(prompt).toEqual([
      "? Choose an intentional…",
      "  ❯ An intentionally lo…",
      "    Short",
      "  arrows · Enter",
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
      options: accessOptions,
      index: 1,
      color: true,
      width: 32,
    });

    expect(prompt[0]).toContain("\u001b[36m?\u001b[0m");
    expect(prompt[2]).toContain("\u001b[1mExisting HTTPS proxy\u001b[0m");
    expect(prompt.every((line) => stripAnsi(line).length <= 32)).toBe(true);
  });

  test("uses the standard width when a PTY reports zero columns", () => {
    const prompt = renderSelectionPrompt({
      message: "Access mode",
      options: accessOptions,
      index: 0,
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

    expect(prompt.every((line) => line.length <= 78)).toBe(true);
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
    expect(header).toContain("OPENTEAM SETUP · v1.2.3");
    expect(header).toContain("✓ Access");
    expect(header).toContain("● Owner");
    expect(header).toContain("○ Launch");
    expect(header).not.toContain("\u001b[");
  });

  test("lets a session mark stages complete independently of their order", () => {
    const header = renderSetupHeader({
      version: "1.2.3",
      stages,
      activeStage: 0,
      completed: [false, true, false],
      color: false,
      width: 72,
    });
    expect(header).toContain("● Access");
    expect(header).toContain("✓ Owner");
    expect(header).toContain("○ Launch");
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
    presentation.summary("OpenTeam is ready", [
      { label: "Server", value: "https://bot.example.com" },
      { label: "Manage", value: "openteam status" },
    ]);
    expect(output.join("\n")).toContain("✓ OpenTeam is ready");
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
      { label: "Address", value: "https://an-intentionally-long-openteam-host.example.com" },
    ]);

    expect(output.join("\n")).toContain("     cloud load balancer you already");
    expect(output.flatMap((value) => value.split("\n")).every((line) => line.length <= 40)).toBe(
      true
    );
  });
});

describe("setup session frame", () => {
  const rows: SessionRow[] = [
    { kind: "heading", text: "Access mode" },
    {
      kind: "option",
      id: "access:https",
      label: "Public HTTPS",
      description: "A domain plus automatic TLS.",
      selected: true,
      recommended: true,
    },
    {
      kind: "option",
      id: "access:local",
      label: "This machine only",
      description: "Loopback access.",
      selected: false,
    },
    { kind: "heading", text: "Address" },
    { kind: "text", id: "host", label: "Public domain", value: "", placeholder: "bot.example.com" },
    { kind: "toggle", id: "httpAck", label: "I understand the risk", checked: false },
    { kind: "cycle", id: "thinking", label: "Reasoning effort", value: "high" },
    { kind: "note", text: "Caddy obtains the certificate.", tone: "info" },
    { kind: "action", id: "apply", label: "Apply and start OpenTeam", primary: true },
  ];

  test("draws the section tabs, highlighted row, markers, and key hints", () => {
    const frame = renderSetupSession({
      version: "1.2.3",
      stages,
      activeStage: 0,
      completed: [false, true, false],
      title: "1. Access",
      description: "Choose access.",
      rows,
      cursorRow: 4,
      mode: "navigate",
      notice: null,
      color: false,
      width: 72,
    });

    expect(frame.header.join("\n")).toContain("● Access  ─  ✓ Owner  ─  ○ Launch");
    expect(frame.body[0]).toBe("1. Access");
    expect(frame.body).toContain("  Access mode");
    expect(frame.body).toContain("    ● Public HTTPS  recommended");
    expect(frame.body).not.toContain("      A domain plus automatic TLS.");
    expect(frame.body).toContain("    ○ This machine only");
    expect(frame.body).toContain("  ❯ Public domain     bot.example.com");
    expect(frame.body).toContain("    [ ] I understand the risk");
    expect(frame.body).toContain("    Reasoning effort  ‹ high ›");
    expect(frame.body).toContain("  • Caddy obtains the certificate.");
    expect(frame.body).toContain("    Apply and start OpenTeam");
    expect(frame.body[frame.cursorLine]).toBe("  ❯ Public domain     bot.example.com");
    expect(frame.footer.at(-1)).toBe(
      "  Type to enter · Enter edit · ↑/↓ move · ←/→ step · Esc cancel"
    );
    const lines = [...frame.header, ...frame.body, ...frame.footer];
    expect(lines.every((line) => line.length <= 72)).toBe(true);
  });

  test("shows the edit buffer, masked secrets, validation errors, and notices", () => {
    const frame = renderSetupSession({
      version: "1.2.3",
      stages,
      activeStage: 1,
      completed: [true, false, false],
      title: "2. Owner",
      description: "Create owner.",
      rows: [
        { kind: "text", id: "username", label: "Username", value: "openteam" },
        {
          kind: "text",
          id: "password",
          label: "Password",
          value: "",
          secret: true,
          editing: {
            buffer: "secret",
            error: "Passwords do not match. Try again.",
            label: "Confirm password",
          },
        },
        { kind: "text", id: "apiKey", label: "API key", value: "hidden-secret", secret: true },
      ],
      cursorRow: 1,
      mode: "edit",
      notice: { text: "Set the owner password in Owner.", tone: "warning" },
      color: false,
      width: 72,
    });

    const body = frame.body.join("\n");
    expect(body).toContain("  ❯ Confirm password  ••••••");
    expect(body).not.toContain("secret");
    expect(body).toContain("    ! Passwords do not match. Try again.");
    expect(body).toContain("    API key           ••••••••");
    expect(body).not.toContain("hidden-secret");
    expect(frame.footer.join("\n")).toContain("  ! Set the owner password in Owner.");
    expect(frame.footer.at(-1)).toBe("  Type to edit · Enter save · Esc discard");
  });

  test("keeps every session line inside a narrow terminal", () => {
    const frame = renderSetupSession({
      version: "1.2.3",
      stages,
      activeStage: 0,
      completed: [false, false, false],
      title: "1. Access",
      description: "Choose how desktop and mobile apps reach this server.",
      rows,
      cursorRow: 1,
      mode: "navigate",
      notice: { text: "Public domain is required in Access.", tone: "warning" },
      color: true,
      width: 40,
    });
    const lines = [...frame.header, ...frame.body, ...frame.footer];
    expect(lines.every((line) => stripAnsi(line).length <= 40)).toBe(true);
    expect(stripAnsi(frame.footer.at(-1) ?? "")).toBe("  ↑↓ move · Enter · ←→ · Esc cancel");
  });

  test("scrolls the body to keep the highlighted line visible", () => {
    const lines = Array.from({ length: 30 }, (_value, index) => `line ${index}`);

    expect(clampViewport(lines, 5, 40)).toEqual({ lines, offset: 0 });

    const top = clampViewport(lines, 2, 12);
    expect(top.offset).toBe(0);
    expect(top.lines).toHaveLength(12);
    expect(top.lines[0]).toBe("");
    expect(top.lines[1]).toBe("line 0");
    expect(top.lines.at(-1)).toBe("  ↓ 20 more");

    const middle = clampViewport(lines, 20, 12, top.offset);
    expect(middle.offset).toBe(11);
    expect(middle.lines[0]).toBe("  ↑ 11 more");
    expect(middle.lines).toContain("line 20");
    expect(middle.lines.at(-1)).toBe("  ↓ 9 more");

    const back = clampViewport(lines, 8, 12, middle.offset);
    expect(back.offset).toBe(8);
    expect(back.lines[1]).toBe("line 8");
  });
});
