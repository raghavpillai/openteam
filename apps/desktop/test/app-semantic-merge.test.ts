import { describe, expect, test } from "bun:test";

const rendererSource = (path: string) =>
  Bun.file(new URL(`../src/renderer/${path}`, import.meta.url)).text();

describe("desktop App semantic merge", () => {
  test("keeps pulled routing and durable state behavior in the performance shell", async () => {
    const [app, actions] = await Promise.all([
      rendererSource("App.tsx"),
      rendererSource("hooks/use-bot-row-actions.ts"),
    ]);

    expect(app).toContain("window.addEventListener(OPENTEAM_DEEP_LINK_EVENT, handleDeepLink)");
    expect(app).toContain("setSettingsTarget({ anchor: target.anchor, nonce: Date.now() })");
    expect(app).toContain("setPluginTarget({ pluginId: target.pluginId, nonce: Date.now() })");
    expect(app).toContain(".markChannelRead(channelId, throughSequence)");
    expect(app).toContain("sidebarPreferences.markUnreadMany(unreadChannelIds)");
    expect(app).toContain("sidebarPreferences.markReadMany(readChannelIds)");
    expect(app).toContain("api.updateChannelProfile(channelId, name, description)");
    expect(app).toContain("onOpenRoutine={openRoutineHandlers.get(channelId)}");
    expect(app).toContain("routineOpenRequest={");
    expect(app).toContain("const editSidebarChannel = useCallback(");
    expect(app).not.toContain(
      'useEffect(() => {\n    setInspectorMode("summary");\n  }, [selectedId]);'
    );
    expect(app).toContain("target={settingsTarget}");
    expect(app).toContain("target={pluginTarget}");
    expect(app).toContain("<BotTemplateImportDialog");
    expect(actions).toContain('if (action === "shareAsTemplate")');
    expect(actions).toContain("options.shareAsTemplate(bot)");
  });

  test("retains bounded navigation and lazy optional surfaces", async () => {
    const app = await rendererSource("App.tsx");

    for (const module of [
      "a2a-exchange-sheet",
      "async-tasks-panel",
      "bot-template-share",
      "desktop-dialogs",
      "inspector",
      "new-bot-screen",
      "plugin-settings",
      "search-dialog",
      "settings-panel",
    ]) {
      expect(app).toContain(`import("./components/openteam/${module}")`);
    }
    expect(app).toContain(".slice(0, 3)");
    expect(app).toContain("void ensureMessageLoaded(channelId, messageId)");
    expect(app).toContain("clearSearchContext(channelId)");
    expect(app).toContain("const openRoutineHandlers = useMemo(");
  });
});
