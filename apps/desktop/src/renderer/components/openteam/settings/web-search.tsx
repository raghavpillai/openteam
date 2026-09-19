import {
  SEARCH_PROVIDERS,
  FETCH_PROVIDERS,
  type FetchProvider,
  type WebFetchSettingsView,
  type SearchProvider,
  type WebSearchSettingsView,
} from "@openteam/contracts/web-search";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

const inputClass =
  "h-8 w-[270px] max-w-full rounded-[8px] border border-black/10 bg-background px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/10";

function ProviderSettingsPanel({ kind }: { kind: "search" | "fetch" }) {
  const label = kind === "search" ? "Search" : "Fetch";
  const providers = kind === "search" ? SEARCH_PROVIDERS : FETCH_PROVIDERS;
  const [saved, setSaved] = useState<WebSearchSettingsView | WebFetchSettingsView | null>(null);
  const [provider, setProvider] = useState<SearchProvider | FetchProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    (kind === "search" ? api.webSearchSettings() : api.webFetchSettings())
      .then((value) => {
        if (!active) return;
        setSaved(value);
        setProvider(value.provider);
      })
      .catch(() => {
        if (active)
          setMessage(
            `Could not load web ${kind} settings. Check the server connection and version.`
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [kind]);

  const sameProvider = provider === saved?.provider;
  const hasSavedKey = sameProvider && saved?.hasApiKey && !removeKey;
  const changed = Boolean(saved && (!sameProvider || apiKey.trim() || removeKey));
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const input = {
        provider,
        ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const value =
        kind === "search"
          ? await api.updateWebSearchSettings({
              ...input,
              provider: provider as SearchProvider | null,
            })
          : await api.updateWebFetchSettings({
              ...input,
              provider: provider as FetchProvider | null,
            });
      setSaved(value);
      setProvider(value.provider);
      setApiKey("");
      setRemoveKey(false);
      setMessage(
        value.configured
          ? `Saved. The next ${kind} will use these settings.`
          : `Saved. Web ${kind} is not configured. Select a provider and save its required settings.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not save web ${kind} settings.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionLabel>Web {kind}</SectionLabel>
      <fieldset disabled={busy || !saved} className="min-w-0">
        <SettingsGroup>
          <SettingsRow
            title="Status"
            description={
              saved?.provider === "builtin"
                ? "Fetches public pages directly. No API key required."
                : saved?.configured
                  ? `Configured for all bots. Provider access and quota are checked on each ${kind}.`
                  : `Not configured. Bots can discover Web${label} and see setup guidance.`
            }
          />
          <SettingsRow
            title={`${label} provider`}
            control={
              <select
                className={inputClass}
                aria-label={`${label} provider`}
                value={provider ?? ""}
                onChange={(event) => {
                  setProvider(
                    (event.target.value || null) as SearchProvider | FetchProvider | null
                  );
                  setApiKey("");
                  setRemoveKey(false);
                  setMessage("");
                }}
              >
                <option value="">Not configured</option>
                {Object.entries(providers).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            }
          />
          <SettingsRow
            title="API key"
            description={
              provider === "builtin"
                ? "The built-in fetcher does not use an API key."
                : hasSavedKey
                  ? "A key is saved. Leave blank to keep it. Stored in your server’s database."
                  : "Enter a key for the selected provider. Stored in your server’s database."
            }
            control={
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                aria-label={`${label} API key`}
                disabled={!provider || provider === "builtin" || removeKey}
                value={apiKey}
                placeholder={hasSavedKey ? "Key saved" : "API key"}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setMessage("");
                }}
              />
            }
          />
          {saved?.hasApiKey && sameProvider ? (
            <SettingsRow
              title="Remove saved key"
              control={
                <input
                  type="checkbox"
                  aria-label={`Remove ${kind} API key`}
                  checked={removeKey}
                  onChange={(event) => {
                    setRemoveKey(event.target.checked);
                    setApiKey("");
                  }}
                />
              }
            />
          ) : null}
          <div className="flex justify-end border-t border-black/10 py-3 dark:border-white/10">
            <button
              type="button"
              disabled={busy || !changed}
              onClick={() => void save()}
              className="rounded-[8px] bg-black px-3 py-2 text-[12px] text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Save web {kind}
            </button>
          </div>
        </SettingsGroup>
      </fieldset>
      {message ? (
        <p role="status" className="px-2 py-2 text-[12px] text-foreground-secondary">
          {message}
        </p>
      ) : null}
    </>
  );
}

export function WebSearchSettingsPanel() {
  return (
    <>
      <ProviderSettingsPanel kind="search" />
      <ProviderSettingsPanel kind="fetch" />
    </>
  );
}
