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

  test.each([
    ["Code signature validation failed", "downloading", "signature-invalid"],
    [Object.assign(new Error("x"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }), "downloading", "signature-invalid"],
    ["Update service returned 503", "checking", "feed-http-status"],
    [Object.assign(new Error("Service unavailable"), { statusCode: 503 }), "checking", "feed-http-status"],
    ["manifest JSON parse failed", "checking", "feed-malformed"],
    ["Cannot parse releases feed\nXML:\n<feed>Code signature validation failed</feed>", "checking", "feed-malformed"],
    ["Update info doesn't contain a sha512 checksum", "downloading", "feed-malformed"],
    ["network unreachable", "checking", "service-unavailable"],
    [Object.assign(new Error("Request failed"), { code: "ETIMEDOUT" }), "checking", "service-unavailable"],
    [new Error("net::ERR_NAME_NOT_RESOLVED"), "checking", "service-unavailable"],
    [new Error("net::ERR_CONNECTION_REFUSED"), "downloading", "download-failed"],
    ["stream ended", "downloading", "download-failed"],
    ["HTTP 502", "downloading", "download-failed"],
    ["cannot apply on this platform", "installing", "apply-unsupported"],
  ] as const)("classifies %p while %s as %s", (error, phase, kind) => {
    expect(classifyDesktopUpdateError(error, phase).failureKind).toBe(kind);
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

});
