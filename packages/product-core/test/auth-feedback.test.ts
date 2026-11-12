import { describe, expect, test } from "bun:test";
import { authErrorMessage } from "../src/auth-feedback";

describe("shared onboarding error copy", () => {
  test("keeps useful authentication failures and redacts secrets", () => {
    expect(authErrorMessage(new Error("Incorrect password"), "Could not sign in")).toBe(
      "Incorrect password"
    );
    expect(
      authErrorMessage(new Error("Rejected AUTH_TOKEN=synthetic-test-token"), "Could not sign in")
    ).toBe("Rejected AUTH_TOKEN=[REDACTED]");
  });
});
