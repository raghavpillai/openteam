import { describe, expect, test } from "bun:test";
import { screenViewerUrl } from "../src/services/screen-service";

describe("screen viewer URL authentication", () => {
  test("keeps the session credential out of the HTTP request target", () => {
    const url = screenViewerUrl("openteam.local", 6207, "A_bc-123");
    const parsed = new URL(url);

    expect(parsed.origin).toBe("http://openteam.local:6207");
    expect(parsed.pathname).toBe("/openteam.html");
    expect(parsed.searchParams.get("path")).toBe("websockify");
    expect(parsed.search).not.toContain("A_bc-123");
    expect(new URLSearchParams(parsed.hash.slice(1)).get("password")).toBe("A_bc-123");
  });
});
