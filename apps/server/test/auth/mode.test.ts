import { expect, test } from "bun:test";
import { parseAuthMode } from "../../src/auth-mode";

test("auth mode defaults to required and accepts only the two exact values", () => {
  expect(parseAuthMode(undefined)).toBe("required");
  expect(parseAuthMode("required")).toBe("required");
  expect(parseAuthMode("disabled")).toBe("disabled");
  for (const value of ["", "off", "false", "DISABLED", " disabled "])
    expect(() => parseAuthMode(value)).toThrow('OPENTEAM_AUTH_MODE must be either "required" or "disabled"');
});
