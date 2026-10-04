import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { onePasswordErrorMessage } from "@openteam/contracts/saved-logins";
import onePasswordIcon from "../../../assets/integrations/1password.png?inline";
import { PluginMark } from "./plugin-mark";

type Settings = Awaited<ReturnType<NonNullable<Window["openteam"]>["computer"]["getCapabilities"]>>;
const button = "inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-foreground/10 px-4 py-2 text-[13px] hover:bg-foreground/15 disabled:cursor-default disabled:opacity-45";
const input = "w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-[13px] outline-none focus:border-foreground/20";

export function OnePasswordSavedLogins({ logoUrl, onChanged }: { logoUrl: string | null; onChanged: () => void }) {
  const working = useRef(false);
  const revision = useRef(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<"intro" | "manual">("manual");
  const [token, setToken] = useState("");
  const [logins, setLogins] = useState<Array<{ credential_id: string; connection_id: string; title: string; sites: string[] }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const computer = window.openteam?.computer;
  useEffect(() => {
    let active = true;
    computer?.getCapabilities().then(value => active && revision.current === 0 && setSettings(value))
      .catch(() => active && setError("Could not load 1Password connections. Check your server connection and retry."));
    return () => { active = false; };
  }, [computer]);
  const apply = (value: Settings) => {
    revision.current++;
    setLogins(null);
    setSettings(value); setMode("intro"); setToken("");
    onChanged(); window.dispatchEvent(new Event("openteam:saved-logins-changed"));
  };
  const run = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) {
      setError(onePasswordErrorMessage(cause, "Could not connect 1Password. Check the token's vault access and your server connection, then retry."));
    } finally { working.current = false; setBusy(false); }
  };
  const connections = settings?.credentialProviders ?? [];
  return (
    <div className="bot-scrollbar min-h-0 flex-1 overflow-y-auto px-8 pb-8 max-sm:px-4">
      <div className="mb-5 flex items-center gap-3"><PluginMark logoUrl={logoUrl ?? onePasswordIcon} name="1Password" /><h2 className="text-[18px] font-medium">1Password</h2></div>
      <p className="mb-5 text-[13px] leading-5 text-foreground-secondary">Share existing 1Password vaults with OpenTeam through a service account token, so it can sign in to sites on its computer.</p>
      {mode === "manual" ? (
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void run(async () => { apply(await computer!.importSavedLoginToken(token.trim())); }); }}>
          <p className="text-[13px] leading-5">Paste a 1Password service account token with read access to the vaults you want to share. All vaults selected for that token will be connected. OpenTeam keeps the token encrypted and uses it to fill saved logins on its computer.</p>
          <ol className="list-decimal space-y-3 pl-4 text-[13px] leading-5 text-foreground-secondary">
            <li>Choose the existing vaults containing the logins you want OpenTeam to use. You can also create a separate vault if you prefer.</li>
            <li>On 1Password.com, open Developer → Service Accounts and create a service account. Select those vaults and grant read-only access. <a className="text-blue-500 underline" href="https://www.1password.dev/service-accounts/get-started" target="_blank" rel="noreferrer">How to create a service account</a></li>
            <li>Copy the token 1Password shows once and paste it here.</li>
          </ol>
          <p className="text-xs text-foreground-secondary">1Password does not allow service accounts to access built-in Personal, Private, Employee, or default Shared vaults. Choose another vault for those logins.</p>
          <label className="block space-y-2 text-[13px]">Service account token<input aria-label="Service account token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} className={input} /></label>
          <div className="flex gap-2"><button className={button} disabled={busy || !token.trim() || !computer} type="submit">Connect 1Password</button><button className={button} disabled={busy} type="button" onClick={() => { setToken(""); setMode("intro"); setError(""); }}>Cancel</button></div>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-5 text-foreground-secondary">Connect existing vaults with a service account token. Login reads use the service account on the server.</p>
          <button className={button} disabled={busy || !computer} onClick={() => { setMode("manual"); setToken(""); setError(""); }}>Add service account token</button>
          {!computer ? <p className="text-[13px]">Open the OpenTeam desktop app to connect 1Password.</p> : null}
        </div>
      )}
      {busy ? <div className="mt-4 flex items-center gap-2 text-[13px]" role="status"><LoaderCircle className="size-4 animate-spin" />Working…<button className={button} onClick={() => void computer?.cancelSavedLoginSetup()}>Cancel setup</button></div> : null}
      {error ? <p role="alert" className="mt-4 text-[13px] text-red-600">{error}</p> : null}
      {connections.length ? <section className="mt-6 space-y-4" aria-label="Connected 1Password vaults">
        {connections.map(row => {
          const id = `1password:${row.account}:${row.vault}`;
          return <div key={id} className="space-y-3 rounded-xl bg-foreground/5 p-4 text-[13px]">
            <div className="font-medium">{row.vaultName}</div><p className="text-foreground-secondary">{row.itemCount ?? 0} saved logins · {row.lifecycleState ?? "active"}</p>
            {row.lastSyncErrorCode ? <p className="text-red-600">Could not sync. Check 1Password access, then sync or renew.</p> : null}
            <p className="text-xs text-foreground-secondary">A saved login fills automatically when its website matches and there is a single matching login.</p>
            <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => apply(await computer!.syncSavedLogins(id)))}>Sync</button><button className={button} disabled={busy} onClick={() => { setMode("manual"); setToken(""); setError(""); }}>Renew access</button><button className={button} disabled={busy} onClick={() => void run(async () => apply(await computer!.updateCapabilities({ removeCredentialConnection: id })))}>Disconnect</button></div>
          </div>;
        })}
        <button className={button} disabled={busy} onClick={() => void run(async () => {
          const result = await computer!.listSavedLogins();
          if (!result.connected) throw new Error("Saved-login access unavailable");
          setLogins(result.credentials);
        })}>View saved logins</button>
        {logins ? <ul className="space-y-2 text-[13px]" aria-label="Saved logins">{logins.map(login => <li key={`${login.connection_id}:${login.credential_id}`}><span>{login.title}</span><span className="block text-xs text-foreground-secondary">{login.sites.join(", ") || "No website target"}</span></li>)}{!logins.length ? <li>No website logins were found. Add logins to a connected vault and sync.</li> : null}</ul> : null}
        <p className="text-xs text-foreground-secondary">Logins added to a connected vault become available when you sync. Disconnect removes OpenTeam's stored access. You can revoke the service account in 1Password.</p>
      </section> : null}
      <dl className="mt-8 grid grid-cols-2 gap-3 rounded-xl bg-foreground/5 p-4 text-[13px]"><dt className="text-foreground-secondary">Developer</dt><dd className="text-right">1Password</dd><dt className="text-foreground-secondary">Category</dt><dd className="text-right">Login and Credential Management</dd><dt className="text-foreground-secondary">Website</dt><dd className="text-right">1password.com</dd></dl>
    </div>
  );
}
