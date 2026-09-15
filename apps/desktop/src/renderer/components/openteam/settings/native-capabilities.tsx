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
  const [vault, setVault] = useState("");
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
          setVault(value.credentialProvider?.vault ?? "");
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
  const button = "rounded-lg bg-foreground/10 px-3 py-1.5 text-xs disabled:opacity-40";
  return (
    <>
      <SectionLabel>Saved logins and Mac access</SectionLabel>
      <SettingsGroup>
        <div className="space-y-3 py-3 text-sm">
          <p>
            Connect a specific 1Password vault for saved website logins. Enable the 1Password CLI
            integration in the 1Password desktop app first. Passwords stay out of conversations.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              aria-label="1Password account ID"
              placeholder="Account ID"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="rounded border bg-background p-2"
            />
            <input
              aria-label="1Password vault ID"
              placeholder="Vault ID"
              value={vault}
              onChange={(e) => setVault(e.target.value)}
              className="rounded border bg-background p-2"
            />
            <button
              className={button}
              disabled={busy || !account.trim() || !vault.trim()}
              onClick={() => void update({ account, vault })}
            >
              Connect vault
            </button>
          </div>
          <p className="text-xs text-foreground-secondary">
            Each login fill asks for approval unless you have enabled automatic filling for that
            item. Chrome cookie imports ask for the specific profile and site. Messages sends always
            show the recipient and full message for review.
          </p>
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
