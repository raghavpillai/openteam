import { describe, expect, test } from "bun:test";
import { authErrorMessage } from "../../src/renderer/lib/auth-error-message";
import { readNativeAuthWithDeadline } from "../../src/renderer/client/native-auth-deadline";

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
  test("shows secure storage failures without Electron's IPC wrapper", () => {
    const message = "Secure sign-in storage did not respond. Check the system permission prompt on this computer, then try again.";
    expect(authErrorMessage(
      new Error(`Error invoking remote method 'openteam:auth-token:write': Error: ${message}`),
      "Could not sign in"
    )).toBe(message);
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

test("a stuck native read exits checking, and a late read cannot settle the timed-out request", async () => {
  let finish!: (value: string) => void;
  let accepted = false;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const result = readNativeAuthWithDeadline(pending, 5).then(value => { accepted = true; return value; });
  await expect(result).rejects.toThrow("Secure sign-in storage did not respond");
  finish("synthetic late session");
  await Promise.resolve();
  expect(accepted).toBe(false);
  expect(await readNativeAuthWithDeadline(Promise.resolve("retry"), 50)).toBe("retry");
});

test("successful and rejected native reads preserve their result", async () => {
  const value = { token: "synthetic session" };
  expect(await readNativeAuthWithDeadline(Promise.resolve(value), 50)).toBe(value);
  await expect(readNativeAuthWithDeadline(Promise.reject(new Error("fixture error")), 50)).rejects.toThrow("fixture error");
});
