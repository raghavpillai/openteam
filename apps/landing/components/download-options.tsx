"use client";

import { Laptop, Download, Monitor, Package, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type DesktopRelease,
  type DesktopTargetId,
  desktopTargets,
  RELEASES_URL,
} from "@/lib/github-release";

type ReleaseState =
  | { state: "loading" }
  | { state: "ready"; release: DesktopRelease }
  | { state: "unpublished" }
  | { state: "unavailable" };

interface NavigatorHints extends Navigator {
  userAgentData?: {
    platform?: string;
    getHighEntropyValues?: (hints: string[]) => Promise<{
      architecture?: string;
      bitness?: string;
      platform?: string;
    }>;
  };
}

const iconFor = (target: DesktopTargetId) => {
  if (target.startsWith("mac")) return Laptop;
  if (target.startsWith("windows")) return Monitor;
  return Terminal;
};

export function targetForPlatform(
  platform: string,
  userAgent: string,
  architecture: string,
  maxTouchPoints = 0
): DesktopTargetId | null {
  const normalizedPlatform = platform.toLowerCase();
  const normalizedAgent = userAgent.toLowerCase();
  const normalizedArchitecture = architecture.toLowerCase();

  // Android reports Linux; iPadOS Safari can report a desktop Mac platform.
  // Neither can run a desktop build, so leave the platform choice unselected.
  if (
    /android|iphone|ipad|ipod/.test(`${normalizedPlatform} ${normalizedAgent}`) ||
    (normalizedPlatform.includes("mac") && maxTouchPoints > 1)
  ) {
    return null;
  }

  if (normalizedPlatform.includes("mac") || normalizedAgent.includes("macintosh")) {
    if (normalizedArchitecture.includes("arm")) return "mac-arm64";
    if (normalizedArchitecture.includes("x86")) return "mac-x64";
    // Safari does not expose Mac architecture. Apple silicon is the best default,
    // while the Intel build remains visible directly beneath it.
    return "mac-arm64";
  }
  if (normalizedPlatform.includes("win") || normalizedAgent.includes("windows")) {
    return "windows-x64";
  }
  if (normalizedPlatform.includes("linux") || normalizedAgent.includes("linux")) {
    return "linux-x64";
  }
  return null;
}

export const detectTarget = async (): Promise<DesktopTargetId | null> => {
  const browser = navigator as NavigatorHints;
  const ua = navigator.userAgent.toLowerCase();
  const platform = (browser.userAgentData?.platform ?? navigator.platform ?? "").toLowerCase();
  let architecture = "";

  try {
    const hints = await browser.userAgentData?.getHighEntropyValues?.([
      "architecture",
      "bitness",
      "platform",
    ]);
    architecture = `${hints?.architecture ?? ""}${hints?.bitness ?? ""}`.toLowerCase();
  } catch {
    // Architecture hints are optional and privacy-gated in some browsers.
  }

  return targetForPlatform(platform, ua, architecture, browser.maxTouchPoints);
};

const formatSize = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
const DESKTOP_SOURCE_URL = "/docs/development/from-source";

export function DownloadOptions() {
  const [recommended, setRecommended] = useState<DesktopTargetId | null>(null);
  const [releaseState, setReleaseState] = useState<ReleaseState>({ state: "loading" });

  useEffect(() => {
    void detectTarget().then(setRecommended);
    void fetch("/api/releases/latest")
      .then(async (response) => {
        if (response.status === 404) return setReleaseState({ state: "unpublished" });
        if (!response.ok) throw new Error("release unavailable");
        const payload = (await response.json()) as { release: DesktopRelease };
        setReleaseState({ state: "ready", release: payload.release });
      })
      .catch(() => setReleaseState({ state: "unavailable" }));
  }, []);

  const suggested = desktopTargets.find((item) => item.id === recommended &&
    releaseState.state === "ready" && releaseState.release.downloads[item.id]);
  const missingBuilds = releaseState.state === "ready" &&
    desktopTargets.some((target) => !releaseState.release.downloads[target.id]);

  return (
    <div className="dl-options">
      <div className="dl-release-meta">
        <p aria-live="polite">
          {suggested
            ? `Suggested for this device: ${suggested.label} · ${suggested.detail}.`
            : "Choose your desktop build."}
        </p>
        {releaseState.state === "ready" ? (
          <a href={releaseState.release.releaseUrl}>Release {releaseState.release.version}</a>
        ) : null}
      </div>
      <div className="dl-builds">
        {desktopTargets.map((target) => {
          const Icon = iconFor(target.id);
          const asset =
            releaseState.state === "ready" ? releaseState.release.downloads[target.id] : null;
          const isRecommended = recommended === target.id && !!asset;
          return (
            <article className="dl-build" data-recommended={isRecommended} key={target.id}>
              <div className="dl-build-heading">
                <span className="dl-platform-icon">
                  <Icon size={22} aria-hidden="true" />
                </span>
                <div>
                  <h3>{target.label}</h3>
                  <p>{target.detail}</p>
                </div>
              </div>
              <div className="dl-build-info">
                {isRecommended && <Badge className="dl-recommended">Suggested</Badge>}
                <span>
                  {asset
                    ? formatSize(asset.size)
                    : releaseState.state === "ready"
                      ? "No installer in this release"
                    : target.id.startsWith("mac")
                      ? ".dmg"
                      : target.id.startsWith("windows")
                        ? ".exe"
                        : ".AppImage"}
                </span>
              </div>
              {asset ? (
                <Button
                  className="dl-download-button"
                  aria-label={`Download ${target.label} ${target.detail}`}
                  render={<a href={`/api/download/desktop?target=${target.id}`} />}
                  nativeButton={false}
                >
                  <Download size={16} /> Download
                </Button>
              ) : releaseState.state === "ready" ? (
                <Button className="dl-download-button dl-source-button"
                  render={<a href={DESKTOP_SOURCE_URL} />} nativeButton={false}
                  aria-label={`Run ${target.label} ${target.detail} from source`}>
                  <Terminal size={16} /> Run from source
                </Button>
              ) : (
                <Button className="dl-download-button" disabled>
                  {releaseState.state === "loading" ? "Checking…" : "Not available"}
                </Button>
              )}
            </article>
          );
        })}
      </div>
      {missingBuilds && (
        <p className="dl-build-fallback">
          A build missing for your platform? Check <a href={RELEASES_URL}>all releases</a> or
          {" "}<a href={DESKTOP_SOURCE_URL}>run the desktop app from source</a>.
        </p>
      )}
      {releaseState.state === "unpublished" ? (
        <div className="dl-release-error" role="status">
          <Package size={17} aria-hidden="true" />
          <p>
            Desktop builds haven’t been published yet. In the meantime, you can{" "}
            <a href={DESKTOP_SOURCE_URL}>run the desktop app from source</a>.
          </p>
        </div>
      ) : null}
      {releaseState.state === "unavailable" ? (
        <div className="dl-release-error" role="status">
          <Package size={17} aria-hidden="true" />
          <p>
            Couldn’t load the latest release. Check <a href={RELEASES_URL}>GitHub Releases</a> for
            downloads.
          </p>
        </div>
      ) : null}
    </div>
  );
}
