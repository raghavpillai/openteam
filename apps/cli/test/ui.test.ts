import { describe, expect, test } from "bun:test";
import { clampViewport, renderSetupSession, type SessionRow } from "../src/ui";

const stages = [
  { label: "Access", description: "Choose access." },
  { label: "Owner", description: "Create owner." },
  { label: "Launch", description: "Start services." },
] as const;

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

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
  });

  test("keeps a selected row and its wrapped details visible in both scroll directions", () => {
    const lines = Array.from({ length: 30 }, (_value, index) => `line ${index}`);
    const down = clampViewport(lines, 15, 12, 0, false, 20);
    expect(down.lines).toContain("line 15");
    expect(down.lines).toContain("line 20");
    const up = clampViewport(lines, 8, 12, down.offset, false, 12);
    expect(up.lines).toContain("line 8");
    expect(up.lines).toContain("line 12");
    const oversized = clampViewport(lines, 8, 5, down.offset, false, 20);
    expect(oversized.lines).toContain("line 8");
    expect(oversized.lines).toHaveLength(5);
  });
});
