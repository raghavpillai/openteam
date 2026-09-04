"use client";

import { Apple, Download, Monitor, Package, Terminal } from "lucide-react";
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
  if (target.startsWith("mac")) return Apple;
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

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 text-[13.5px] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
        <p aria-live="polite">
          {recommended
            ? `We think this device needs ${desktopTargets.find((item) => item.id === recommended)?.label} · ${desktopTargets.find((item) => item.id === recommended)?.detail}.`
            : "Choose your system below. We could not reliably identify this device."}
        </p>
        {releaseState.state === "ready" ? (
          <a
            className="shrink-0 font-mono text-[12px] text-ink-3 hover:text-ink"
            href={releaseState.release.releaseUrl}
          >
            OpenTeam {releaseState.release.version}
          </a>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        {desktopTargets.map((target) => {
          const Icon = iconFor(target.id);
          const asset =
            releaseState.state === "ready" ? releaseState.release.downloads[target.id] : null;
          const isRecommended = recommended === target.id;
          return (
            <div
              key={target.id}
              className="flex min-h-20 items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:gap-4 sm:px-5"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-ink-2">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{target.label}</span>
                  {isRecommended ? (
                    <Badge className="h-5 border-live/20 bg-live-soft px-2 text-[10.5px] text-[#0b7a4b]">
                      Recommended
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[13px] text-ink-3">
                  {target.detail}
                  {asset ? ` · ${formatSize(asset.size)}` : ""}
                </p>
              </div>
              {asset ? (
                <Button
                  variant={isRecommended ? "default" : "outline"}
                  size="lg"
                  className="h-10 shrink-0 gap-2 px-3.5"
                  render={<a href={`/api/download/desktop?target=${target.id}`} />}
                  nativeButton={false}
                >
                  <Download className="size-4" />
                  <span className="hidden sm:inline">Download</span>
                </Button>
              ) : (
                <Button variant="outline" size="lg" className="h-10 shrink-0 px-3.5" disabled>
                  {releaseState.state === "loading" ? "Checking…" : "Not available"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {releaseState.state === "unavailable" ? (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-attention/25 bg-attention-soft px-4 py-3 text-[13.5px] text-ink-2">
          <Package className="mt-0.5 size-4 shrink-0 text-attention" aria-hidden="true" />
          <p>
            Desktop builds have not been published yet. Check the{" "}
            <a className="font-medium text-ink underline underline-offset-4" href={RELEASES_URL}>
              releases page
            </a>{" "}
            for availability.
          </p>
        </div>
      ) : null}
    </div>
  );
}
