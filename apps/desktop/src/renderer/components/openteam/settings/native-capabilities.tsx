import { useEffect, useState } from "react";
import { SectionLabel, SettingsGroup } from "./ui";
type Settings = Awaited<
  ReturnType<NonNullable<Window["openteam"]>["permissions"]["getCapabilities"]>
>;
export function NativeCapabilitySettings() {
  const [logins, setLogins] = useState<
    | Awaited<
        ReturnType<NonNullable<Window["openteam"]>["permissions"]["listSavedLogins"]>
      >["credentials"]
    | null
  >(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [account, setAccount] = useState("");
  const [vault, setVault] = useState("OpenTeam");
  const [accounts, setAccounts] = useState<Array<{id:string;label:string}>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    window.openteam?.permissions
      .getCapabilities()
      .then((value) => {
        if (active) {
          setSettings(value);
          setAccount(value.credentialProvider?.account ?? "");
          setVault(value.credentialProvider?.vaultName ?? "OpenTeam");
        }
      })
      .catch(() => active && setError("Could not load native access settings"));
    return () => {
      active = false;
    };
  }, []);
  const update = async (
    input: Parameters<NonNullable<Window["openteam"]>["permissions"]["updateCapabilities"]>[0]
  ) => {
    setBusy(true);
    setError("");
    try {
      const value = await window.openteam!.permissions.updateCapabilities(input);
      setSettings(value);
      if (input.revoke === "credentials") setLogins(null);
    } catch {
      setError("Could not save native access settings. Verify the account and vault IDs.");
    } finally {
      setBusy(false);
    }
  };
  const connect = async (renew?: {account:string;vault:string;vaultName?:string}) => {
    setBusy(true); setError("");
    try { setSettings(await window.openteam!.permissions.connectSavedLogins({ account: renew?.account ?? account, vaultName: renew?.vaultName ?? vault, ...(renew ? { connectionId: `1password:${renew.account}:${renew.vault}` } : {}) })); }
    catch { setError("Could not finish 1Password setup. Approve setup in 1Password, or retry completion if the server connection was interrupted."); }
    finally { setBusy(false); }
  };
  const button = "rounded-lg bg-foreground/10 px-3 py-1.5 text-xs disabled:opacity-40";
  return (
    <>
      <SectionLabel>Saved logins and Mac access</SectionLabel>
      <SettingsGroup>
        <div className="space-y-3 py-3 text-sm">
          <p>
            Connect 1Password vaults for saved website logins. Enable the 1Password CLI
            integration in the 1Password desktop app first. Passwords stay out of conversations.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy} onClick={async () => {
              setBusy(true); setError("");
              try { const rows = await window.openteam!.permissions.savedLoginAccounts(); setAccounts(rows); setAccount(rows[0]?.id ?? ""); }
              catch { setError("Install the signed 1Password CLI and enable its desktop integration, then try again."); }
              finally { setBusy(false); }
            }}>Choose 1Password account</button>
            {accounts.length > 0 ? <select aria-label="1Password account" value={account} onChange={e => setAccount(e.target.value)} className="rounded border bg-background p-2">{accounts.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select> : null}
            <input aria-label="1Password vault name" placeholder="Vault name" value={vault} onChange={e => setVault(e.target.value)} className="rounded border bg-background p-2" />
            <button className={button} disabled={busy || !account || !vault.trim()} onClick={() => void connect()}>Connect vault</button>
          </div>
          <p className="text-xs text-foreground-secondary">Connect an existing vault by name or create a new one. OpenTeam provisions read-only access for 90 days. Only logins in this vault become available to bots; renew or disconnect below.</p>
          {error ? <button className={button} disabled={busy} onClick={async () => {
            setBusy(true);
            try { setSettings(await window.openteam!.permissions.finishSavedLoginConnection()); setError(""); }
            catch { setError("Connection completion is still unavailable. Try again when your server is reachable."); }
            finally { setBusy(false); }
          }}>Retry connection completion</button> : null}
          <p className="text-xs text-foreground-secondary">
            Each login fill asks for approval unless you have enabled automatic filling for that
            item. Chrome cookie imports ask for the specific profile and site. Messages sends ask for review unless you have explicitly allowed the recipient or enabled all sends below.
          </p>
          {(settings?.credentialProviders ?? (settings?.credentialProvider ? [settings.credentialProvider] : [])).map(provider => <div key={`${provider.account}:${provider.vault}`} className="flex items-center justify-between gap-2 text-xs">
            <span>{provider.vaultName ?? provider.vault}{provider.broker ? " · read-only service account" : " · legacy desktop access"}</span>
            {provider.broker ? <button className={button} disabled={busy} onClick={() => void connect(provider)}>Renew access</button> : null}
            <button className={button} disabled={busy} onClick={()=>void update({removeCredentialConnection:`1password:${provider.account}:${provider.vault}`})}>Disconnect vault</button>
          </div>)}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={settings?.messagesSendAll ?? false} disabled={busy || !settings} onChange={event=>void update({messagesSendAll:event.target.checked})}/>
            <span>Allow all Messages sends without asking each time<span className="block text-xs text-foreground-secondary">Applies to all bots and recipients on this Mac. Turn this off to restore per-message or per-recipient approval.</span></span>
          </label>
          {settings?.credentialProvider && (
            <div className="space-y-2">
              <button
                className={button}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const result = await window.openteam!.permissions.listSavedLogins();
                    setLogins(result.credentials);
                    if (!result.connected)
                      setError("Unlock 1Password and verify the configured vault.");
                  } catch {
                    setError(
                      "Could not load saved login metadata. Unlock 1Password and verify the configured vault."
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Choose automatic logins
              </button>
              {logins?.map((login) => {
                const key = `${login.connection_id}:${login.credential_id}`;
                return (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={settings.autoFill.includes(key)}
                      onChange={(e) =>
                        void update({
                          autoFill: e.target.checked
                            ? [...settings.autoFill, key]
                            : settings.autoFill.filter((id) => id !== key),
                        })
                      }
                    />
                    <span>
                      {login.title}
                      <span className="block text-xs text-foreground-secondary">
                        {login.sites.join(", ") || "No website target; cannot auto-fill"}
                      </span>
                    </span>
                  </label>
                );
              })}
              {logins?.length === 0 && <p>No website logins were found in this vault.</p>}
            </div>
          )}
          {settings?.credentialProvider && (
            <button
              className={button}
              disabled={busy}
              onClick={() => void update({ revoke: "credentials" })}
            >
              Disconnect saved logins
            </button>
          )}
          <div className="flex gap-2">
            <button
              className={button}
              disabled={busy || !settings?.cookieGrants.length}
              onClick={() => void update({ revoke: "cookies" })}
            >
              Revoke remembered cookie imports ({settings?.cookieGrants.length ?? 0})
            </button>
            <button
              className={button}
              disabled={busy || !settings?.messagesGrants.length}
              onClick={() => void update({ revoke: "messages" })}
            >
              Revoke Contacts / Messages access ({settings?.messagesGrants.length ?? 0})
            </button>
          </div>
          <p className="text-xs text-foreground-secondary">
            Revoking cookie imports prevents future imports. Sign out in the bot browser to end
            sessions already imported.
          </p>
          {error ? <button className={button} disabled={busy} onClick={async () => {
            try { await window.openteam!.permissions.restartSavedLoginSetup(); setError(""); }
            catch { setError("Finish the pending connection before starting another setup."); }
          }}>I reviewed the service accounts in 1Password — restart setup</button> : null}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
        </div>
      </SettingsGroup>
    </>
  );
}
