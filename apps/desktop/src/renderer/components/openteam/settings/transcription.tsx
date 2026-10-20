import {
  defaultTranscriptionSettings,
  type TranscriptionSettings,
  type TranscriptionSettingsView,
} from "@openteam/contracts/transcription";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { requestRuntimeRefresh } from "../../../lib/runtime-refresh";
import {
  HOSTED_TRANSCRIPTION_ENDPOINTS,
  HOSTED_TRANSCRIPTION_MODELS,
} from "../../../lib/transcription-providers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { primaryButton, secondaryButton } from "../model-setup";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";

const inputClass =
  "h-8 w-[270px] max-w-full rounded-[8px] border border-black/10 bg-background px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/10";

export function TranscriptionSettingsPanel() {
  const [saved, setSaved] = useState<TranscriptionSettingsView | null>(null);
  const [draft, setDraft] = useState<TranscriptionSettings>(defaultTranscriptionSettings);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  // Failures read as errors, not as neutral status text.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .transcriptionSettings()
      .then((value) => {
        if (active) {
          setSaved(value);
          // A server that never set up voice notes starts from OpenAI, like the setup wizard.
          const untouched = !value.configured && !value.baseUrl && !value.hasApiKey;
          setDraft(
            untouched
              ? {
                  ...value,
                  provider: "openai",
                  baseUrl: HOSTED_TRANSCRIPTION_ENDPOINTS.openai ?? "",
                  model: HOSTED_TRANSCRIPTION_MODELS.openai ?? "",
                }
              : value
          );
        }
      })
      .catch(() => {
        if (!active) return;
        setFailed(true);
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
      requestRuntimeRefresh();
      setFailed(false);
      setMessage(
        value.configured
          ? "Saved. Voice notes are enabled on connected devices."
          : "Saved. Voice notes are disabled."
      );
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save transcription settings.");
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await api.checkTranscription();
      setFailed(result.level === "fail");
      setMessage(result.detail);
    } catch {
      setFailed(true);
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
              <InteractiveSwitch
                label="Enable voice notes"
                checked={draft.enabled}
                onChange={(value) => change("enabled", value)}
              />
            }
          />
          <SettingsRow
            title="Provider"
            control={
              <Select
                value={draft.provider}
                onValueChange={(value) => {
                  const provider = value as TranscriptionSettings["provider"];
                  setDraft((current) => ({
                    ...current,
                    provider,
                    baseUrl: HOSTED_TRANSCRIPTION_ENDPOINTS[provider] ?? "",
                    model: HOSTED_TRANSCRIPTION_MODELS[provider] ?? "",
                  }));
                  setApiKey("");
                  setRemoveKey(false);
                  setMessage("");
                }}
              >
                <SelectTrigger
                  aria-label="Transcription provider"
                  className="h-7 w-[270px] max-w-full rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="deepgram">Deepgram</SelectItem>
                  <SelectItem value="openai-compatible">Custom / OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            title="Base URL"
            description="The address your OpenTeam server uses to reach the audio service."
            control={
              <input
                className={inputClass}
                aria-label="Transcription base URL"
                disabled={draft.provider !== "openai-compatible"}
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
                : "Required for OpenAI and Deepgram; optional for private services."
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
                <InteractiveSwitch
                  label="Remove transcription API key"
                  checked={removeKey}
                  onChange={setRemoveKey}
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
          <div className="flex items-center justify-end gap-2 border-t border-black/[0.065] py-3 dark:border-white/[0.07]">
            <button
              type="button"
              className={secondaryButton}
              disabled={busy || changed || !saved?.configured}
              onClick={() => void check()}
            >
              Test connection
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy || !changed}
              onClick={() => void save()}
            >
              Save transcription
            </button>
          </div>
        </SettingsGroup>
      </fieldset>
      {message ? (
        <p
          role={failed ? "alert" : "status"}
          className={`px-2 py-2 text-[12px] ${failed ? "text-red-600 dark:text-red-400" : "text-foreground-secondary"}`}
        >
          {message}
        </p>
      ) : null}
    </>
  );
}
