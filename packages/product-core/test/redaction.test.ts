import { describe, expect, test } from "bun:test";
import { clientErrorMessage, redactSensitiveText, safeErrorMessage } from "../src/redaction";

describe("diagnostic credential redaction", () => {
  test("removes bearer, environment, JSON, CLI, URL, and provider secrets", () => {
    const input = [
      "Authorization: Bearer abc.def.ghi",
      "OPENBOT_AUTH_SECRET=super-secret-value",
      '\"password\":\"hunter2\"',
      "openbot command --token ghp_abcdefghijklmnopqrstuvwxyz123456",
      "https://owner:password@example.com/path",
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    const output = redactSensitiveText(input);

    for (const secret of [
      "abc.def.ghi",
      "super-secret-value",
      "hunter2",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "owner:password@",
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  test("redacts errors while preserving useful context", () => {
    expect(safeErrorMessage(new Error("Docker failed: OPENBOT_CONTROL_TOKEN=topsecret"))).toBe(
      "Docker failed: OPENBOT_CONTROL_TOKEN=[REDACTED]"
    );
  });

  test("uses safe client fallbacks without exposing credentials", () => {
    expect(clientErrorMessage(null, "Could not complete the request.")).toBe(
      "Could not complete the request."
    );
    expect(clientErrorMessage(new Error("Denied: API_KEY=private"), "Fallback")).toBe(
      "Denied: API_KEY=[REDACTED]"
    );
  });

  test("fully removes quoted secrets that contain spaces", () => {
    const output = redactSensitiveText(
      `OPENBOT_AUTH_PASSWORD="correct horse battery staple" openbot auth-reset --password 'another secret phrase'`
    );

    expect(output).toBe(
      "OPENBOT_AUTH_PASSWORD=[REDACTED] openbot auth-reset --password [REDACTED]"
    );
    expect(output).not.toContain("battery staple");
    expect(output).not.toContain("secret phrase");
  });
});
