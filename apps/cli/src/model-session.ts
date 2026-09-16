import { errorMessage } from "./errors";
import type { InteractiveOutcome, InteractiveSession } from "./interactive-session";
import { renderModelSession } from "./model-ui";
import {
  modelProviderOptions,
  modelProviderAccess,
  PROVIDER_GROUPS,
} from "./model-provider-options";
import {
  THINKING,
  type ModelCatalog,
  type ModelChoice,
  type ModelProvider,
  type ModelSettingsAPI,
  type TranscriptionDraft,
  type TranscriptionView,
} from "./model-settings";
import type { RuntimeInferenceSettings } from "./runtime-settings";
import type { SessionKey } from "./setup-session";
import { SELECTABLE_ROW_KINDS, type SessionRow, type SetupSessionView } from "./ui";

const CONTINUE = { type: "continue" } as const;
const stages = [
  { label: "Inference", description: "Choose the model used for new AI tasks." },
  { label: "Transcription", description: "Choose how the server turns voice notes into text." },
];
const draftOf = (value: TranscriptionView): TranscriptionDraft => ({
  enabled: value.enabled,
  provider: value.provider,
  baseUrl: value.baseUrl,
  model: value.model,
  language: value.language,
});
const endpoint = (value: TranscriptionDraft) =>
  value.provider === "openai" ? "https://api.openai.com/v1" : value.baseUrl.replace(/\/+$/, "");

export type ModelExit = boolean | { connectProvider: string; authType?: "oauth" | "api_key" };
export class ModelSession implements InteractiveSession<ModelExit> {
  tab = 0;
  private cursors = [0, 0];
  private pane: "main" | "providers" | "models" | "transcription-models" | "discard" = "main";
  private listCursor = 0;
  private search = "";
  private transcriptionModels: string[] = [];
  private editing: { id: string; buffer: string; error: string | null } | null = null;
  private notice: SetupSessionView["notice"] = null;
  private failures: Array<string | null> = [null, null];
  private providers: ModelProvider[] = [];
  private catalogs = new Map<string, ModelChoice[]>();
  inference: RuntimeInferenceSettings | null = null;
  savedInference: RuntimeInferenceSettings | null = null;
  transcription: TranscriptionDraft | null = null;
  savedTranscription: TranscriptionView | null = null;

  constructor(
    readonly api: ModelSettingsAPI,
    readonly version: string,
    readonly loginCommand: (provider: string) => string
  ) {}

  async load(): Promise<void> {
    await Promise.all([this.reload(0), this.reload(1)]);
    this.notice = null;
  }
  async providerConnected(error?: string, providerId?: string, cancelled = false): Promise<void> {
    try {
      this.installCatalog(await this.api.catalog(this.inference?.providerId));
      if (cancelled) {
        this.pane = "providers";
        this.notice = {
          text: "Connection cancelled. Choose another provider or press Esc to go back.",
          tone: "info",
        };
        return;
      }
      if (!error && providerId) {
        const option = modelProviderOptions(this.providers).find(
          (option) => option.provider.id === providerId && option.connected
        );
        if (option) {
          await this.action(option.id);
          return;
        }
      }
      this.notice = {
        text: error ?? "Provider connected. Choose it to browse its chat models.",
        tone: error ? "warning" : "success",
      };
    } catch {
      this.notice = {
        text: error ?? "Could not refresh providers. Retry Refresh provider models.",
        tone: "warning",
      };
    }
  }
  private installCatalog(catalog: ModelCatalog) {
    this.providers = catalog.providers;
    this.catalogs.set(catalog.modelProviderId, catalog.models);
  }
  private async reload(tab: number, signal?: AbortSignal) {
    try {
      if (tab === 0) {
        const catalog = await this.api.catalog(undefined, signal);
        this.installCatalog(catalog);
        this.savedInference = { ...catalog.inference };
        this.inference = { ...catalog.inference };
      } else {
        this.savedTranscription = await this.api.transcription(signal);
        this.transcription = draftOf(this.savedTranscription);
      }
      this.failures[tab] = null;
    } catch (error) {
      this.failures[tab] = errorMessage(error);
    }
  }
  dirty(tab = this.tab): boolean {
    return tab === 0
      ? JSON.stringify(this.inference) !== JSON.stringify(this.savedInference)
      : Boolean(
          this.transcription &&
            this.savedTranscription &&
            JSON.stringify(this.transcription) !== JSON.stringify(draftOf(this.savedTranscription))
        );
  }
  private get hasSavedKey(): boolean {
    return Boolean(
      this.savedTranscription?.hasApiKey &&
        this.transcription &&
        this.transcription.apiKey !== null &&
        this.savedTranscription.provider === this.transcription.provider &&
        endpoint(this.savedTranscription) === endpoint(this.transcription)
    );
  }
  private models(): ModelChoice[] {
    return this.catalogs.get(this.inference?.providerId ?? "") ?? [];
  }
  private text(
    id: string,
    label: string,
    value: string,
    placeholder?: string,
    secret = false
  ): SessionRow {
    return {
      kind: "text",
      id,
      label,
      value,
      placeholder,
      secret,
      ...(this.editing?.id === id ? { editing: this.editing } : {}),
    };
  }
  rows(): SessionRow[] {
    if (this.pane === "discard")
      return [
        {
          kind: "note",
          text: "Your unsaved edits will be discarded. Settings already saved stay in effect.",
          tone: "warning",
        },
        { kind: "action", id: "keep-editing", label: "Keep editing", primary: true },
        { kind: "action", id: "discard", label: "Discard edits and close" },
      ];
    if (this.pane !== "main") {
      const query = (
        this.editing?.id === "search" ? this.editing.buffer : this.search
      ).toLowerCase();
      const choices: SessionRow[] =
        this.pane === "providers"
          ? PROVIDER_GROUPS.flatMap((group): SessionRow[] => {
              const options = modelProviderOptions(this.providers).filter(
                (option) =>
                  option.group === group &&
                  `${option.label} ${option.provider.id} ${option.detail} ${group}`
                    .toLowerCase()
                    .includes(query)
              );
              return options.length
                ? [
                    { kind: "heading", text: group },
                    ...options.map(
                      (option): SessionRow => ({
                        kind: "option",
                        id: option.id,
                        label: option.label,
                        selected:
                          option.provider.id === this.inference?.providerId && option.connected,
                        badge: option.badge,
                        description: `${option.detail}. ${
                          option.connected
                            ? (option.provider.modelMessage ??
                              `${option.provider.modelCount} models available. Enter to choose.`)
                            : "Enter to choose how to connect."
                        }`,
                      })
                    ),
                  ]
                : [];
            })
          : this.pane === "transcription-models"
            ? this.transcriptionModels
                .filter((model) => model.toLowerCase().includes(query))
                .map((model) => ({
                  kind: "option" as const,
                  id: `transcription-choice:${model}`,
                  label: model,
                  selected: model === this.transcription?.model,
                }))
            : this.models()
                .filter((m) => `${m.modelId} ${m.name}`.toLowerCase().includes(query))
                .map((m) => ({
                  kind: "option",
                  id: `model:${m.modelId}`,
                  label: m.name || m.modelId,
                  selected: m.modelId === this.inference?.modelId,
                  description: `${m.modelId} · ${Math.round(m.contextWindow / 1000)}k context · ${m.reasoning ? "supports thinking" : "no thinking mode"}`,
                }));
      return [
        this.text("search", "Search", this.search, "Type to filter"),
        ...choices,
        ...(this.pane === "providers"
          ? [
              {
                kind: "note" as const,
                text: "Add a custom chat endpoint: openteam provider add --help",
                tone: "muted" as const,
              },
            ]
          : []),
        ...(!choices.length
          ? [
              {
                kind: "note",
                text:
                  this.pane === "transcription-models"
                    ? "No transcription models match. Enter a model ID manually if this endpoint does not identify audio models."
                    : "No models or providers match. Clear the search, connect a provider, or refresh its models.",
                tone: "warning",
              } as SessionRow,
            ]
          : []),
        { kind: "action", id: "back", label: "Back" },
      ];
    }
    if (this.failures[this.tab])
      return [
        { kind: "note", text: this.failures[this.tab]!, tone: "warning" },
        { kind: "action", id: "reload", label: "Retry loading settings", primary: true },
        { kind: "action", id: "done", label: "Done" },
      ];
    let rows: SessionRow[];
    if (this.tab === 0 && this.inference) {
      const current = this.inference;
      const provider = this.providers.find((p) => p.id === current.providerId);
      rows = [
        {
          kind: "field",
          label: "Currently saved",
          value: `${this.savedInference?.providerId}/${this.savedInference?.modelId}`,
        },
        {
          kind: "cycle",
          id: "provider",
          label: "Provider",
          value: provider ? modelProviderAccess(provider) : current.providerId,
        },
        { kind: "cycle", id: "model", label: "Model", value: current.modelId || "Choose a model" },
        { kind: "cycle", id: "thinking", label: "Thinking", value: current.reasoning },
        ...(!provider?.connected
          ? [
              {
                kind: "note",
                text: provider
                  ? "Choose a subscription or API connection to load its chat models."
                  : "The saved provider is not in your registry. Choose a connected provider, or add its custom endpoint with openteam provider add.",
                tone: "warning",
              } as SessionRow,
            ]
          : []),
        ...(provider?.modelMessage
          ? [{ kind: "note" as const, text: provider.modelMessage, tone: "warning" as const }]
          : []),
        { kind: "action", id: "save", label: "Save inference", primary: true },
        { kind: "action", id: "refresh-models", label: "Refresh provider models" },
        ...(provider?.modelStatus === "unavailable"
          ? [{ kind: "action" as const, id: "reconnect-provider", label: "Reconnect provider" }]
          : []),
      ];
    } else if (this.transcription) {
      const t = this.transcription;
      rows = [
        { kind: "toggle", id: "enabled", label: "Voice notes", checked: t.enabled },
        {
          kind: "cycle",
          id: "transcription-provider",
          label: "Provider",
          value: t.provider === "openai" ? "OpenAI" : "Custom / OpenAI-compatible",
        },
        t.provider === "openai"
          ? { kind: "field", label: "Base URL", value: t.baseUrl }
          : this.text("baseUrl", "Base URL", t.baseUrl, "http://audio-server:8000/v1"),
        this.text("transcription-model", "Model", t.model, "Transcription model ID"),
        { kind: "action", id: "browse-transcription", label: "Browse provider models" },
        this.text(
          "apiKey",
          "API key",
          typeof t.apiKey === "string" ? t.apiKey : "",
          this.hasSavedKey
            ? "Saved; blank keeps it"
            : t.provider === "openai"
              ? "Required for OpenAI transcription"
              : "Optional for private services",
          true
        ),
        ...(this.savedTranscription?.hasApiKey || t.apiKey !== undefined
          ? [
              {
                kind: "toggle",
                id: "remove-key",
                label: "Remove saved key",
                checked: t.apiKey === null,
              } as SessionRow,
            ]
          : []),
        this.text("language", "Language", t.language, "Automatic (or en, fr, ...)"),
        {
          kind: "note",
          text: "The API key is separate from your chat sign-in. Changing the endpoint does not transfer the saved key.",
          tone: "muted",
        },
        { kind: "action", id: "save", label: "Save transcription", primary: true },
        { kind: "action", id: "test", label: "Test saved connection" },
      ];
    } else rows = [];
    return [
      ...rows,
      {
        kind: "note",
        text: this.dirty() ? "Unsaved changes in this tab." : "No unsaved changes in this tab.",
        tone: this.dirty() ? "warning" : "muted",
      },
      { kind: "action", id: "done", label: "Done" },
    ];
  }
  private choices() {
    return this.rows().flatMap((row, index) => (SELECTABLE_ROW_KINDS.has(row.kind) ? [index] : []));
  }
  private focusSelectedOption() {
    const rows = this.rows();
    const choices = this.choices();
    this.listCursor = Math.max(
      0,
      choices.findIndex((index) => {
        const row = rows[index];
        return row?.kind === "option" && row.selected;
      })
    );
  }
  private get cursor() {
    return this.pane === "main" ? this.cursors[this.tab]! : this.listCursor;
  }
  private set cursor(value: number) {
    if (this.pane === "main") this.cursors[this.tab] = value;
    else this.listCursor = value;
  }
  private cursorRow() {
    const choices = this.choices();
    this.cursor = Math.max(0, Math.min(this.cursor, choices.length - 1));
    return choices[this.cursor] ?? -1;
  }
  view(): SetupSessionView {
    return {
      version: this.version,
      stages,
      activeStage: this.tab,
      completed: [],
      title:
        this.pane === "providers"
          ? "Choose a provider"
          : this.pane === "models"
            ? "Choose an inference model"
            : this.pane === "transcription-models"
              ? "Choose a transcription model"
              : this.pane === "discard"
                ? "Discard unsaved changes?"
                : stages[this.tab]!.label,
      description:
        this.pane === "providers"
          ? "Choose your account, then a model."
          : stages[this.tab]!.description,
      rows: this.rows(),
      cursorRow: this.cursorRow(),
      mode: this.editing ? "edit" : "navigate",
      notice: this.notice,
    };
  }
  frame(width: number | undefined, color: boolean) {
    return renderModelSession(this.view(), { width, color, compact: this.pane !== "main" });
  }
  private back() {
    this.pane = "main";
    this.listCursor = 0;
    this.search = "";
    this.editing = null;
  }
  private close(): InteractiveOutcome<ModelExit> {
    if (this.dirty(0) || this.dirty(1)) {
      this.pane = "discard";
      this.listCursor = 0;
      return CONTINUE;
    }
    return { type: "complete", value: true };
  }
  private commit(id: string, raw: string) {
    const value = raw.trim();
    if (id === "search") {
      this.search = value;
      return;
    }
    const t = this.transcription!;
    if (id === "baseUrl") {
      if (value) {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error(
            "Use an HTTP(S) URL without credentials, query parameters or a fragment."
          );
        if (value.length > 2048) throw new Error("The base URL is too long.");
      }
      if (value.replace(/\/+$/, "") !== endpoint(t)) delete t.apiKey;
      t.baseUrl = value.replace(/\/+$/, "");
    } else if (id === "transcription-model") {
      if (value.length > 256) throw new Error("Use a model ID of at most 256 characters.");
      t.model = value;
    } else if (id === "apiKey") {
      if (value.length > 20_000) throw new Error("The API key is too long.");
      if (value) t.apiKey = value;
      else delete t.apiKey;
    } else if (id === "language") {
      if (value && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(value))
        throw new Error(
          "Use a language code such as en, or leave it blank for automatic detection."
        );
      t.language = value;
    }
  }
  private async action(id: string, signal?: AbortSignal): Promise<InteractiveOutcome<ModelExit>> {
    this.notice = { text: id === "save" ? "Saving settings…" : "Loading…", tone: "info" };
    try {
      if (id === "reload") {
        await this.reload(this.tab, signal);
        this.notice = null;
      } else if (id.startsWith("provider:")) {
        const option = modelProviderOptions(this.providers).find((option) => option.id === id);
        if (!option) throw new Error("Provider connection changed. Refresh the provider list.");
        const providerId = option.provider.id;
        if (!option.connected)
          return {
            type: "complete",
            value: {
              connectProvider: providerId,
              ...(option.authType ? { authType: option.authType } : {}),
            },
          };
        const catalog = await this.api.catalog(providerId, signal);
        this.installCatalog(catalog);
        const selected =
          this.inference?.providerId === providerId
            ? this.inference.modelId
            : this.savedInference?.providerId === providerId
              ? this.savedInference.modelId
              : (catalog.models[0]?.modelId ?? "");
        this.inference = { ...this.inference!, providerId, modelId: selected };
        if (!catalog.models.find((m) => m.modelId === selected)?.reasoning)
          this.inference.reasoning = "off";
        this.pane = "models";
        this.search = "";
        this.focusSelectedOption();
        const provider = catalog.providers.find((p) => p.id === providerId);
        this.notice = {
          text:
            provider?.modelMessage ?? `Choose a chat model from ${provider?.name ?? providerId}.`,
          tone: provider?.modelMessage ? "warning" : "info",
        };
      } else if (id === "reconnect-provider") {
        const authType = this.providers.find((p) => p.id === this.inference!.providerId)?.authType;
        return {
          type: "complete",
          value: { connectProvider: this.inference!.providerId, ...(authType ? { authType } : {}) },
        };
      } else if (id === "refresh-models") {
        this.installCatalog(await this.api.catalog(this.inference?.providerId, signal));
        this.notice = { text: "Provider models refreshed.", tone: "info" };
      } else if (id === "browse-transcription") {
        this.transcriptionModels = await this.api.transcriptionModels(this.transcription!, signal);
        this.pane = "transcription-models";
        this.search = "";
        this.listCursor = 1;
        this.notice = {
          text: "Transcription models reported by this audio provider. You can also enter a model ID manually.",
          tone: "muted",
        };
      } else if (id === "test") {
        if (this.dirty()) throw new Error("Save transcription before testing its connection.");
        if (!this.savedTranscription?.configured)
          throw new Error("Enable and configure voice notes before testing.");
        const check = await this.api.checkTranscription(signal);
        this.notice = { text: check.detail, tone: check.level === "pass" ? "success" : "warning" };
      } else if (id === "save") {
        if (!this.dirty()) {
          this.notice = { text: "These settings are already saved.", tone: "muted" };
          return CONTINUE;
        }
        if (this.tab === 0) {
          const provider = this.providers.find((p) => p.id === this.inference?.providerId);
          if (!provider?.connected)
            throw new Error(
              `Connect this provider first: ${this.loginCommand(this.inference!.providerId)}`
            );
          if (!this.models().some((m) => m.modelId === this.inference?.modelId))
            throw new Error("Choose a model from this provider's available models.");
          this.savedInference = await this.api.saveInference(this.inference!, signal);
          this.inference = { ...this.savedInference };
          this.notice = {
            text: "Inference saved. New tasks will use this model.",
            tone: "success",
          };
        } else {
          const t = this.transcription!;
          if (t.enabled && (!t.baseUrl || !t.model))
            throw new Error("Enter a base URL and model before enabling voice notes.");
          if (t.enabled && t.provider === "openai" && !t.apiKey && !this.hasSavedKey)
            throw new Error(
              "Enter an OpenAI API key to enable transcription. Chat sign-in cannot be used for voice notes."
            );
          this.savedTranscription = await this.api.saveTranscription(t, signal);
          this.transcription = draftOf(this.savedTranscription);
          this.notice = {
            text: this.savedTranscription.configured
              ? "Transcription saved. Voice notes are enabled. You can now test the connection."
              : "Transcription saved. Voice notes are disabled.",
            tone: "success",
          };
        }
      }
    } catch (error) {
      let detail = errorMessage(error);
      if (typeof this.transcription?.apiKey === "string")
        detail = detail.replaceAll(this.transcription.apiKey, "[REDACTED]");
      this.notice = { text: detail, tone: "warning" };
    }
    return CONTINUE;
  }
  handle(
    character = "",
    key: SessionKey = {},
    signal?: AbortSignal
  ): InteractiveOutcome<ModelExit> | Promise<InteractiveOutcome<ModelExit>> {
    if (key.ctrl && key.name === "c") return { type: "interrupt" };
    if (this.editing) {
      if (key.name === "escape") {
        this.editing = null;
        return CONTINUE;
      }
      if (key.name === "return" || key.name === "enter") {
        try {
          const id = this.editing.id;
          this.commit(id, this.editing.buffer);
          this.editing = null;
          this.cursor = Math.min(this.cursor + 1, this.choices().length - 1);
        } catch (error) {
          if (this.editing) this.editing.error = errorMessage(error);
        }
      } else if (key.ctrl && key.name === "u") this.editing.buffer = "";
      else if (key.name === "backspace")
        this.editing.buffer = Array.from(this.editing.buffer).slice(0, -1).join("");
      else if (!key.ctrl && !key.meta && character && /^[^\p{Cc}\p{Cf}]+$/u.test(character))
        this.editing.buffer += character;
      return CONTINUE;
    }
    if (key.name === "escape") {
      if (this.pane !== "main") {
        this.back();
        return CONTINUE;
      }
      return this.close();
    }
    if (key.name === "left" || key.name === "right" || key.name === "tab") {
      this.tab = 1 - this.tab;
      this.back();
      this.notice = null;
      return CONTINUE;
    }
    const choices = this.choices();
    if (key.name === "up" || key.name === "down") {
      this.cursor =
        (this.cursor + (key.name === "up" ? -1 : 1) + choices.length) % Math.max(1, choices.length);
      return CONTINUE;
    }
    if (key.name === "home") {
      this.cursor = 0;
      return CONTINUE;
    }
    if (key.name === "end") {
      this.cursor = choices.length - 1;
      return CONTINUE;
    }
    const row = this.rows()[this.cursorRow()];
    if (!row || !("id" in row)) return CONTINUE;
    const printable = !key.ctrl && !key.meta && character && /^[^\p{Cc}\p{Cf}]+$/u.test(character);
    const enter = key.name === "return" || key.name === "enter";
    if (
      printable &&
      (this.pane === "models" || this.pane === "providers" || this.pane === "transcription-models")
    ) {
      this.listCursor = 0;
      this.editing = { id: "search", buffer: character, error: null };
      return CONTINUE;
    }
    if (row.kind === "text" && (enter || printable)) {
      this.editing = { id: row.id, buffer: enter ? row.value : character, error: null };
      return CONTINUE;
    }
    if (!enter && character !== " ") return CONTINUE;
    this.notice = null;
    if (row.id === "done") return this.close();
    if (row.id === "discard") return { type: "complete", value: true };
    if (row.id === "back" || row.id === "keep-editing") {
      this.back();
      return CONTINUE;
    }
    if (
      row.id === "model" &&
      !this.providers.find((p) => p.id === this.inference?.providerId)?.connected
    ) {
      this.pane = "providers";
      this.listCursor = 0;
      this.notice = {
        text: "Connect a provider first, then choose its chat model.",
        tone: "warning",
      };
    } else if (row.id === "provider" || row.id === "model") {
      this.pane = row.id === "provider" ? "providers" : "models";
      this.search = "";
      this.focusSelectedOption();
    } else if (row.id.startsWith("model:")) {
      this.inference!.modelId = row.id.slice(6);
      if (!this.models().find((m) => m.modelId === this.inference!.modelId)?.reasoning)
        this.inference!.reasoning = "off";
      this.back();
    } else if (row.id.startsWith("transcription-choice:")) {
      this.transcription!.model = row.id.slice("transcription-choice:".length);
      this.back();
    } else if (row.id === "thinking") {
      if (!this.models().find((m) => m.modelId === this.inference?.modelId)?.reasoning)
        this.notice = { text: "This model does not support a thinking level.", tone: "muted" };
      else
        this.inference!.reasoning =
          THINKING[(THINKING.indexOf(this.inference!.reasoning) + 1) % THINKING.length]!;
    } else if (row.id === "enabled") this.transcription!.enabled = !this.transcription!.enabled;
    else if (row.id === "remove-key") {
      if (this.transcription!.apiKey === null) delete this.transcription!.apiKey;
      else this.transcription!.apiKey = null;
    } else if (row.id === "transcription-provider") {
      const t = this.transcription!;
      t.provider = t.provider === "openai" ? "openai-compatible" : "openai";
      t.baseUrl = t.provider === "openai" ? "https://api.openai.com/v1" : "";
      t.model = t.provider === "openai" ? "whisper-1" : "";
      delete t.apiKey;
    } else return this.action(row.id, signal);
    return CONTINUE;
  }
}
