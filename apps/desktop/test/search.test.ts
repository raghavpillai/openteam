import { describe, expect, test } from "bun:test";
import {
  SETTINGS_PALETTE_SECTIONS,
  THEME_PALETTE_COMMANDS,
  updatePalettePresentation,
} from "../src/renderer/lib/command-palette";
import {
  isDefaultSearchResultKind,
  moveSearchSection,
  moveSearchSelection,
  normalizePaletteText,
  paletteHighlightSegments,
  rankPaletteItems,
  scorePaletteItem,
  searchSectionDirectionForKey,
  searchTextMatches,
} from "../src/renderer/lib/search";

describe("search keyboard navigation", () => {
  test("sections wrap in both directions", () => {
    expect(moveSearchSection("all", -1)).toBe("actions");
    expect(moveSearchSection("actions", 1)).toBe("all");
    expect(moveSearchSection("messages", 1)).toBe("bots");
  });

  test("results wrap and handle an empty list", () => {
    expect(moveSearchSelection(0, 4, -1)).toBe(3);
    expect(moveSearchSelection(3, 4, 1)).toBe(0);
    expect(moveSearchSelection(-1, 4, 1)).toBe(0);
    expect(moveSearchSelection(0, 0, 1)).toBe(-1);
  });

  test("Tab cycles sections without moving focus away from search", () => {
    expect(searchSectionDirectionForKey({ key: "Tab", query: "settings" })).toBe(1);
    expect(searchSectionDirectionForKey({ key: "Tab", query: "settings", shiftKey: true })).toBe(
      -1
    );
  });

  test("left and right only change sections when the query is empty", () => {
    expect(searchSectionDirectionForKey({ key: "ArrowLeft", query: "" })).toBe(-1);
    expect(searchSectionDirectionForKey({ key: "ArrowRight", query: "" })).toBe(1);
    expect(searchSectionDirectionForKey({ key: "ArrowLeft", query: "theme" })).toBeNull();
    expect(searchSectionDirectionForKey({ key: "ArrowRight", query: "theme" })).toBeNull();
  });

  test("the unfiltered All section starts with bots and groups", () => {
    expect(isDefaultSearchResultKind("bot")).toBe(true);
    expect(isDefaultSearchResultKind("channel")).toBe(true);
    expect(isDefaultSearchResultKind("message")).toBe(false);
    expect(isDefaultSearchResultKind("file")).toBe(false);
    expect(isDefaultSearchResultKind("link")).toBe(false);
    expect(isDefaultSearchResultKind("routine")).toBe(false);
  });
});

describe("local action matching", () => {
  test("matches every query term without depending on order", () => {
    expect(searchTextMatches("bot new", "Create a new bot", "New Bot")).toBe(true);
    expect(searchTextMatches("channel settings", "Chat settings")).toBe(false);
  });

  test("matches and ranks settings using OpenTeam's fuzzy label and keyword rules", () => {
    const commands = [
      ...SETTINGS_PALETTE_SECTIONS.map((settings) => ({
        title: `Settings: ${settings.label}`,
        keywords: settings.keywords,
      })),
      ...THEME_PALETTE_COMMANDS.map((theme) => ({
        title: `Theme: ${theme.label}`,
        keywords: theme.keywords,
      })),
    ];

    expect(rankPaletteItems(commands, "cookies").map((command) => command.title)).toEqual([]);
    expect(rankPaletteItems(commands, "model").map((command) => command.title)).toEqual([]);
    expect(rankPaletteItems(commands, "notifications").map((command) => command.title)).toEqual([]);
    expect(rankPaletteItems(commands, "security").map((command) => command.title)).toEqual([]);
    expect(rankPaletteItems(commands, "release track").map((command) => command.title)).toEqual([
      "Settings: Updates",
    ]);
    expect(rankPaletteItems(commands, "appearance").map((command) => command.title)).toEqual([
      "Settings: General",
      "Theme: System",
      "Theme: Light",
      "Theme: Dark",
    ]);
    expect(rankPaletteItems(commands, "stngs gen").map((command) => command.title)).toEqual([
      "Settings: General",
    ]);
    const updates = commands.find((command) => command.title === "Settings: Updates");
    if (!updates) throw new Error("Expected the Updates palette command");
    expect(scorePaletteItem("release missing", updates)).toBeNull();
  });

  test("keeps bots and groups ahead of other scored results, then sorts by score", () => {
    const ranked = rankPaletteItems(
      [
        { title: "Settings: General", searchPriority: 1 },
        { title: "settings", searchPriority: 1 },
        { title: "Settings Bot", searchPriority: 0 },
      ],
      "settings"
    );
    expect(ranked.map((item) => item.title)).toEqual([
      "Settings Bot",
      "settings",
      "Settings: General",
    ]);
  });

  test("normalizes punctuation and accents and highlights only visible literal matches", () => {
    expect(normalizePaletteText("  Rélease—Track / BETA ")).toBe("release track beta");
    expect(paletteHighlightSegments("Settings: Updates", "updates")).toEqual([
      { text: "Settings: ", isMatch: false, start: 0 },
      { text: "Updates", isMatch: true, start: 10 },
    ]);
    expect(paletteHighlightSegments("Settings: Updates", "release")).toEqual([
      { text: "Settings: Updates", isMatch: false, start: 0 },
    ]);
  });

  test("keeps unsupported settings out of the command registry", () => {
    expect(SETTINGS_PALETTE_SECTIONS.map((settings) => settings.label)).toEqual([
      "General",
      "Computer",
      "Updates",
    ]);
  });

  test("mirrors OpenTeam's stateful update command labels", () => {
    expect(updatePalettePresentation("idle").title).toBe("Check for Updates");
    expect(updatePalettePresentation("checking").title).toBe("Checking for Updates…");
    expect(updatePalettePresentation("available").title).toBe("Downloading Update…");
    expect(updatePalettePresentation("backing-up").title).toBe("Preparing Update…");
    expect(updatePalettePresentation("downloaded").title).toBe("Restart to Update");
    expect(updatePalettePresentation("installing").title).toBe("Update in Progress…");
  });

  test("Chat Settings opens the editable inspector instead of the summary", async () => {
    const source = await Bun.file(new URL("../src/renderer/App.tsx", import.meta.url)).text();
    const actionStart = source.indexOf('id: "info:settings"');
    const actionEnd = source.indexOf("},", source.indexOf("setDetailsOpen(true);", actionStart));
    const action = source.slice(actionStart, actionEnd);

    expect(action).toContain('title: "Chat Settings"');
    expect(action).toContain('setInspectorMode("settings")');
    expect(action).not.toContain('setInspectorMode("summary")');
  });
});
