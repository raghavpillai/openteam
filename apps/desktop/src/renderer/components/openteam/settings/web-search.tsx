import {
  SEARCH_PROVIDERS,
  type SearchProvider,
  type WebSearchSettingsView,
} from "@openteam/contracts/web-search";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

const inputClass =
  "h-8 w-[270px] max-w-full rounded-[8px] border border-black/10 bg-background px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/10";

export function WebSearchSettingsPanel() {
  const [saved, setSaved] = useState<WebSearchSettingsView | null>(null);
  const [provider, setProvider] = useState<SearchProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    api
      .webSearchSettings()
      .then((value) => {
        if (!active) return;
        setSaved(value);
        setProvider(value.provider);
      })
      .catch(() => {
        if (active)
          setMessage(
            "Could not load web search settings. Check the server connection and version."
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const sameProvider = provider === saved?.provider;
  const hasSavedKey = sameProvider && saved?.hasApiKey && !removeKey;
  const changed = Boolean(saved && (!sameProvider || apiKey.trim() || removeKey));
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const value = await api.updateWebSearchSettings({
        provider,
        ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSaved(value);
      setProvider(value.provider);
      setApiKey("");
      setRemoveKey(false);
      setMessage(
        value.configured
          ? "Saved. The next search will use these settings."
          : "Saved. Web search will show setup guidance until a provider and key are saved."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save web search settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionLabel>Web search</SectionLabel>
      <fieldset disabled={busy || !saved} className="min-w-0">
        <SettingsGroup>
          <SettingsRow
            title="Status"
            description={
              saved?.configured
                ? "Configured for all bots. Provider access and quota are checked when searching."
                : "Not configured. Bots can discover WebSearch and see setup guidance."
            }
          />
          <SettingsRow
            title="Search provider"
            control={
              <select
                className={inputClass}
                aria-label="Search provider"
                value={provider ?? ""}
                onChange={(event) => {
                  setProvider((event.target.value || null) as SearchProvider | null);
                  setApiKey("");
                  setRemoveKey(false);
                  setMessage("");
                }}
              >
                <option value="">Not configured</option>
                {Object.entries(SEARCH_PROVIDERS).map(([id, label]) => (
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
              hasSavedKey
                ? "A key is saved. Leave blank to keep it. Stored in your server’s database."
                : "Enter a key for the selected provider. Stored in your server’s database."
            }
            control={
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                aria-label="Search API key"
                disabled={!provider || removeKey}
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
                  aria-label="Remove search API key"
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
              Save web search
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
