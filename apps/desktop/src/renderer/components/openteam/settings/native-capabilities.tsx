import { useCallback, useEffect, useState } from "react";
import { SectionLabel, SettingsGroup } from "./ui";
type Settings = Awaited<ReturnType<NonNullable<Window["openteam"]>["permissions"]["getCapabilities"]>>;
export function NativeCapabilitySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    void window.openteam?.permissions.getCapabilities().then(setSettings)
      .catch(() => setError("Could not load computer access settings. Check your server connection."));
  }, []);
  useEffect(refresh, [refresh]);
  const update = async (input: Parameters<NonNullable<Window["openteam"]>["permissions"]["updateCapabilities"]>[0]) => {
    setBusy(true); setError("");
    try { setSettings(await window.openteam!.permissions.updateCapabilities(input)); }
    catch { setError("Could not save computer access settings. Check your connection and retry."); }
    finally { setBusy(false); }
  };
  return <>
    <SectionLabel>Mac access</SectionLabel>
    <SettingsGroup><div className="space-y-4 py-4 text-sm">
      <label className="flex items-start gap-2"><input type="checkbox" disabled={busy || !settings} checked={settings?.messagesSendAll ?? false} onChange={event => void update({ messagesSendAll: event.target.checked })} /><span>Allow all Messages sends without asking each time<span className="block text-xs text-foreground-secondary">Applies to all bots and recipients on this Mac. Turn this off to restore per-message or per-recipient approval.</span></span></label>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg bg-foreground/10 px-3 py-1.5 text-xs disabled:opacity-40" disabled={busy || !settings?.cookieGrants.length} onClick={() => void update({ revoke: "cookies" })}>Revoke remembered cookie imports ({settings?.cookieGrants.length ?? 0})</button>
        <button className="rounded-lg bg-foreground/10 px-3 py-1.5 text-xs disabled:opacity-40" disabled={busy || !settings?.messagesGrants.length} onClick={() => void update({ revoke: "messages" })}>Revoke Contacts / Messages access ({settings?.messagesGrants.length ?? 0})</button>
      </div>
      <p className="text-xs text-foreground-secondary">Chrome cookie imports ask for the specific profile and site. Revoking imports prevents future imports. Sign out in the bot browser to end sessions already imported.</p>
      {error ? <p role="alert" className="text-red-600">{error}</p> : null}
    </div></SettingsGroup>
  </>;
}
