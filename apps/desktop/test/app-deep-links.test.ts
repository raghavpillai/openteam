import { describe, expect, test } from "bun:test";
import {
  parseOpenBotDeepLink,
  SETTINGS_ANCHORS,
  settingsViewForAnchor,
} from "../src/renderer/lib/app-deep-links";
import { botTemplateShareUrl } from "../src/renderer/lib/bot-template";

describe("Grok Bot deep-link routing parity", () => {
  test("accepts every documented settings anchor and resolves its exact panel", () => {
    for (const anchor of SETTINGS_ANCHORS) {
      const parsed = parseOpenBotDeepLink(`grokbot://app/v1/settings?id=${anchor}`);
      expect(parsed).toEqual({ kind: "settings", anchor });
      if (parsed?.kind === "settings") expect(settingsViewForAnchor(parsed.anchor)).toBeString();
    }
    expect(settingsViewForAnchor("update-status")).toBe("updates");
    expect(settingsViewForAnchor("local-execution")).toBe("computer");
    expect(settingsViewForAnchor("inference-provider")).toBe("server");
  });

  test("preserves the stable plugin id and rejects malformed or unsupported links", () => {
    expect(parseOpenBotDeepLink("grokbot://app/v1/plugin/add?id=google-calendar")).toEqual({
      kind: "plugin",
      pluginId: "google-calendar",
    });
    expect(parseOpenBotDeepLink("grokbot://app/v1/settings?id=not-a-real-anchor")).toBeNull();
    expect(parseOpenBotDeepLink("grokbot://app/v1/settings?id=plan")).toBeNull();
    expect(parseOpenBotDeepLink("grokbot://app/v1/settings?id=language")).toBeNull();
    expect(parseOpenBotDeepLink("grokbot://app/v1/settings?id=update-channel")).toBeNull();
    expect(parseOpenBotDeepLink("https://app/v1/settings?id=theme")).toBeNull();
    expect(parseOpenBotDeepLink("grokbot://app/v1/plugin/add?id=")).toBeNull();
  });

  test("previews a valid shared bot template before import", () => {
    const template = {
      name: "Research Bot",
      title: "research",
      description: "Finds primary sources.",
      instructions: "Cite every claim.",
      icon: "leaf",
      color: "#10b981",
      notificationsEnabled: true,
    };

    expect(parseOpenBotDeepLink(botTemplateShareUrl(template))).toEqual({
      kind: "template",
      template,
    });
    expect(parseOpenBotDeepLink("grokbot://app/v1/template/add?data=broken")).toBeNull();
  });
});
