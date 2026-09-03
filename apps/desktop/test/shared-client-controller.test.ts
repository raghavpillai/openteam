import { describe, expect, test } from "bun:test";

const source = (path: string) =>
  Bun.file(new URL(`../src/renderer/${path}`, import.meta.url)).text();

describe("desktop shared client controllers", () => {
  test("polls a normal screen without acquiring exclusive graphical control", async () => {
    const screen = await source("components/openteam/bot-screen.tsx");

    expect(screen).toContain("SCREEN_STATUS_POLL_MS");
    expect(screen).toContain("shouldPollScreenStatus");
    expect(screen).toContain("window.setInterval(pollStatus, SCREEN_STATUS_POLL_MS)");
    expect(screen).not.toContain("createScreenSessionController");
    expect(screen).toContain("if (!handoff || !open) return;");
    expect(screen).toContain(".screenTakeover(bot.id, true)");
    expect(screen).not.toContain("api.releaseScreenTakeover");
  });

  test("uses live local noVNC with authenticated frame and input fallback", async () => {
    const screen = await source("components/openteam/bot-screen.tsx");

    expect(screen).toContain("api.screenFrameUrl");
    expect(screen).toContain("api.screenAction");
    expect(screen).toContain("<iframe");
    expect(screen).toContain("resolveViewerUrl");
    expect(screen).toContain('resolved.searchParams.set("view_only", "false")');
    expect(screen).toContain('source.hostname === "127.0.0.1"');
  });

  test("keeps human input active alongside agent input", async () => {
    const screen = await source("components/openteam/bot-screen.tsx");

    expect(screen).toContain('role="application"');
    expect(screen).toContain('className="absolute inset-0 size-full cursor-crosshair');
    expect(screen).not.toContain("takeoverRef");
    expect(screen).not.toContain("Take control");
    expect(screen).not.toContain("Return to agent");
  });

  test("uses exclusive input only for an explicit agent-requested handoff", async () => {
    const screen = await source("components/openteam/bot-screen.tsx");
    const richMessage = await source("components/openteam/rich-message.tsx");

    expect(richMessage).toContain('api.mutateComputerHandoff(message.id, "start")');
    expect(richMessage).toContain("Take over the computer");
    expect(screen).toContain("Skip this step");
    expect(screen).toContain("I'm done, continue");
    expect(screen).toContain('finishHandoff("dismiss")');
    expect(screen).toContain("api.releaseComputerHandoff(handoff.messageId)");
    expect(screen).toContain("window.clearTimeout(handoffReleaseTimer.current)");
    expect(screen).toContain("window.setTimeout(() => {");
    expect(screen).toContain('window.addEventListener("pagehide", releaseHandoff)');
  });
});
