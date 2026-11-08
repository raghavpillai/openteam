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

  test("reports a wrapped GitHub timeout without exposing the release feed or response", () => {
    const error = Object.assign(
      new Error(
        'Cannot parse releases feed: Error: Unable to find latest version on GitHub: HttpError: 504 "method: GET url: https://github.com/raghavpillai/openteam/releases/latest\\nData:\\n<html>504 Gateway Time-out</html>" Headers: {"set-cookie":["session=private"]}\n' +
          '    at GitHubProvider.getLatestTagName (file:///Applications/OpenTeam.app/main.js:1:1)\n' +
          'XML:\n<feed><entry><content>The binaries come with Sigstore signatures and SHA256SUMS checksums.</content></entry></feed>'
      ),
      { code: "ERR_UPDATER_INVALID_RELEASE_FEED" }
    );
    expect(classifyDesktopUpdateError(error, "checking")).toEqual({
      failureKind: "feed-http-status",
      message: "The update service returned HTTP 504. Try again in a few minutes.",
    });
    expect(classifyDesktopUpdateError(error, "error").failureKind).toBe("feed-http-status");
  });

  test("ignores signature references in malformed feed payloads", () => {
    for (const payload of [
      '\nXML:\n<feed>Code signature validation failed in an older release</feed>',
      ' rawData: {"releaseNotes":"Fix signatures and SHA512 checksums"}',
    ]) {
      const failure = classifyDesktopUpdateError(`Cannot parse releases feed${payload}`, "checking");
      expect(failure.failureKind).toBe("feed-malformed");
      expect(failure.message).toBe(
        "The update service returned invalid release information. Try again later."
      );
    }
  });

  test("recognizes structured HTTP, network and verification errors", () => {
    expect(
      classifyDesktopUpdateError(
        Object.assign(new Error("Service unavailable"), { statusCode: 503 }),
        "checking"
      )
    ).toEqual({
      failureKind: "feed-http-status",
      message: "The update service returned HTTP 503. Try again in a few minutes.",
    });
    expect(
      classifyDesktopUpdateError(
        Object.assign(new Error("Request failed"), { code: "ETIMEDOUT" }),
        "checking"
      ).failureKind
    ).toBe("service-unavailable");
    expect(
      classifyDesktopUpdateError(
        Object.assign(new Error("Verification failed"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }),
        "downloading"
      ).failureKind
    ).toBe("signature-invalid");
    expect(classifyDesktopUpdateError("HTTP 502", "downloading").failureKind).toBe("download-failed");
    expect(
      classifyDesktopUpdateError(
        "Update info doesn't contain a sha512 checksum",
        "downloading"
      ).failureKind
    ).toBe("feed-malformed");
  });

  test("unknown updater errors use bounded public copy", () => {
    const failure = classifyDesktopUpdateError(
      `Unexpected error ${"private response ".repeat(1_000)}`,
      "checking"
    );
    expect(failure).toEqual({
      failureKind: "unknown",
      message: "The desktop update failed. Try again.",
    });
  });
});
