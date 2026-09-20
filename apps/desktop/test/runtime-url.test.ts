import { describe, expect, test } from "bun:test";
import {
  CONFIGURED_API_BASE_KEY,
  resolveApiBase,
  resolveConfiguredApiBase,
  resolveVncSocketUrl,
  saveConfiguredApiBase,
} from "../src/renderer/client/runtime-url";

describe("runtime URLs", () => {
  test("uses the Vite origin for browser development", () => {
    expect(resolveApiBase("http://100.94.42.50:5173/chat")).toBe("http://100.94.42.50:5173");
  });

  test("keeps the loopback API for packaged Electron", () => {
    expect(resolveApiBase("file:///Applications/OpenTeam.app/index.html")).toBe(
      "http://127.0.0.1:8787"
    );
  });

  test("honors an explicitly configured API", () => {
    expect(resolveApiBase("http://127.0.0.1:5173", "http://openteam.example:8787/")).toBe(
      "http://openteam.example:8787"
    );
  });

  test("prefers a user-selected API over the build-time default", () => {
    const values = new Map([[CONFIGURED_API_BASE_KEY, "https://bots.example.test/"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null };

    expect(
      resolveConfiguredApiBase(
        "file:///Applications/OpenTeam.app/index.html",
        storage,
        "https://build.example.test"
      )
    ).toBe("https://bots.example.test");
  });

  test("normalizes a user-selected API before saving it", () => {
    const values = new Map<string, string>();
    const storage = { setItem: (key: string, value: string) => values.set(key, value) };

    expect(saveConfiguredApiBase(storage, " https://bots.example.test/// ")).toBe(
      "https://bots.example.test"
    );
    expect(values.get(CONFIGURED_API_BASE_KEY)).toBe("https://bots.example.test");
  });

  test("ignores a corrupt saved API instead of breaking desktop launch", () => {
    const storage = { getItem: () => "file:///tmp/not-an-openteam-server" };

    expect(
      resolveConfiguredApiBase(
        "file:///Applications/OpenTeam.app/index.html",
        storage,
        "https://build.example.test"
      )
    ).toBe("https://build.example.test");
  });

  test("uses the selected server for authenticated VNC, including HTTPS and path prefixes", () => {
    const path = "/api/v0/bots/test-bot/screen/vnc";
    expect(resolveVncSocketUrl("http://100.94.42.50:8787", path, "test-bot"))
      .toBe("ws://100.94.42.50:8787" + path);
    expect(resolveVncSocketUrl("https://server.ts.net:10000/team", path, "test-bot"))
      .toBe("wss://server.ts.net:10000/team" + path);
  });
  test("rejects cross-server, cross-bot and credential-bearing grants", () => {
    for (const path of ["https://other.test/vnc", "//other.test/vnc", "/api/v0/bots/other/screen/vnc",
      "/api/v0/bots/test-bot/screen/vnc?token=secret", "/api/v0/bots/test-bot/screen/vnc#password=secret"]) {
      expect(() => resolveVncSocketUrl("https://server.test", path, "test-bot")).toThrow();
    }
  });
});
