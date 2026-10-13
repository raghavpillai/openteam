import { useCallback, useEffect, useState } from "react";
import type { DesktopTailscaleStatus } from "@openteam/contracts/tailscale";
import { API_BASE } from "../../../client/http";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

export function TailscaleSettings() {
  const [result, setResult] = useState<DesktopTailscaleStatus | null>(null);
  const [port, setPort] = useState("443");
  const [busy, setBusy] = useState<string | null>("Checking Tailscale…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await window.openteam?.tailscale?.request({
        serverUrl: API_BASE,
        action: "status",
      });
      setResult(
        next ?? {
          canManage: false,
          status: null,
          message: "Run these commands on your OpenTeam server host.",
        }
      );
      if (next?.status) setPort(next.status.httpsPort);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = async (action: "enable" | "disable") => {
    setBusy(
      action === "enable" ? "Configuring and verifying HTTPS…" : "Switching to local access…"
    );
    setError(null);
    setNotice(null);
    try {
      const next = await window.openteam!.tailscale.request({
        serverUrl: API_BASE,
        action,
        httpsPort: port,
      });
      setResult(next);
      setNotice(
        `Server address: ${next.status?.publicUrl}. Reconnect your apps using this address. ${action === "disable" ? "User-managed Serve mappings were preserved." : "Keep Tailscale connected on your devices."}`
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const status = result?.status;
  const validPort = /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
  const buttonClass = "rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50";
  return (
    <>
      <SectionLabel>Remote access</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Tailscale HTTPS"
          anchors={["tailscale-https"]}
          description="Use a private HTTPS address to connect your devices. Tailscale must be running on the server and on each device."
          control={
            <button
              className={buttonClass}
              disabled={!!busy}
              onClick={() => {
                setBusy("Checking Tailscale…");
                void refresh();
              }}
            >
              Refresh
            </button>
          }
        />
        <SettingsRow title="Server address" description={status?.publicUrl || API_BASE} />
        {result?.canManage ? (
          <>
            <SettingsRow
              title="HTTPS port"
              description="Default 443. Choose another port if another application uses it."
              control={
                <input
                  aria-label="Tailscale HTTPS port"
                  className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                  type="number"
                  min="1"
                  max="65535"
                  value={port}
                  disabled={!!busy}
                  onChange={(event) => setPort(event.target.value)}
                />
              }
            />
            <SettingsRow
              title="HTTPS address"
              description={
                status?.hostname && validPort
                  ? `https://${status.hostname}${Number(port) === 443 ? "" : `:${Number(port)}`}`
                  : "Start Tailscale on the host to detect its HTTPS address."
              }
            />
            <SettingsRow
              title={status?.enabled ? "Tailscale HTTPS configured" : "Enable Tailscale HTTPS"}
              description={
                status?.enabled
                  ? `${status.verified ? "HTTPS endpoint verified." : "This connection needs attention."} ${status.ownership === "openteam" ? "Managed by OpenTeam." : status.ownership === "external" ? "Uses an existing user-managed route." : ""}`
                  : "Enabling restarts the server and creates or reuses a private Serve mapping. HTTPS must be enabled for your tailnet."
              }
              control={
                <button
                  className={buttonClass}
                  disabled={!!busy || !validPort}
                  onClick={() => void change("enable")}
                >
                  {status?.enabled ? "Apply / repair" : "Enable"}
                </button>
              }
            />
            {(status?.enabled || !!status?.managedRoutes) && (
              <SettingsRow
                title="Disable Tailscale HTTPS"
                description="Switch to local access and restart the server. Remote devices will disconnect. Only unchanged OpenTeam-managed mappings are removed."
                control={
                  <button
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => void change("disable")}
                  >
                    Disable
                  </button>
                }
              />
            )}
          </>
        ) : (
          <SettingsRow
            title="Configure on the server"
            description={
              <div className="space-y-2 py-2">
                <p>{result?.message || "Tailscale is managed on the server host."}</p>
                <code className="block select-all">openteam tailscale enable --https-port 443</code>
                <code className="block select-all">openteam tailscale status</code>
                <code className="block select-all">openteam tailscale disable</code>
                <p>
                  You can also choose Tailscale HTTPS in <code>openteam setup</code>.
                </p>
              </div>
            }
          />
        )}
      </SettingsGroup>
      {result?.canManage && !validPort && (
        <p className="px-2 text-xs text-destructive" role="alert">
          Enter an HTTPS port from 1 to 65535.
        </p>
      )}
      {busy && (
        <p className="px-2 text-xs text-foreground-secondary" role="status">
          {busy}
        </p>
      )}
      {(error || status?.issue) && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {error || status?.issue}
        </p>
      )}
      {notice && (
        <p className="px-2 text-xs text-foreground-secondary" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
