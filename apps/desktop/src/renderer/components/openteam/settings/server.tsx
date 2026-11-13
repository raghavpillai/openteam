import { Suspense } from "react";
import { API_BASE } from "../../../client/http";
import { useServerUpdateStatus } from "../../../hooks/use-server-update-status";
import { AdvancedComputerSettings, MachineSettings } from "./machines";
import { preloadable } from "./preloadable";
import { TailscaleSettings } from "./tailscale";
import { ServerActivity } from "./server-activity";
import {
  SectionLabel,
  SettingsGroup,
  SettingsLink,
  SettingsReveal,
  SettingsRow,
  SkeletonBar,
  SkeletonText,
  settingsRow,
} from "./ui";

// Fetched with this section (Settings preloads it on open), so it's ready when shown.
const browserNetwork = preloadable(() => import("./browser-network"));
void browserNetwork.preload();
const BrowserNetworkSettings = browserNetwork.Component;

/** Computer network's rows (status line, two connections, protocols, exit IP, test) while its code loads. */
function BrowserNetworkSkeleton() {
  return (
    <section aria-busy="true" aria-label="Loading computer network" role="status">
      <SectionLabel>Computer network</SectionLabel>
      <SettingsGroup>
        <div className="flex h-[34px] items-center pb-[2px]">
          <SkeletonBar className="h-[8px] w-[164px]" />
        </div>
        {[118, 92, 188, 136, 44].map((width, index) => (
          <div className={settingsRow} key={index}>
            <SkeletonBar
              className={index < 2 ? "h-[9px]" : "h-[9px] w-16"}
              style={index < 2 ? { width } : undefined}
            />
            <span className="ml-auto">
              {index === 4 ? (
                <SkeletonBar className="h-7 w-11 rounded-[8px]" />
              ) : (
                <SkeletonBar className="h-[8px]" style={{ width: index < 2 ? 44 : width }} />
              )}
            </span>
          </div>
        ))}
      </SettingsGroup>
    </section>
  );
}

export default function ServerSettings() {
  const { status: server, loading } = useServerUpdateStatus(window.openteam?.versions.app ?? null);
  return (
    <>
      <Suspense fallback={<BrowserNetworkSkeleton />}>
        <BrowserNetworkSettings />
      </Suspense>
      <section aria-label="Connected server" className="my-7">
        <SectionLabel>Connected server</SectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={
              loading ? (
                <span aria-label="Checking server" role="status">
                  <SkeletonText size="title" width={96} />
                </span>
              ) : (
                <SettingsReveal>
                  Server {server?.currentVersion ?? "version unknown"}
                </SettingsReveal>
              )
            }
            description={new URL(API_BASE).host}
            control={<SettingsLink anchor="server-update">View updates</SettingsLink>}
          />
        </SettingsGroup>
      </section>
      <ServerActivity />
      <TailscaleSettings />
      <MachineSettings />
      <AdvancedComputerSettings />
    </>
  );
}
