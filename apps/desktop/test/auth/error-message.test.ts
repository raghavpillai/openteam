import { describe, expect, test } from "bun:test";
import { authErrorMessage } from "../../src/renderer/lib/auth-error-message";

describe("sign-in error presentation", () => {
  test("shows a rejected sign-in without Electron's IPC wrapper", () => {
    expect(
      authErrorMessage(
        new Error(
          "Error invoking remote method 'openteam:auth:sign-in': Error: Incorrect username or password."
        ),
        "Could not sign in"
      )
    ).toBe("Incorrect username or password.");
  });
  test("makes native network failures actionable", () => {
    expect(
      authErrorMessage(
        new Error("Error invoking remote method 'openteam:auth:sign-in': Error: fetch failed"),
        "Could not sign in"
      )
    ).toBe("Could not reach this OpenTeam server. Check the address and your connection.");
  });
  test("preserves useful server messages and redacts credentials", () => {
    expect(
      authErrorMessage(new Error("Server rejected PASSWORD=private-value"), "Could not sign in")
    ).toBe("Server rejected PASSWORD=[REDACTED]");
    expect(
      authErrorMessage(new Error("This endpoint is not an OpenTeam server."), "Could not connect")
    ).toBe("This endpoint is not an OpenTeam server.");
  });
  test("uses the fallback when no useful error is returned", () => {
    expect(authErrorMessage(null, "Could not sign in")).toBe("Could not sign in");
    expect(
      authErrorMessage(
        new Error("Error invoking remote method 'openteam:auth:sign-in': Error: "),
        "Could not sign in"
      )
    ).toBe("Could not sign in");
  });
});
