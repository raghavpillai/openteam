import { describe, expect, test } from "bun:test";
import {
  parseOpenTeamDeepLink,
  SETTINGS_ANCHORS,
  settingsViewForAnchor,
} from "../src/renderer/lib/app-deep-links";

describe("OpenTeam deep-link routing parity", () => {
  test("accepts every documented settings anchor and resolves its exact panel", () => {
    for (const anchor of SETTINGS_ANCHORS) {
      const parsed = parseOpenTeamDeepLink(`openteam://app/v1/settings?id=${anchor}`);
      expect(parsed).toEqual({ kind: "settings", anchor });
      if (parsed?.kind === "settings") expect(settingsViewForAnchor(parsed.anchor)).toBeString();
    }
    expect(settingsViewForAnchor("update-status")).toBe("updates");
    expect(settingsViewForAnchor("local-execution")).toBe("computer");
    expect(settingsViewForAnchor("inference-provider")).toBe("server");
  });

  test("preserves the stable plugin id and rejects malformed or unsupported links", () => {
    expect(parseOpenTeamDeepLink("openteam://app/v1/plugin/add?id=google-calendar")).toEqual({
      kind: "plugin",
      pluginId: "google-calendar",
    });
    expect(parseOpenTeamDeepLink("openteam://app/v1/settings?id=not-a-real-anchor")).toBeNull();
    expect(parseOpenTeamDeepLink("openteam://app/v1/settings?id=plan")).toBeNull();
    expect(parseOpenTeamDeepLink("openteam://app/v1/settings?id=language")).toBeNull();
    expect(parseOpenTeamDeepLink("openteam://app/v1/settings?id=update-channel")).toBeNull();
    expect(parseOpenTeamDeepLink("https://app/v1/settings?id=theme")).toBeNull();
    expect(parseOpenTeamDeepLink("openteam://app/v1/plugin/add?id=")).toBeNull();
  });

  test("rejects retired shared bot template links", () => {
    const template = {
      name: "Research Bot",
      title: "research",
      description: "Finds primary sources.",
      instructions: "Cite every claim.",
      icon: "leaf",
      color: "#10b981",
      notificationsEnabled: true,
    };

    const data = Buffer.from(
      JSON.stringify({ format: "openteam.bot-template", version: 1, bot: template })
    ).toString("base64url");

    expect(parseOpenTeamDeepLink(`openteam://app/v1/template/add?data=${data}`)).toBeNull();
    expect(parseOpenTeamDeepLink("openteam://app/v1/template/add?data=broken")).toBeNull();
  });
});
