import {
  defaultTranscriptionSettings,
  type TranscriptionSettings,
  type TranscriptionSettingsView,
} from "@openteam/contracts/transcription";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

const inputClass =
  "h-8 w-[270px] max-w-full rounded-[8px] border border-black/10 bg-background px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/10";
const buttonClass =
  "rounded-[8px] bg-black px-3 py-2 text-[12px] text-white disabled:opacity-40 dark:bg-white dark:text-black";

export function TranscriptionSettingsPanel() {
  const [saved, setSaved] = useState<TranscriptionSettingsView | null>(null);
  const [draft, setDraft] = useState<TranscriptionSettings>(defaultTranscriptionSettings);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    api
      .transcriptionSettings()
      .then((value) => {
        if (active) {
          setSaved(value);
          setDraft(value);
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "Could not load transcription settings. Check the server connection and version."
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const change = <K extends keyof TranscriptionSettings>(
    key: K,
    value: TranscriptionSettings[K]
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage("");
  };
  const sameEndpoint = saved?.provider === draft.provider && saved.baseUrl === draft.baseUrl;
  const hasSavedKey = sameEndpoint && saved?.hasApiKey && !removeKey;
  const changed =
    !saved ||
    apiKey !== "" ||
    removeKey ||
    (["enabled", "provider", "baseUrl", "model", "language"] as const).some(
      (key) => saved[key] !== draft[key]
    );
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const value = await api.updateTranscriptionSettings({
        ...draft,
        ...(apiKey ? { apiKey } : removeKey ? { apiKey: null } : {}),
      });
      setSaved(value);
      setDraft(value);
      setApiKey("");
      setRemoveKey(false);
      setMessage(
        value.configured
          ? "Saved. Voice notes are enabled on connected devices."
          : "Saved. Voice notes are disabled."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save transcription settings.");
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    setMessage("");
    try {
      setMessage((await api.checkTranscription()).detail);
    } catch {
      setMessage("Could not check transcription. Check the server connection.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionLabel>Transcription</SectionLabel>
      <fieldset disabled={busy} className="min-w-0">
        <SettingsGroup>
          <SettingsRow
            title="Voice notes"
            description="Record a message, then let your server transcribe it. Applies to desktop and iPhone."
            control={
              <input
                type="checkbox"
                aria-label="Enable voice notes"
                checked={draft.enabled}
                onChange={(e) => change("enabled", e.target.checked)}
              />
            }
          />
          <SettingsRow
            title="Provider"
            control={
              <select
                className={inputClass}
                aria-label="Transcription provider"
                value={draft.provider}
                onChange={(e) => {
                  const provider = e.target.value as TranscriptionSettings["provider"];
                  setDraft((current) => ({
                    ...current,
                    provider,
                    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "",
                    model: provider === "openai" ? "whisper-1" : "",
                  }));
                  setApiKey("");
                  setRemoveKey(false);
                  setMessage("");
                }}
              >
                <option value="openai-compatible">Custom / OpenAI-compatible</option>
                <option value="openai">OpenAI</option>
              </select>
            }
          />
          <SettingsRow
            title="Base URL"
            description="The address your OpenTeam server uses to reach the audio service."
            control={
              <input
                className={inputClass}
                aria-label="Transcription base URL"
                disabled={draft.provider === "openai"}
                value={draft.baseUrl}
                placeholder="http://audio-server:8000/v1"
                onChange={(e) => change("baseUrl", e.target.value)}
              />
            }
          />
          <SettingsRow
            title="Model"
            control={
              <input
                className={inputClass}
                aria-label="Transcription model"
                value={draft.model}
                placeholder="Model ID"
                onChange={(e) => change("model", e.target.value)}
              />
            }
          />
          <SettingsRow
            title="API key"
            description={
              hasSavedKey
                ? "A key is saved. Leave blank to keep it."
                : "Required for OpenAI; optional for private services."
            }
            control={
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                aria-label="Transcription API key"
                value={apiKey}
                placeholder={hasSavedKey ? "Key saved" : "API key"}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setMessage("");
                }}
              />
            }
          />
          {saved?.hasApiKey && sameEndpoint ? (
            <SettingsRow
              title="Remove saved key"
              control={
                <input
                  aria-label="Remove transcription API key"
                  type="checkbox"
                  checked={removeKey}
                  onChange={(e) => setRemoveKey(e.target.checked)}
                />
              }
            />
          ) : null}
          <SettingsRow
            title="Language"
            description="Leave blank for automatic detection, or enter a language code such as en."
            control={
              <input
                className={inputClass}
                aria-label="Transcription language"
                value={draft.language}
                placeholder="Automatic"
                onChange={(e) => change("language", e.target.value)}
              />
            }
          />
          <div className="flex items-center justify-end gap-2 border-t border-black/10 py-3 dark:border-white/10">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || changed || !saved?.configured}
              onClick={() => void check()}
            >
              Test connection
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || !changed}
              onClick={() => void save()}
            >
              Save transcription
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
