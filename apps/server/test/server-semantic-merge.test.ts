import { describe, expect, test } from "bun:test";

const source = async (name: "app-service.ts" | "event-stream.ts" | "main.ts") =>
  Bun.file(new URL(`../src/${name}`, import.meta.url)).text();

describe("server semantic merge guard", () => {
  test("retains upstream service wiring alongside the bounded client surfaces", async () => {
    const app = await source("app-service.ts");

    for (const capability of [
      "setTimelineEventSink",
      "appendAgentTimelineEvent",
      "plugins.syncFileCaches",
      "new AutoReviewService",
      "plugins.resolveInvocation",
      "plugins.resolveAction",
      "listGroupRoutines",
      "createGroupRoutine",
      "loadRootSettingsForClient",
      "renderSubagentRevivalPrompt",
      'origin: "background_revival"',
      "clientBootstrap",
      "channelHistory",
      "channelMessageContext",
      "channelClientState",
      "uploadBinaryAsset",
      "eventWindowAfter",
    ]) {
      expect(app).toContain(capability);
    }
  });

  test("retains protected internal, plugin, group, notification, and asset routes", async () => {
    const main = await source("main.ts");

    for (const route of [
      "/api/internal/tools/call",
      "/api/internal/permissions/auto-review",
      "/api/internal/broadcast",
      "/api/plugin-oauth/callback",
      "/api/plugin-connections/status",
      "/api/notification-devices",
      "/api/client-bootstrap",
      "/api/client-runtime",
    ]) {
      expect(main).toContain(route);
    }
    for (const routePattern of [
      "plugin-connections\\/([^/]+)\\/configure",
      "plugin-connections\\/([^/]+)\\/authenticate",
      "plugin-connections\\/([^/]+)\\/restart",
      "plugin-connections\\/([^/]+)\\/instructions",
      "plugin-connections\\/([^/]+)\\/account",
      "plugins\\/([^/]+)\\/bot-access",
      "channels\\/([^/]+)\\/routines",
      "channels\\/([^/]+)\\/profile",
      "channels\\/([^/]+)\\/avatar",
      "channels\\/([^/]+)\\/read",
    ]) {
      expect(main).toContain(routePattern);
    }
    expect(main).toContain("assetUploadByteLimit");
    expect(main).toContain("requireAssetBody");
    expect(main).toContain("publicAssetMatch");
  });

  test("keeps auth minimal and makes malformed or future SSE cursors recoverable", async () => {
    const main = await source("main.ts");
    const eventStream = await source("event-stream.ts");

    expect(main).toContain('authMode === "required" && !publicCallback');
    expect(main).not.toContain("OPENTEAM_API_TOKEN");
    expect(main).not.toContain("authorizedApi");
    expect(main).toContain('throw new ApiError(400, "invalid_cursor"');
    expect(main).toContain("eventStream(app, cursor, request.signal)");
    expect(eventStream).toContain("window.cursorExpired || window.cursorAhead");
    expect(eventStream).toContain('window.cursorExpired ? "cursor_expired" : "cursor_ahead"');
    expect(eventStream).toContain("const replacementCursor = window.latest ?? 0n");
    expect(eventStream).toContain("SSE_EVENT_BATCH_SIZE = 64");
  });
});
