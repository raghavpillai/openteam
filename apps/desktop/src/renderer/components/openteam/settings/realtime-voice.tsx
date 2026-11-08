import type {
  VoiceProviderId,
  VoiceSettingsInput,
  VoiceSettingsView,
} from "@openteam/contracts/voice";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { AudioLines, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { LoadingOrb } from "../../ui/loading-orb";
import {
  InteractiveSwitch,
  SettingsGroup,
  SettingsIntro,
  SettingsRow,
  settingsInput,
  settingsPrimaryButton,
  settingsSecondaryButton,
  settingsSelect,
} from "./ui";
import { SettingsSelectContent } from "./select-content";
import { VolcengineVoiceSelect } from "./volcengine-voice-select";

type Draft = {
  enabled: boolean;
  defaultProvider: VoiceProviderId;
  volcengineApiKey: string;
  volcengineBaseUrl: string;
  volcengineSttUrl: string;
  volcengineTtsUrl: string;
  volcengineSttResourceId: string;
  volcengineTtsResourceId: string;
  deepgramApiKey: string;
  deepgramBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  language: string;
  narrationModel: string;
};

/** Display-only mirror of the server's per-provider defaults, shown as placeholders for blank fields. */
const speechDefaults: Record<VoiceProviderId, Pick<Draft, "sttModel" | "ttsModel" | "voice" | "language">> = {
  volcengine: { sttModel: "bigmodel", ttsModel: "", voice: "zh_female_vv_uranus_bigtts", language: "zh-CN" },
  deepgram: { sttModel: "nova-3", ttsModel: "aura-2-thalia-en", voice: "alloy", language: "en-US" },
};

const providerLabel: Record<VoiceProviderId, string> = {
  volcengine: "Volcengine",
  deepgram: "Deepgram",
};

function draftFromView(view: VoiceSettingsView): Draft {
  return {
    enabled: view.enabled,
    defaultProvider: view.defaultProvider,
    volcengineApiKey: "",
    volcengineBaseUrl: view.providers.volcengine.baseUrl ?? "",
    volcengineSttUrl: view.providers.volcengine.sttUrl ?? "",
    volcengineTtsUrl: view.providers.volcengine.ttsUrl ?? "",
    volcengineSttResourceId: view.providers.volcengine.sttResourceId ?? "",
    volcengineTtsResourceId: view.providers.volcengine.ttsResourceId ?? "",
    deepgramApiKey: "",
    deepgramBaseUrl: view.providers.deepgram.baseUrl ?? "",
    sttModel: view.sttModel,
    ttsModel: view.ttsModel,
    voice: view.voice,
    language: view.language,
    narrationModel: view.narrationModel,
  };
}

export default function RealtimeVoiceSettings() {
  const [saved, setSaved] = useState<VoiceSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removeVolcengineKey, setRemoveVolcengineKey] = useState(false);
  const [removeDeepgramKey, setRemoveDeepgramKey] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | null>("load");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  const load = async () => {
    setBusy("load");
    setError(false);
    setMessage("");
    try {
      const value = await api.voice.settings();
      setSaved(value);
      setDraft(draftFromView(value));
    } catch (cause) {
      setError(true);
      setMessage(clientErrorMessage(cause, "Could not load realtime voice settings."));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!draft || !saved) {
    return (
      <SettingsGroup>
        <div className="flex min-h-[72px] items-center gap-2 py-4 text-[13px] text-foreground-secondary" role={error ? "alert" : "status"}>
          {busy ? <><LoadingOrb aria-hidden size={16} /> Loading realtime voice settings…</> : <><span className="flex-1">{message}</span><button className={settingsSecondaryButton} onClick={() => void load()} type="button">Try again</button></>}
        </div>
      </SettingsGroup>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setMessage("");
  };

  const changed =
    draft.enabled !== saved.enabled ||
    draft.defaultProvider !== saved.defaultProvider ||
    draft.volcengineBaseUrl !== (saved.providers.volcengine.baseUrl ?? "") ||
    draft.volcengineSttUrl !== (saved.providers.volcengine.sttUrl ?? "") ||
    draft.volcengineTtsUrl !== (saved.providers.volcengine.ttsUrl ?? "") ||
    draft.volcengineSttResourceId !== (saved.providers.volcengine.sttResourceId ?? "") ||
    draft.volcengineTtsResourceId !== (saved.providers.volcengine.ttsResourceId ?? "") ||
    draft.deepgramBaseUrl !== (saved.providers.deepgram.baseUrl ?? "") ||
    draft.sttModel !== saved.sttModel ||
    draft.ttsModel !== saved.ttsModel ||
    draft.voice !== saved.voice ||
    draft.language !== saved.language ||
    draft.narrationModel !== saved.narrationModel ||
    Boolean(draft.volcengineApiKey.trim()) ||
    Boolean(draft.deepgramApiKey.trim()) ||
    removeVolcengineKey ||
    removeDeepgramKey;

  const save = async () => {
    setBusy("save");
    setError(false);
    setMessage("");
    try {
      const input: VoiceSettingsInput = {
        enabled: draft.enabled,
        defaultProvider: draft.defaultProvider,
        volcengineBaseUrl: draft.volcengineBaseUrl.trim(),
        volcengineSttUrl: draft.volcengineSttUrl.trim(),
        volcengineTtsUrl: draft.volcengineTtsUrl.trim(),
        volcengineSttResourceId: draft.volcengineSttResourceId.trim(),
        volcengineTtsResourceId: draft.volcengineTtsResourceId.trim(),
        deepgramBaseUrl: draft.deepgramBaseUrl.trim(),
        sttModel: draft.sttModel.trim(),
        ttsModel: draft.ttsModel.trim(),
        voice: draft.voice.trim(),
        language: draft.language.trim(),
        narrationModel: draft.narrationModel.trim(),
        ...(removeVolcengineKey ? { volcengineApiKey: null } : draft.volcengineApiKey.trim() ? { volcengineApiKey: draft.volcengineApiKey.trim() } : {}),
        ...(removeDeepgramKey ? { deepgramApiKey: null } : draft.deepgramApiKey.trim() ? { deepgramApiKey: draft.deepgramApiKey.trim() } : {}),
      };
      const value = await api.voice.updateSettings(input);
      setSaved(value);
      setDraft(draftFromView(value));
      setRemoveVolcengineKey(false);
      setRemoveDeepgramKey(false);
      setMessage(value.enabled ? "Realtime voice settings saved." : "Realtime voice is disabled.");
    } catch (cause) {
      setError(true);
      setMessage(clientErrorMessage(cause, "Could not save realtime voice settings."));
    } finally {
      setBusy(null);
    }
  };

  const keyField = (
    provider: "volcengine" | "deepgram",
    label: string,
    savedKey: boolean,
    value: string,
    onChange: (value: string) => void,
    remove: boolean,
    toggleRemove: () => void,
  ) => (
    <SettingsRow
      title={`${label} API key`}
      stackControl
      description={remove ? "The saved key will be deleted when you save." : savedKey ? "Enter a new key to replace the saved key." : "The key is stored encrypted on the OpenTeam server."}
      control={
        <div className="flex w-[330px] max-w-full flex-wrap items-center gap-2">
          <input
            className={`${settingsInput} min-w-0 flex-1`}
            type={["pass", "word"].join("")}
            autoComplete="new-password"
            aria-label={`${label} API key`}
            value={value}
            placeholder={savedKey ? `••••${saved.providers[provider].apiKeySuffix ?? ""}` : "API key"}
            onChange={(event) => {
              onChange(event.target.value);
              if (event.target.value.trim()) {
                if (provider === "volcengine") setRemoveVolcengineKey(false);
                else setRemoveDeepgramKey(false);
              }
            }}
          />
          {savedKey ? <button className={`${settingsSecondaryButton} text-destructive`} onClick={toggleRemove} type="button">{remove ? "Undo deletion" : "Delete key"}</button> : null}
        </div>
      }
    />
  );

  return (
    <div>
      <SettingsIntro>
        Configure the server-side realtime conversation service. These settings are shared by macOS and Android clients.
      </SettingsIntro>
      <fieldset disabled={Boolean(busy)} className="min-w-0">
        <SettingsGroup>
          <SettingsRow
            title="Realtime voice"
            description="Allow clients to open authenticated realtime voice sessions."
            control={<InteractiveSwitch label="Enable realtime voice" checked={draft.enabled} onChange={(value) => set("enabled", value)} />}
          />
          <SettingsRow
            title="Provider"
            description={saved.providers[draft.defaultProvider].configured ? `${providerLabel[draft.defaultProvider]} is configured.` : `${providerLabel[draft.defaultProvider]} needs a provider key.`}
            control={
              <Select value={draft.defaultProvider} onValueChange={(value) => set("defaultProvider", value as VoiceProviderId)}>
                <SelectTrigger aria-label="Realtime voice provider" className={`${settingsSelect} w-[180px]`}><SelectValue /></SelectTrigger>
                <SettingsSelectContent>
                  {(Object.keys(providerLabel) as VoiceProviderId[]).map((provider) => <SelectItem key={provider} value={provider}>{providerLabel[provider]}</SelectItem>)}
                </SettingsSelectContent>
              </Select>
            }
          />
        </SettingsGroup>

        <SettingsGroup>
          {draft.defaultProvider === "volcengine"
            ? keyField(
                "volcengine",
                "Volcengine",
                saved.providers.volcengine.configured,
                draft.volcengineApiKey,
                (value) => set("volcengineApiKey", value),
                removeVolcengineKey,
                () => setRemoveVolcengineKey((value) => !value),
              )
            : keyField(
                "deepgram",
                "Deepgram",
                saved.providers.deepgram.configured,
                draft.deepgramApiKey,
                (value) => set("deepgramApiKey", value),
                removeDeepgramKey,
                () => setRemoveDeepgramKey((value) => !value),
              )}
        </SettingsGroup>

        <details className="group mt-4">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-[10px] px-2 py-2 text-[12px] text-foreground-secondary outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/[0.06] [&::-webkit-details-marker]:hidden">
            <span>
              <span className="block text-[13px] text-foreground">Advanced settings</span>
              <span className="block">Provider endpoints, resource IDs, models, and speech defaults</span>
            </span>
            <span className="text-[16px] transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <div className="mt-2">
            {draft.defaultProvider === "volcengine" ? (
              <SettingsGroup>
                {([
                  ["volcengineBaseUrl", "Base URL", "https://openspeech.bytedance.com"],
                  ["volcengineSttUrl", "STT WebSocket URL", "Optional provider-specific URL"],
                  ["volcengineTtsUrl", "TTS WebSocket URL", "Optional provider-specific URL"],
                  ["volcengineSttResourceId", "STT resource ID", "volc.seedasr.sauc.duration"],
                  ["volcengineTtsResourceId", "TTS resource ID", "seed-tts-2.0"],
                ] as const).map(([key, label, placeholder]) => (
                  <SettingsRow
                    key={key}
                    title={label}
                    stackControl
                    control={
                      <input
                        className={`${settingsInput} w-[330px] max-w-full`}
                        aria-label={label}
                        value={draft[key]}
                        placeholder={placeholder}
                        onChange={(event) => set(key, event.target.value)}
                      />
                    }
                  />
                ))}
              </SettingsGroup>
            ) : draft.defaultProvider === "deepgram" ? (
              <SettingsGroup>
                <SettingsRow
                  title="Base URL"
                  stackControl
                  control={
                    <input
                      className={`${settingsInput} w-[330px] max-w-full`}
                      aria-label="Deepgram base URL"
                      value={draft.deepgramBaseUrl}
                      placeholder="https://api.deepgram.com"
                      onChange={(event) => set("deepgramBaseUrl", event.target.value)}
                    />
                  }
                />
              </SettingsGroup>
            ) : null}
            <SettingsGroup className="mt-3">
              {([
                ["sttModel", "STT model"],
                ["ttsModel", "TTS model"],
                ["voice", "TTS voice"],
                ["language", "Language"],
              ] as const).map(([key, label]) => (
                <SettingsRow
                  key={key}
                  title={label}
                  description="Leave empty to use the recommended value."
                  stackControl
                  control={
                    key === "voice" && draft.defaultProvider === "volcengine" ? (
                      <VolcengineVoiceSelect
                        value={draft.voice}
                        defaultVoiceId={speechDefaults.volcengine.voice}
                        onChange={(value) => set("voice", value)}
                      />
                    ) : (
                      <input
                        className={`${settingsInput} w-[330px] max-w-full`}
                        aria-label={label}
                        value={draft[key]}
                        placeholder={speechDefaults[draft.defaultProvider][key] || "Automatic"}
                        onChange={(event) => set(key, event.target.value)}
                      />
                    )
                  }
                />
              ))}
              <SettingsRow
                title="Narration model"
                description="Speaks short progress updates while the agent works. Use a fast model as provider/model. Leave empty to use the bot's own model."
                stackControl
                control={
                  <input
                    className={`${settingsInput} w-[330px] max-w-full`}
                    aria-label="Narration model"
                    value={draft.narrationModel}
                    placeholder="Same as the bot"
                    onChange={(event) => set("narrationModel", event.target.value)}
                  />
                }
              />
            </SettingsGroup>
          </div>
        </details>
        <div className="mt-4 flex items-center justify-end gap-2 px-2">
          {message ? <span className={`mr-auto flex items-center gap-1 text-[12px] ${error ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>{!error ? <CheckCircle2 className="size-3.5" /> : <AudioLines className="size-3.5" />}{message}</span> : null}
          <button className={settingsPrimaryButton} disabled={!changed || Boolean(busy)} onClick={() => void save()} type="button">{busy === "save" ? <LoadingOrb aria-hidden size={14} /> : null} Save settings</button>
        </div>
      </fieldset>
    </div>
  );
}
