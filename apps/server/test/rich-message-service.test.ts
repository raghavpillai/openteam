import { describe, expect, test } from "bun:test";
import { buildSecretProvidedAck } from "../src/services/rich-message-service";

describe("secure rich-message handoff", () => {
  test("uses Grok's exact hidden acknowledgement without the secret value", () => {
    const prompt = buildSecretProvidedAck("Slack bot token");
    expect(
      prompt
    ).toBe(`[The user securely provided the requested secret: "Slack bot token". It was written straight to its destination (channel-credential); you never see the value and it is not in this conversation.]
Confirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status.`);
    expect(prompt).not.toContain("xoxb-secret-value");
  });
});
