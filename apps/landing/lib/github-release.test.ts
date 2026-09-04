import { describe, expect, test } from "bun:test";
import { mapDesktopRelease } from "./github-release";

describe("desktop release mapping", () => {
  test("maps native installers and leaves missing alternatives unavailable", () => {
    const release = mapDesktopRelease({
      tag_name: "v0.1.0",
      html_url: "https://github.com/raghavpillai/openteam/releases/tag/v0.1.0",
      published_at: "2026-09-03T00:00:00Z",
      assets: [
        {
          name: "OpenTeam-0.1.0-mac-arm64.dmg",
          browser_download_url: "https://example.com/mac.dmg",
          size: 42,
        },
        {
          name: "OpenTeam-0.1.0-win-x64.exe",
          browser_download_url: "https://example.com/windows.exe",
          size: 84,
        },
      ],
    });

    expect(release.version).toBe("0.1.0");
    expect(release.downloads["mac-arm64"]?.url).toBe("https://example.com/mac.dmg");
    expect(release.downloads["windows-x64"]?.url).toBe("https://example.com/windows.exe");
    expect(release.downloads["mac-x64"]).toBeNull();
    expect(release.downloads["linux-x64"]).toBeNull();
  });
});
