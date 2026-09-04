import { describe, expect, test } from "bun:test";
import { prepareMessageMarkdown } from "../../src/renderer/components/ai-elements/message-response/config";

describe("OpenTeam in-app links", () => {
  test("preserves source-compatible settings and plugin links for safe in-app routing", () => {
    expect(
      prepareMessageMarkdown(
        "Open [Update Track](openteam://app/v1/settings?id=update-channel) or [Plugins](openteam://app/v1/plugin/add?id=calendar)."
      )
    ).toBe(
      "Open [Update Track](streamdown:openteam://app/v1/settings?id=update-channel) or [Plugins](streamdown:openteam://app/v1/plugin/add?id=calendar)."
    );
  });
});
