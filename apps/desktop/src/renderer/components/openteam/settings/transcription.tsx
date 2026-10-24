import {
  defaultTranscriptionSettings,
  type TranscriptionSettings,
  type TranscriptionSettingsView,
} from "@openteam/contracts/transcription";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../client/openteam-api";
import { requestRuntimeRefresh } from "../../../lib/runtime-refresh";
import {
  MODEL_TEST_DEADLINE_MS,
  requestErrorMessage,
  withDeadline,
} from "../../../lib/request-errors";
import {
  HOSTED_TRANSCRIPTION_ENDPOINTS,
  HOSTED_TRANSCRIPTION_MODELS,
} from "../../../lib/transcription-providers";
import { LoadingOrb } from "../../ui/loading-orb";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { primaryButton, secondaryButton } from "../model-setup";
import { ProviderMark } from "../setup/provider-marks";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";
import "./transcription.css";

const inputClass = "transcription-input";

export default function VoiceNotesSettings() {
  return <TranscriptionSettingsPanel />;
}

export function TranscriptionSettingsPanel() {
  const [saved, setSaved] = useState<TranscriptionSettingsView | null>(null);
  const [draft, setDraft] = useState<TranscriptionSettings>(defaultTranscriptionSettings);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "check" | null>("load");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setBusy("load");
    setMessage("");
    setFailed(false);
    try {
      const value = await withDeadline(() => api.transcriptionSettings());
      if (version !== loadVersion.current) return;
      setSaved(value);
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
      setFailed(false);
    } catch (error) {
      if (version !== loadVersion.current) return;
      setFailed(true);
      setMessage(requestErrorMessage(error, "Could not load transcription settings. Try again."));
    } finally {
      if (version === loadVersion.current) setBusy(null);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);
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
    saved &&
    (apiKey !== "" ||
      removeKey ||
      (["enabled", "provider", "baseUrl", "model", "language"] as const).some(
        (key) => saved[key] !== draft[key]
      ));
  const save = async () => {
    if (!saved) return;
    setBusy("save");
    setMessage("");
    try {
      const key = apiKey.trim();
      const value = await withDeadline(() =>
        api.updateTranscriptionSettings({
          ...draft,
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          language: draft.language.trim(),
          ...(key ? { apiKey: key } : removeKey ? { apiKey: null } : {}),
        })
      );
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
      setMessage(requestErrorMessage(error, "Could not save transcription settings. Try again."));
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy("check");
    setMessage("");
    try {
      const result = await withDeadline(() => api.checkTranscription(), MODEL_TEST_DEADLINE_MS);
      setFailed(result.level === "fail");
      setMessage(result.detail);
    } catch (error) {
      setFailed(true);
      setMessage(requestErrorMessage(error, "Could not check transcription. Try again."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="transcription-settings">
      <p className="mb-5 text-[13px] leading-5 text-foreground-secondary">
        Turn recordings into text you can review before sending. Shared by all apps connected to
        this server.
      </p>
      {!saved ? (
        <SettingsGroup>
          <div
            className="flex min-h-[72px] items-center gap-2 py-4 text-[13px] text-foreground-secondary"
            role={failed ? "alert" : "status"}
          >
            {busy ? (
              <>
                <LoadingOrb aria-hidden size={16} /> Loading voice notes…
              </>
            ) : (
              <>
                <span className="flex-1">{message}</span>
                <button className={secondaryButton} onClick={() => void load()} type="button">
                  Try again
                </button>
              </>
            )}
          </div>
        </SettingsGroup>
      ) : (
        <fieldset disabled={Boolean(busy)} className="min-w-0">
          <SettingsGroup>
            <SettingsRow
              title="Voice notes"
              description="Enable transcription for recorded messages on desktop and iPhone."
              control={
                <InteractiveSwitch
                  label="Enable voice notes"
                  checked={draft.enabled}
                  onChange={(value) => change("enabled", value)}
                />
              }
            />
          </SettingsGroup>
          <SectionLabel>Transcription service</SectionLabel>
          <SettingsGroup className="transcription-fields">
            <SettingsRow
              title="Provider"
              className="transcription-setting-row"
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
                    className="transcription-input"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">
                      <span className="flex items-center gap-2">
                        <ProviderMark id="openai" /> OpenAI
                      </span>
                    </SelectItem>
                    <SelectItem value="deepgram">
                      <span className="flex items-center gap-2">
                        <ProviderMark id="deepgram" /> Deepgram
                      </span>
                    </SelectItem>
                    <SelectItem value="openai-compatible">Custom / OpenAI-compatible</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            {draft.provider === "openai-compatible" ? (
              <SettingsRow
                title="Base URL"
                className="transcription-setting-row"
                description="An audio service reachable from your OpenTeam server."
                control={
                  <input
                    className={inputClass}
                    aria-label="Transcription base URL"
                    inputMode="url"
                    spellCheck={false}
                    value={draft.baseUrl}
                    placeholder="http://audio-server:8000/v1"
                    onChange={(e) => change("baseUrl", e.target.value)}
                  />
                }
              />
            ) : null}
            <SettingsRow
              title="Model"
              className="transcription-setting-row"
              control={
                <input
                  className={inputClass}
                  aria-label="Transcription model"
                  spellCheck={false}
                  value={draft.model}
                  placeholder="Model ID"
                  onChange={(e) => change("model", e.target.value)}
                />
              }
            />
          </SettingsGroup>
          <SectionLabel>Credentials and language</SectionLabel>
          <SettingsGroup className="transcription-fields">
            <SettingsRow
              title="API key"
              className="transcription-setting-row"
              description={
                hasSavedKey
                  ? "A key is saved. Leave blank to keep it."
                  : "Separate from chat sign-in. Keys stay on your server."
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
                    if (e.target.value) setRemoveKey(false);
                    setMessage("");
                  }}
                />
              }
            />
            {saved.hasApiKey && sameEndpoint ? (
              <SettingsRow
                title="Remove saved key"
                control={
                  <InteractiveSwitch
                    label="Remove transcription API key"
                    checked={removeKey}
                    onChange={(value) => {
                      setRemoveKey(value);
                      if (value) setApiKey("");
                      setMessage("");
                    }}
                  />
                }
              />
            ) : null}
            <SettingsRow
              title="Language"
              className="transcription-setting-row"
              description="Leave blank to detect automatically, or use a code such as en."
              control={
                <input
                  className={inputClass}
                  aria-label="Transcription language"
                  spellCheck={false}
                  value={draft.language}
                  placeholder="Automatic"
                  onChange={(e) => change("language", e.target.value)}
                />
              }
            />
          </SettingsGroup>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={Boolean(busy) || Boolean(changed) || !saved.configured}
              onClick={() => void check()}
            >
              {busy === "check" ? <LoadingOrb aria-hidden size={14} /> : null} Test connection
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={Boolean(busy) || !changed}
              onClick={() => void save()}
            >
              {busy === "save" ? <LoadingOrb aria-hidden inverse size={14} /> : null} Save
            </button>
          </div>
          {message ? (
            <p
              role={failed ? "alert" : "status"}
              className={`mt-3 text-[12px] leading-5 ${failed ? "text-red-600 dark:text-red-400" : "text-foreground-secondary"}`}
            >
              {message}
            </p>
          ) : null}
        </fieldset>
      )}
    </div>
  );
}
