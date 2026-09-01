import { describe, expect, test } from "bun:test";
import { parseAuthMode } from "../src/auth-mode";

describe("server authentication mode", () => {
  test("requires authentication by default", () => {
    expect(parseAuthMode(undefined)).toBe("required");
  });

  test("accepts the two explicit modes", () => {
    expect(parseAuthMode("required")).toBe("required");
    expect(parseAuthMode("disabled")).toBe("disabled");
  });

  test("rejects empty, misspelled, or ambiguous values", () => {
    for (const value of ["", "off", "false", "DISABLED", " disabled "]) {
      expect(() => parseAuthMode(value)).toThrow(
        'OPENBOT_AUTH_MODE must be either "required" or "disabled"'
      );
    }
  });
});
