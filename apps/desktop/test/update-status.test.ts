import { describe, expect, test } from "bun:test";
import { classifyDesktopUpdateError, parseDesktopReleaseManifest } from "../src/main/update-status";

describe("desktop update diagnostics", () => {
  test("validates release manifests and refuses unsafe download URLs", () => {
    expect(
      parseDesktopReleaseManifest(
        { tag_name: "v1.2.3", html_url: "https://github.com/openbot/release" },
        "https://github.com/openbot/latest"
      )
    ).toEqual({ version: "1.2.3", downloadUrl: "https://github.com/openbot/release" });
    expect(
      parseDesktopReleaseManifest(
        { version: "1.2.3", html_url: "http://insecure.test/release" },
        "https://github.com/openbot/latest"
      ).downloadUrl
    ).toBe("https://github.com/openbot/latest");
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
