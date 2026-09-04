import { describe, expect, test } from "bun:test";

const settingsSource = (
  await Promise.all(
    [
      "settings/panel.tsx",
      "settings/general.tsx",
      "settings/general-bot.tsx",
      "settings/computer.tsx",
      "settings/updates.tsx",
    ].map((file) =>
      Bun.file(new URL(`../src/renderer/components/openteam/${file}`, import.meta.url)).text()
    )
  )
).join("\n");

describe("desktop settings controls", () => {
  test("does not render controls without implementations", () => {
    for (const label of [
      "Language",
      "Microphone",
      "Use hardware acceleration",
      "Timezone",
      "Use hardware security keys",
      "Update Track",
      "Update OpenTeam's Computer",
      "Reset OpenTeam's Computer",
    ]) {
      expect(settingsSource).not.toContain(label);
    }
    expect(settingsSource).not.toContain("StaticSelect");
    expect(settingsSource).not.toContain("StaticSwitch");
  });

  test("keeps the settings controls with real handlers", () => {
    expect(settingsSource).toContain('aria-label="Theme"');
    expect(settingsSource).toContain("Sign Out");
    expect(settingsSource).toContain("Auto-review");
    expect(settingsSource).toContain("Execution on this computer");
    expect(settingsSource).toContain("Check for Updates");
  });
});
