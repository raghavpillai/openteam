import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDesktopUpdateError,
  hasDesktopUpdateFeed,
  parseDesktopReleaseManifest,
} from "../src/main/update-status";

describe("desktop update diagnostics", () => {
  test("only builds with an update feed can update themselves", async () => {
    const resources = await mkdtemp(join(tmpdir(), "openteam-update-feed-"));
    try {
      expect(hasDesktopUpdateFeed(resources)).toBe(false);
      await writeFile(join(resources, "app-update.yml"), "provider: github\n");
      expect(hasDesktopUpdateFeed(resources)).toBe(true);
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });

  test("validates release manifests and refuses unsafe download URLs", () => {
    expect(
      parseDesktopReleaseManifest(
        { tag_name: "v1.2.3", html_url: "https://github.com/openteam/release" },
        "https://github.com/openteam/latest"
      )
    ).toEqual({ version: "1.2.3", downloadUrl: "https://github.com/openteam/release" });
    expect(
      parseDesktopReleaseManifest(
        { version: "1.2.3", html_url: "http://insecure.test/release" },
        "https://github.com/openteam/latest"
      ).downloadUrl
    ).toBe("https://github.com/openteam/latest");
    expect(() => parseDesktopReleaseManifest({ tag_name: "latest" }, "https://safe.test")).toThrow(
      "invalid release version"
    );
  });

  test("distinguishes signature, feed, network, download, and apply failures", () => {
    expect(
      classifyDesktopUpdateError("Code signature validation failed", "downloading").failureKind
    ).toBe("signature-invalid");
    expect(classifyDesktopUpdateError("Update service returned 503", "checking").failureKind).toBe(
      "feed-http-status"
    );
    expect(classifyDesktopUpdateError("manifest JSON parse failed", "checking").failureKind).toBe(
      "feed-malformed"
    );
    expect(classifyDesktopUpdateError("network unreachable", "checking").failureKind).toBe(
      "service-unavailable"
    );
    expect(classifyDesktopUpdateError("stream ended", "downloading").failureKind).toBe(
      "download-failed"
    );
    expect(
      classifyDesktopUpdateError("cannot apply on this platform", "installing").failureKind
    ).toBe("apply-unsupported");
  });
});
