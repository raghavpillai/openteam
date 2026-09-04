import { describe, expect, test } from "bun:test";
import {
  authOptionLabel,
  defaultAuthOption,
  selectedAuthOption,
} from "../src/provider-auth-prompt";

const options = [
  { id: "browser", label: "Browser login (default)" },
  { id: "device_code", label: "Device code", description: "Works over SSH" },
] as const;

describe("provider authentication prompts", () => {
  test("makes device-code authentication the default", () => {
    expect(defaultAuthOption(options)).toBe(options[1]);
    expect(selectedAuthOption(options, "")).toBe(options[1]);
  });

  test("still accepts an explicit number or option id", () => {
    expect(selectedAuthOption(options, "1")).toBe(options[0]);
    expect(selectedAuthOption(options, "device_code")).toBe(options[1]);
  });

  test("renders only the effective option as the default", () => {
    expect(authOptionLabel(options[0], false)).toBe("Browser login");
    expect(authOptionLabel(options[1], true)).toBe("Device code (default) — Works over SSH");
  });
});
