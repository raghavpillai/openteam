import { describe, expect, test } from "bun:test";
import {
  CONFIGURED_API_BASE_KEY,
  resolveApiBase,
  resolveConfiguredApiBase,
  resolveViewerUrl,
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

  test("routes noVNC through the remote Vite origin", () => {
    expect(
      resolveViewerUrl(
        "http://127.0.0.1:6207/openteam.html?autoconnect=true&path=websockify#password=A_bc-123",
        "http://100.94.42.50:5173/"
      )
    ).toBe(
      "http://100.94.42.50:5173/novnc/6207/openteam.html?autoconnect=true&path=websockify#password=A_bc-123"
    );
  });

  test("leaves viewer URLs unchanged in packaged Electron", () => {
    expect(
      resolveViewerUrl("http://127.0.0.1:6207/openteam.html", "file:///Applications/OpenTeam.app")
    ).toBe("http://127.0.0.1:6207/openteam.html");
  });
});
