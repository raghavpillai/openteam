import { describe, expect, test } from "bun:test";
import { renderSetupSession } from "../src/ui";

const stages = [
  { label: "Access", description: "Choose access." },
  { label: "Owner", description: "Create owner." },
  { label: "Launch", description: "Start services." },
] as const;

describe("setup session frame", () => {
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

});
