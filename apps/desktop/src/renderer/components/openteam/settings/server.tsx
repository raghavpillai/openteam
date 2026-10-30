import { API_BASE } from "../../../client/http";
import { useServerUpdateStatus } from "../../../hooks/use-server-update-status";
import { AdvancedComputerSettings, MachineSettings } from "./machines";
import { TailscaleSettings } from "./tailscale";
import { ServerActivity } from "./server-activity";
import { SectionLabel, SettingsGroup, SettingsLink, SettingsRow } from "./ui";

export default function ServerSettings() {
  const { status: server, loading } = useServerUpdateStatus(window.openteam?.versions.app ?? null);
  return (
    <>
      <section aria-label="Connected server" className="mb-6">
        <SectionLabel>Connected server</SectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={
              loading ? "Checking server…" : `Server ${server?.currentVersion ?? "version unknown"}`
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
