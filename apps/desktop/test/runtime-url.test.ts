import { describe, expect, test } from "bun:test";
import { resolveApiBase, resolveViewerUrl } from "../src/renderer/client/runtime-url";

describe("runtime URLs", () => {
  test("uses the Vite origin for browser development", () => {
    expect(resolveApiBase("http://100.94.42.50:5173/chat")).toBe("http://100.94.42.50:5173");
  });

  test("keeps the loopback API for packaged Electron", () => {
    expect(resolveApiBase("file:///Applications/OpenBot.app/index.html")).toBe(
      "http://127.0.0.1:8787"
    );
  });

  test("honors an explicitly configured API", () => {
    expect(resolveApiBase("http://127.0.0.1:5173", "http://openbot.example:8787/")).toBe(
      "http://openbot.example:8787"
    );
  });

  test("routes noVNC through the remote Vite origin", () => {
    expect(
      resolveViewerUrl(
        "http://127.0.0.1:6207/openbot.html?autoconnect=true&path=websockify",
        "http://100.94.42.50:5173/"
      )
    ).toBe("http://100.94.42.50:5173/novnc/6207/openbot.html?autoconnect=true&path=websockify");
  });

  test("leaves viewer URLs unchanged in packaged Electron", () => {
    expect(
      resolveViewerUrl("http://127.0.0.1:6207/openbot.html", "file:///Applications/OpenBot.app")
    ).toBe("http://127.0.0.1:6207/openbot.html");
  });
});
