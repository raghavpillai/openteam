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
  architecture: string
): DesktopTargetId | null {
  const normalizedPlatform = platform.toLowerCase();
  const normalizedAgent = userAgent.toLowerCase();
  const normalizedArchitecture = architecture.toLowerCase();

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

  return targetForPlatform(platform, ua, architecture);
};

const formatSize = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

export function DownloadOptions() {
  const [recommended, setRecommended] = useState<DesktopTargetId | null>(null);
  const [releaseState, setReleaseState] = useState<ReleaseState>({ state: "loading" });

  useEffect(() => {
    void detectTarget().then(setRecommended);
    void fetch("/api/releases/latest")
      .then(async (response) => {
        if (!response.ok) throw new Error("release unavailable");
        const payload = (await response.json()) as { release: DesktopRelease };
        setReleaseState({ state: "ready", release: payload.release });
      })
      .catch(() => setReleaseState({ state: "unavailable" }));
  }, []);

  const suggested = desktopTargets.find((item) => item.id === recommended);

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
          const isRecommended = recommended === target.id;
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
              ) : (
                <Button className="dl-download-button" disabled>
                  {releaseState.state === "loading" ? "Checking…" : "Not available"}
                </Button>
              )}
            </article>
          );
        })}
      </div>
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
