import { describe, expect, test } from "bun:test";
import { authErrorMessage } from "../src/auth-feedback";

describe("shared onboarding error copy", () => {
  test.each([
    "FunctionCallException: Calling getValueWithKeyAsync failed → KeyChainException: A required entitlement isn't present. (at ExpoSecureStore/SecureStoreModule.swift:168)",
    "Keychain unavailable",
  ])("hides native storage diagnostics: %s", (message) => {
    expect(authErrorMessage(new Error(message), "Could not sign in")).toBe(
      "OpenTeam could not access your saved sign-in. Restart the app and try again."
    );
  });
  test.each([
    "Enter a valid OpenTeam server URL.",
    "The OpenTeam server URL must use HTTP or HTTPS.",
    "OpenTeam server URL is required",
  ])("gives an example for an invalid address: %s", (message) => {
    expect(authErrorMessage(new Error(message), "Invalid address")).toContain(
      "starting with http:// or https://"
    );
  });
  test("explains how to fix a pasted deep link", () => {
    expect(
      authErrorMessage(
        new Error("Enter the server endpoint without a query or fragment."),
        "Invalid address"
      )
    ).toBe("Use the server address without anything after ? or #.");
  });
  test("routes credentials to the sign-in fields", () => {
    expect(
      authErrorMessage(
        new Error("Enter the server endpoint without a username or password."),
        "Invalid address"
      )
    ).toContain("sign in on the next screen");
  });
  test("keeps useful authentication failures and redacts secrets", () => {
    expect(authErrorMessage(new Error("Incorrect password"), "Could not sign in")).toBe(
      "Incorrect password"
    );
    expect(
      authErrorMessage(new Error("Rejected AUTH_TOKEN=synthetic-test-token"), "Could not sign in")
    ).toBe("Rejected AUTH_TOKEN=[REDACTED]");
  });
  test("turns a malformed sign-in success into a recovery action", () => {
    expect(
      authErrorMessage(
        new Error("The server did not return an OpenTeam session token"),
        "Could not sign in"
      )
    ).toContain("contact your server administrator");
  });
});
