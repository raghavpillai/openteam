import { describe, expect, test } from "bun:test";
import { prepareMessageMarkdown } from "../../src/renderer/components/ai-elements/message-response/config";

describe("Grok Bot in-app links", () => {
  test("preserves source-compatible settings and plugin links for safe in-app routing", () => {
    expect(
      prepareMessageMarkdown(
        "Open [Update Track](grokbot://app/v1/settings?id=update-channel) or [Plugins](grokbot://app/v1/plugin/add?id=calendar)."
      )
    ).toBe(
      "Open [Update Track](streamdown:grokbot://app/v1/settings?id=update-channel) or [Plugins](streamdown:grokbot://app/v1/plugin/add?id=calendar)."
    );
  });
});
