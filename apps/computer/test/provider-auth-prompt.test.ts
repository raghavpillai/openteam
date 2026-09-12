import { describe, expect, test } from "bun:test";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import {
  authOptionLabel,
  createAuthQuestion,
  defaultAuthOption,
  selectedAuthOption,
} from "../src/provider-auth-prompt";

const options = [
  { id: "browser", label: "Browser login (default)" },
  { id: "device_code", label: "Device code", description: "Works over SSH" },
] as const;

describe("provider authentication prompts", () => {
  test("rejects pending and subsequent prompts when input closes", async () => {
    const input = new PassThrough();
    const terminal = createInterface({ input, output: new PassThrough() });
    const question = createAuthQuestion(terminal);
    const pending = question("Choose a method: ");
    input.end();
    await expect(pending).rejects.toThrow("terminal input closed");
    await expect(question("Retry: ")).rejects.toThrow("terminal input closed");
  });

  test("accepts normal answers before the terminal closes", async () => {
    const input = new PassThrough();
    const terminal = createInterface({ input, output: new PassThrough() });
    try {
      const pending = createAuthQuestion(terminal)("Choose a method: ");
      input.write("2\n");
      expect(await pending).toBe("2");
    } finally {
      terminal.close();
    }
  });
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
