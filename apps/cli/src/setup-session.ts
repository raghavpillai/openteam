import { emitKeypressEvents } from "node:readline";
import { API_PORT } from "./constants";
import { CliError } from "./errors";
import type { RuntimeInferenceSettings } from "./runtime-settings";
import {
  ACCESS_CHOICES,
  accessLabel,
  accessModeNotes,
  type AccessMode,
  BUILTIN_PROVIDER_CHOICES,
  bindHostsFor,
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_CHOICE,
  configuredAccessMode,
  customProviderApiLabel,
  type CustomProviderApi,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_RUNTIME_INFERENCE,
  defaultProviderAuthType,
  existingReachableHost,
  HTTP_WARNINGS,
  providerLabel,
  publicUrlFor,
  SKIP_INFERENCE_CHOICE,
  type SetupConfiguration,
  THINKING_LEVELS,
  thinkingLabel,
  type ThinkingLevel,
  validateIntegerInRange,
  validateModel,
  validateOwnerPassword,
  validateOwnerUsername,
  validateProviderBaseUrl,
  validateProviderId,
  validateProviderName,
  validatePublicDomain,
  validatePublicHost,
  validateTimeZone,
} from "./setup-values";
import {
  clampViewport,
  colorEnabled,
  type MessageTone,
  renderSetupSession,
  SELECTABLE_ROW_KINDS,
  type SessionRow,
  type SetupSessionView,
  type SetupStage,
} from "./ui";

export interface SetupSessionInput {
  version: string;
  stages: readonly SetupStage[];
  current: ReadonlyMap<string, string>;
  authenticated: boolean;
  advanced?: boolean;
  fresh?: boolean;
  ownerConfigured?: boolean;
  currentOwnerUsername?: string;
  currentInference?: RuntimeInferenceSettings;
  detectedPrivateHost?: string | null;
  /** Informational notes shown above the launch summary, such as a port fallback. */
  notes?: ReadonlyArray<{ text: string; tone: MessageTone }>;
}

/** Shape of the `key` argument Node's readline keypress events deliver. */
export interface SessionKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export type SessionOutcome =
  | { type: "continue" }
  | { type: "complete"; configuration: SetupConfiguration }
  | { type: "cancel" }
  | { type: "interrupt" };

export interface SessionProblem {
  section: number;
  rowId: string;
  message: string;
}

interface Editing {
  rowId: string;
  buffer: string;
  secret: boolean;
  phase: "value" | "confirm";
  pending: string | null;
  error: string | null;
}

interface SessionState {
  section: number;
  cursors: number[];
  visited: boolean[];
  accessMode: AccessMode;
  host: string;
  httpAcknowledged: boolean;
  ownerUsername: string;
  ownerPassword: string | null;
  apiPort: string;
  timeZone: string;
  workerConcurrency: string;
  thinking: ThinkingLevel;
  provider: string;
  model: string;
  skipInference: boolean;
  custom: {
    id: string;
    name: string;
    baseUrl: string;
    api: CustomProviderApi;
    model: string;
    reasoning: boolean;
  };
  authenticate: boolean;
  authType: "oauth" | "api_key";
  apiKey: string | null;
  editing: Editing | null;
  notice: { text: string; tone: MessageTone } | null;
}

export interface SetupSession {
  readonly state: Readonly<SessionState>;
  view(): SetupSessionView;
  rows(section?: number): readonly SessionRow[];
  problems(): readonly SessionProblem[];
  configuration(): SetupConfiguration;
  handle(character: string, key?: SessionKey): SessionOutcome;
}

/** Sections the user can move between with left/right. Verify runs after apply. */
export const SESSION_SECTION_COUNT = 4;
const ACCESS_SECTION = 0;
const OWNER_SECTION = 1;
const INFERENCE_SECTION = 2;
const LAUNCH_SECTION = 3;
const AUTH_TYPE_LABELS: Record<"oauth" | "api_key", string> = {
  oauth: "Claude Pro/Max",
  api_key: "Anthropic API key",
};
const PRINTABLE = /^[^\p{Cc}]+$/u;

const hostLabel = (mode: AccessMode): { label: string; placeholder: string } => {
  if (mode === "https" || mode === "proxy") {
    return { label: "Public domain", placeholder: "example: bot.example.com" };
  }
  if (mode === "http") return { label: "Public address", placeholder: "hostname or IPv4 address" };
  return { label: "Private address", placeholder: "hostname or IPv4 address" };
};

const validateHost = (mode: AccessMode, value: string): string =>
  mode === "https" || mode === "proxy" ? validatePublicDomain(value) : validatePublicHost(value);

const withoutTrailingWord = (value: string): string => value.replace(/\s*\S+\s*$/, "");

export const createSetupSession = (input: SetupSessionInput): SetupSession => {
  const advanced = input.advanced ?? false;
  const fresh = input.fresh ?? false;
  const ownerConfigured = input.ownerConfigured ?? false;
  const currentInference = input.currentInference ?? DEFAULT_RUNTIME_INFERENCE;
  const currentProvider = currentInference.providerId;
  const currentProviderIsBuiltin = BUILTIN_PROVIDER_CHOICES.some(
    (choice) => choice.value === currentProvider
  );
  const detectedPrivateHost = input.detectedPrivateHost ?? null;
  const initialAccess = configuredAccessMode(input.current, fresh);
  const existingHost = existingReachableHost(input.current);
  const initialHost =
    fresh && initialAccess === "private"
      ? (detectedPrivateHost ?? "")
      : (existingHost ?? (initialAccess === "private" ? (detectedPrivateHost ?? "") : ""));
  const needsConnectionInput = !advanced && initialAccess !== "local" && !initialHost;
  const firstSection = advanced || needsConnectionInput ? ACCESS_SECTION : OWNER_SECTION;
  const visibleStages = firstSection === ACCESS_SECTION ? input.stages : input.stages.slice(1);
  const currentThinking = currentInference.reasoning as ThinkingLevel;

  const state: SessionState = {
    section: firstSection,
    cursors: new Array<number>(SESSION_SECTION_COUNT).fill(0),
    visited: new Array<boolean>(SESSION_SECTION_COUNT).fill(false),
    accessMode: initialAccess,
    host: initialHost,
    httpAcknowledged: false,
    ownerUsername: input.currentOwnerUsername || "openteam",
    ownerPassword: null,
    apiPort: input.current.get("OPENTEAM_API_PORT") || String(API_PORT),
    timeZone: input.current.get("OPENTEAM_TIME_ZONE") || "UTC",
    workerConcurrency: input.current.get("OPENTEAM_WORKER_CONCURRENCY") || "8",
    thinking: THINKING_LEVELS.includes(currentThinking) ? currentThinking : "high",
    provider: currentProvider,
    model: currentInference.modelId,
    skipInference: false,
    custom: {
      id: "my-provider",
      name: "",
      baseUrl: "",
      api: "openai-responses",
      model: "",
      reasoning: true,
    },
    authenticate: !input.authenticated,
    authType: defaultProviderAuthType(currentProvider),
    apiKey: null,
    editing: null,
    notice: null,
  };
  state.visited[firstSection] = true;

  const providerId = (): string =>
    state.provider === "custom" ? state.custom.id || "custom provider" : state.provider;
  const activeModel = (): string =>
    state.provider === "custom" ? state.custom.model : state.model;
  const reachableHost = (): string => (state.accessMode === "local" ? "127.0.0.1" : state.host);
  const publicUrl = (): string =>
    publicUrlFor(state.accessMode, reachableHost() || "<host>", state.apiPort);

  const editingFor = (rowId: string, label?: string) =>
    state.editing?.rowId === rowId
      ? {
          buffer: state.editing.buffer,
          error: state.editing.error,
          ...(label ? { label } : {}),
        }
      : undefined;

  const textRow = (
    id: string,
    label: string,
    value: string,
    extras: { placeholder?: string; secret?: boolean; editingLabel?: string } = {}
  ): SessionRow => ({
    kind: "text",
    id,
    label,
    value,
    ...(extras.placeholder ? { placeholder: extras.placeholder } : {}),
    ...(extras.secret ? { secret: true } : {}),
    ...(editingFor(id, extras.editingLabel)
      ? { editing: editingFor(id, extras.editingLabel) }
      : {}),
  });

  const accessRows = (): SessionRow[] => {
    const rows: SessionRow[] = [];
    if (advanced) {
      for (const choice of ACCESS_CHOICES) {
        rows.push({
          kind: "option",
          id: `access:${choice.value}`,
          label: choice.title,
          description: choice.description,
          selected: state.accessMode === choice.value,
          ...("recommended" in choice && choice.recommended ? { recommended: true } : {}),
        });
      }
    }
    if (state.accessMode !== "local") {
      const { label, placeholder } = hostLabel(state.accessMode);
      rows.push({ kind: "heading", text: "Address" });
      rows.push(textRow("host", label, state.host, { placeholder }));
      if (!advanced && !state.host) {
        rows.push({
          kind: "note",
          text: "No private address was detected. Enter a Tailscale, WireGuard, or LAN address.",
          tone: "info",
        });
      } else if (
        state.accessMode === "private" &&
        detectedPrivateHost &&
        state.host === detectedPrivateHost
      ) {
        rows.push({ kind: "note", text: "Detected on this computer.", tone: "success" });
      }
    }
    if (state.accessMode === "http") {
      for (const text of HTTP_WARNINGS) rows.push({ kind: "note", text, tone: "warning" });
      rows.push({
        kind: "toggle",
        id: "httpAck",
        label: "I understand the risk and want to continue",
        checked: state.httpAcknowledged,
      });
    }
    for (const note of accessModeNotes(state.accessMode)) rows.push({ kind: "note", ...note });
    return rows;
  };

  const ownerRows = (): SessionRow[] => {
    if (ownerConfigured) {
      return [
        {
          kind: "note",
          text: `Your existing account (${state.ownerUsername}) will stay signed in.`,
          tone: "success",
        },
        {
          kind: "note",
          text: "Run openteam account update if you want to change it.",
          tone: "muted",
        },
      ];
    }
    return [
      textRow("username", "Username", state.ownerUsername),
      textRow("password", "Password", state.ownerPassword ?? "", {
        placeholder: "8-128 characters, required",
        secret: true,
        editingLabel: state.editing?.phase === "confirm" ? "Confirm password" : undefined,
      }),
      {
        kind: "note",
        text: "Your password is stored securely and will not appear on screen.",
        tone: "muted",
      },
    ];
  };

  const inferenceRows = (): SessionRow[] => {
    const rows: SessionRow[] = [];
    if (advanced) {
      rows.push({ kind: "heading", text: "Server" });
      rows.push(textRow("apiPort", "API port", state.apiPort));
      rows.push(textRow("timeZone", "Time zone", state.timeZone));
    }
    const providerChoices: Array<{ label: string; description: string; value: string }> = [
      ...BUILTIN_PROVIDER_CHOICES,
    ];
    if (!currentProviderIsBuiltin) {
      providerChoices.push({
        label: `Keep ${currentProvider}`,
        description: "Continue using the model provider already connected to OpenTeam.",
        value: currentProvider,
      });
    }
    providerChoices.push(CUSTOM_PROVIDER_CHOICE);
    for (const choice of providerChoices) {
      rows.push({
        kind: "option",
        id: `provider:${choice.value}`,
        label: choice.label,
        description: choice.description,
        selected: !state.skipInference && state.provider === choice.value,
        ...(choice.value === currentProvider ? { recommended: true } : {}),
      });
    }
    rows.push({
      kind: "option",
      id: `inference:${SKIP_INFERENCE_CHOICE.value}`,
      label: SKIP_INFERENCE_CHOICE.label,
      description: SKIP_INFERENCE_CHOICE.description,
      selected: state.skipInference,
    });
    if (state.skipInference) return rows;
    if (state.provider === "custom") {
      rows.push({ kind: "heading", text: "Provider details" });
      rows.push(textRow("custom.id", "Provider id", state.custom.id, { placeholder: "required" }));
      rows.push(
        textRow("custom.name", "Provider name", state.custom.name, {
          placeholder: "defaults to the provider id",
        })
      );
      rows.push(
        textRow("custom.baseUrl", "Base URL", state.custom.baseUrl, {
          placeholder: "https://api.example.com/v1 (required)",
        })
      );
      rows.push({
        kind: "cycle",
        id: "custom.api",
        label: "API format",
        value: customProviderApiLabel(state.custom.api),
      });
      rows.push(
        textRow("custom.model", "Model", state.custom.model, { placeholder: "model id (required)" })
      );
      rows.push({
        kind: "toggle",
        id: "custom.reasoning",
        label: "This model can think through complex tasks",
        checked: state.custom.reasoning,
      });
    } else if (advanced) {
      rows.push({ kind: "heading", text: "Model" });
      rows.push(textRow("model", "Model", state.model, { placeholder: "model id (required)" }));
    } else {
      rows.push({ kind: "field", label: "Model", value: state.model });
    }
    if (advanced) {
      rows.push({
        kind: "cycle",
        id: "thinking",
        label: "Thinking level",
        value: thinkingLabel(state.thinking),
      });
      rows.push(textRow("workerConcurrency", "Tasks at once", state.workerConcurrency));
    }
    const again = input.authenticated && state.provider === currentProvider;
    if (advanced) {
      rows.push({ kind: "heading", text: "Sign-in" });
      rows.push({
        kind: "toggle",
        id: "authenticate",
        label: `${again ? "Sign in again" : "Sign in during setup"}`,
        checked: state.authenticate,
      });
    }
    if (state.authenticate) {
      if (state.provider === "anthropic") {
        rows.push({
          kind: "cycle",
          id: "authType",
          label: "Use",
          value: AUTH_TYPE_LABELS[state.authType],
        });
        if (state.authType === "oauth") {
          rows.push({
            kind: "note",
            text: "Claude may bill this as extra usage instead of including it with your plan.",
            tone: "warning",
          });
        }
      }
      if (state.authType === "api_key") {
        rows.push(
          textRow(
            "apiKey",
            state.provider === "custom" ? "API key or password" : "API key",
            state.apiKey ?? "",
            {
              placeholder: "required",
              secret: true,
            }
          )
        );
      } else if (state.provider !== "anthropic") {
        rows.push({
          kind: "note",
          text: `A browser window will open for ${providerLabel(providerId())} sign-in after OpenTeam starts.`,
          tone: "muted",
        });
      }
    }
    return rows;
  };

  const launchRows = (): SessionRow[] => {
    const rows: SessionRow[] = [
      { kind: "field", label: "Address", value: publicUrl() },
      { kind: "field", label: "Username", value: state.ownerUsername },
      {
        kind: "field",
        label: "Inference",
        value: state.skipInference
          ? "Skip for now"
          : `${state.provider === "custom" ? state.custom.name || providerId() : providerLabel(providerId())} · ${activeModel() || "<model>"}`,
      },
    ];
    if (advanced) {
      rows.unshift({ kind: "field", label: "Connection", value: accessLabel(state.accessMode) });
      rows.push(
        { kind: "field", label: "Thinking", value: thinkingLabel(state.thinking) },
        { kind: "field", label: "API port", value: state.apiPort },
        { kind: "field", label: "Time zone", value: state.timeZone },
        { kind: "field", label: "Tasks at once", value: state.workerConcurrency }
      );
    }
    for (const note of input.notes ?? []) rows.push({ kind: "note", ...note });
    if (state.accessMode === "proxy") {
      rows.push({
        kind: "note",
        text: `Proxy target: http://127.0.0.1:${state.apiPort} (WebSocket upgrades must be enabled).`,
        tone: "info",
      });
    }
    for (const problem of problems()) {
      rows.push({ kind: "note", text: problem.message, tone: "warning" });
    }
    rows.push({ kind: "action", id: "apply", label: "Start OpenTeam", primary: true });
    rows.push({ kind: "action", id: "cancel", label: "Cancel without changes" });
    return rows;
  };

  const rows = (section = state.section): readonly SessionRow[] => {
    switch (section) {
      case ACCESS_SECTION:
        return accessRows();
      case OWNER_SECTION:
        return ownerRows();
      case INFERENCE_SECTION:
        return inferenceRows();
      default:
        return launchRows();
    }
  };

  const selectableRows = (section = state.section): number[] =>
    rows(section)
      .map((row, index) => (SELECTABLE_ROW_KINDS.has(row.kind) ? index : -1))
      .filter((index) => index >= 0);

  const rowId = (row: SessionRow): string | null => ("id" in row ? row.id : null);

  const cursorRow = (section = state.section): number => {
    const selectable = selectableRows(section);
    if (!selectable.length) return -1;
    const cursor = Math.max(0, Math.min(state.cursors[section] ?? 0, selectable.length - 1));
    state.cursors[section] = cursor;
    return selectable[cursor] ?? -1;
  };

  const focusRow = (section: number, id: string): void => {
    const selectable = selectableRows(section);
    const position = selectable.findIndex((index) => rowId(rows(section)[index]!) === id);
    if (position >= 0) state.cursors[section] = position;
  };

  const problems = (): SessionProblem[] => {
    const found: SessionProblem[] = [];
    if (state.accessMode !== "local") {
      const { label } = hostLabel(state.accessMode);
      if (!state.host) {
        found.push({
          section: ACCESS_SECTION,
          rowId: "host",
          message: `${label} is required in Connection.`,
        });
      } else {
        try {
          validateHost(state.accessMode, state.host);
        } catch (error) {
          found.push({
            section: ACCESS_SECTION,
            rowId: "host",
            message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (state.accessMode === "http" && !state.httpAcknowledged) {
        found.push({
          section: ACCESS_SECTION,
          rowId: "httpAck",
          message: "Confirm the public HTTP warning in Connection.",
        });
      }
    }
    if (!ownerConfigured && !state.ownerPassword) {
      found.push({
        section: OWNER_SECTION,
        rowId: "password",
        message: "Set your password in Account.",
      });
    }
    if (!state.skipInference) {
      if (state.provider === "custom") {
        if (!state.custom.id) {
          found.push({
            section: INFERENCE_SECTION,
            rowId: "custom.id",
            message: "Enter the provider id in Inference.",
          });
        }
        if (!state.custom.baseUrl) {
          found.push({
            section: INFERENCE_SECTION,
            rowId: "custom.baseUrl",
            message: "Enter the provider URL in Inference.",
          });
        }
        if (!state.custom.model) {
          found.push({
            section: INFERENCE_SECTION,
            rowId: "custom.model",
            message: "Enter the model in Inference.",
          });
        }
      } else if (!state.model) {
        found.push({
          section: INFERENCE_SECTION,
          rowId: "model",
          message: "Enter the model in Inference.",
        });
      }
      if (state.authenticate && state.authType === "api_key" && !state.apiKey) {
        found.push({
          section: INFERENCE_SECTION,
          rowId: "apiKey",
          message:
            state.provider === "custom"
              ? "Enter an API key or password in Inference."
              : "Enter an API key in Inference.",
        });
      }
    }
    return found;
  };

  const configuration = (): SetupConfiguration => {
    const remaining = problems();
    if (remaining.length) throw new CliError(remaining[0]!.message);
    const host = reachableHost();
    const custom = !state.skipInference && state.provider === "custom";
    return {
      accessMode: state.accessMode,
      ...bindHostsFor(state.accessMode, host),
      publicUrl: publicUrlFor(state.accessMode, host, state.apiPort),
      ownerUsername: state.ownerUsername,
      ownerPassword: ownerConfigured ? undefined : (state.ownerPassword ?? undefined),
      apiPort: state.apiPort,
      timeZone: state.timeZone,
      provider: state.skipInference ? currentProvider : custom ? state.custom.id : state.provider,
      model: state.skipInference ? currentInference.modelId : activeModel(),
      thinking: state.thinking,
      workerConcurrency: state.workerConcurrency,
      authenticate: state.authenticate,
      ...(state.skipInference ? { skipInference: true } : {}),
      authType: state.authenticate ? state.authType : defaultProviderAuthType(currentProvider),
      apiKey:
        state.authenticate && state.authType === "api_key"
          ? (state.apiKey ?? undefined)
          : undefined,
      customProvider: custom
        ? {
            id: state.custom.id,
            name: state.custom.name || state.custom.id,
            baseUrl: state.custom.baseUrl,
            api: state.custom.api,
            model: state.custom.model,
            reasoning: state.custom.reasoning,
          }
        : undefined,
    };
  };

  const setAccess = (mode: AccessMode): void => {
    const previous = state.accessMode;
    state.accessMode = mode;
    if (mode === "private" && !state.host && detectedPrivateHost) state.host = detectedPrivateHost;
    if (previous === "private" && mode !== "private" && state.host === detectedPrivateHost) {
      state.host = "";
    }
  };

  const setProvider = (next: string): void => {
    if (next === state.provider && !state.skipInference) return;
    state.skipInference = false;
    const changed = next !== state.provider;
    state.provider = next;
    if (changed && next !== "custom") {
      state.model =
        next === currentProvider
          ? currentInference.modelId
          : (DEFAULT_PROVIDER_MODELS[next] ?? currentInference.modelId);
    }
    state.authenticate = !input.authenticated || next !== currentProvider;
    state.authType = next === "custom" ? "api_key" : defaultProviderAuthType(next);
    state.apiKey = null;
  };

  const skipInference = (): void => {
    state.skipInference = true;
    state.authenticate = false;
    state.apiKey = null;
  };

  const moveCursor = (delta: number): void => {
    const selectable = selectableRows();
    if (!selectable.length) return;
    const current = state.cursors[state.section] ?? 0;
    state.cursors[state.section] = (current + delta + selectable.length) % selectable.length;
  };

  const moveToSection = (section: number): void => {
    state.section = Math.max(firstSection, Math.min(SESSION_SECTION_COUNT - 1, section));
    state.visited[state.section] = true;
  };

  const advanceCursor = (): void => {
    const selectable = selectableRows();
    const current = state.cursors[state.section] ?? 0;
    if (current < selectable.length - 1) {
      state.cursors[state.section] = current + 1;
      return;
    }
    if (state.section < SESSION_SECTION_COUNT - 1) moveToSection(state.section + 1);
  };

  const startEditing = (row: Extract<SessionRow, { kind: "text" }>, replacement?: string): void => {
    state.editing = {
      rowId: row.id,
      buffer: replacement ?? (row.secret ? "" : row.value),
      secret: Boolean(row.secret),
      phase: "value",
      pending: null,
      error: null,
    };
  };

  const commitText = (id: string, raw: string): void => {
    const value = raw.trim();
    const store = (validate: (input: string) => string, assign: (normalized: string) => void) => {
      assign(validate(value));
    };
    switch (id) {
      case "host":
        store(
          (input) => validateHost(state.accessMode, input),
          (normalized) => {
            state.host = normalized;
          }
        );
        break;
      case "username":
        store(validateOwnerUsername, (normalized) => {
          state.ownerUsername = normalized;
        });
        break;
      case "apiPort":
        store(validateIntegerInRange("API port", 1, 65535), (normalized) => {
          state.apiPort = normalized;
        });
        break;
      case "timeZone":
        store(validateTimeZone, (normalized) => {
          state.timeZone = normalized;
        });
        break;
      case "workerConcurrency":
        store(validateIntegerInRange("Tasks at once", 1, 64), (normalized) => {
          state.workerConcurrency = normalized;
        });
        break;
      case "model":
        store(validateModel, (normalized) => {
          state.model = normalized;
        });
        break;
      case "custom.id":
        store(validateProviderId, (normalized) => {
          state.custom.id = normalized;
        });
        break;
      case "custom.name":
        if (!value) {
          state.custom.name = "";
          break;
        }
        store(validateProviderName, (normalized) => {
          state.custom.name = normalized;
        });
        break;
      case "custom.baseUrl":
        store(validateProviderBaseUrl, (normalized) => {
          state.custom.baseUrl = normalized;
        });
        break;
      case "custom.model":
        store(validateModel, (normalized) => {
          state.custom.model = normalized;
        });
        break;
      case "apiKey":
        if (!value) throw new Error("API key cannot be empty.");
        state.apiKey = value;
        break;
      default:
        throw new Error(`Unknown setup field ${id}.`);
    }
  };

  const handleEditing = (character: string, key: SessionKey, editing: Editing): SessionOutcome => {
    if (key.ctrl && key.name === "c") return { type: "interrupt" };
    if (key.name === "escape") {
      state.editing = null;
      return { type: "continue" };
    }
    if (key.name === "return" || key.name === "enter") {
      if (editing.rowId === "password") {
        if (editing.phase === "value") {
          try {
            validateOwnerPassword(editing.buffer);
          } catch (error) {
            editing.error = error instanceof Error ? error.message : String(error);
            return { type: "continue" };
          }
          editing.pending = editing.buffer;
          editing.buffer = "";
          editing.phase = "confirm";
          editing.error = null;
          return { type: "continue" };
        }
        if (editing.buffer !== editing.pending) {
          editing.phase = "value";
          editing.pending = null;
          editing.buffer = "";
          editing.error = "Passwords do not match. Try again.";
          return { type: "continue" };
        }
        state.ownerPassword = editing.pending;
        state.editing = null;
        advanceCursor();
        return { type: "continue" };
      }
      try {
        commitText(editing.rowId, editing.buffer);
      } catch (error) {
        editing.error = error instanceof Error ? error.message : String(error);
        return { type: "continue" };
      }
      state.editing = null;
      advanceCursor();
      return { type: "continue" };
    }
    if (key.name === "backspace") {
      editing.buffer = editing.buffer.slice(0, -1);
      editing.error = null;
      return { type: "continue" };
    }
    if (key.ctrl && key.name === "u") {
      editing.buffer = "";
      editing.error = null;
      return { type: "continue" };
    }
    if (key.ctrl && key.name === "w") {
      editing.buffer = withoutTrailingWord(editing.buffer);
      editing.error = null;
      return { type: "continue" };
    }
    if (key.ctrl || key.meta) return { type: "continue" };
    if (character && PRINTABLE.test(character)) {
      editing.buffer += character;
      editing.error = null;
    }
    return { type: "continue" };
  };

  const activate = (row: SessionRow): SessionOutcome => {
    switch (row.kind) {
      case "option": {
        const [group, value] = row.id.split(":", 2) as [string, string];
        if (group === "access") setAccess(value as AccessMode);
        else if (group === "inference") skipInference();
        else setProvider(value);
        // Jump past the option group so Enter, Enter flows into the field below it.
        const selectable = selectableRows();
        const current = selectable[state.cursors[state.section] ?? 0] ?? -1;
        const nextField = selectable.findIndex(
          (index) => index > current && rows()[index]!.kind !== "option"
        );
        if (nextField >= 0) state.cursors[state.section] = nextField;
        else if (state.section < LAUNCH_SECTION) moveToSection(state.section + 1);
        return { type: "continue" };
      }
      case "text":
        if (row.value || row.id === "custom.name") {
          try {
            commitText(row.id, row.value);
            advanceCursor();
          } catch (error) {
            state.notice = {
              text: error instanceof Error ? error.message : String(error),
              tone: "warning",
            };
          }
        } else {
          startEditing(row);
        }
        return { type: "continue" };
      case "toggle":
        if (row.id === "httpAck") state.httpAcknowledged = !state.httpAcknowledged;
        else if (row.id === "authenticate") state.authenticate = !state.authenticate;
        else if (row.id === "custom.reasoning") state.custom.reasoning = !state.custom.reasoning;
        if (row.id === "httpAck" && state.httpAcknowledged) advanceCursor();
        return { type: "continue" };
      case "cycle":
        if (row.id === "custom.api") {
          const index = CUSTOM_PROVIDER_APIS.indexOf(state.custom.api);
          state.custom.api = CUSTOM_PROVIDER_APIS[(index + 1) % CUSTOM_PROVIDER_APIS.length]!;
        } else if (row.id === "thinking") {
          const index = THINKING_LEVELS.indexOf(state.thinking);
          state.thinking = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
        } else if (row.id === "authType") {
          state.authType = state.authType === "oauth" ? "api_key" : "oauth";
        }
        return { type: "continue" };
      case "action": {
        if (row.id === "cancel") return { type: "cancel" };
        const remaining = problems();
        const first = remaining[0];
        if (first) {
          state.notice = { text: first.message, tone: "warning" };
          state.section = first.section;
          focusRow(first.section, first.rowId);
          return { type: "continue" };
        }
        return { type: "complete", configuration: configuration() };
      }
      default:
        return { type: "continue" };
    }
  };

  const handle = (character: string, key: SessionKey = {}): SessionOutcome => {
    if (state.editing) return handleEditing(character, key, state.editing);
    state.notice = null;
    if (key.ctrl && key.name === "c") return { type: "interrupt" };
    if (key.name === "escape") return { type: "cancel" };
    if (key.name === "left" || (key.name === "tab" && key.shift)) {
      moveToSection(state.section - 1);
      return { type: "continue" };
    }
    if (key.name === "right" || key.name === "tab") {
      moveToSection(state.section + 1);
      return { type: "continue" };
    }
    if (key.name === "up") {
      moveCursor(-1);
      return { type: "continue" };
    }
    if (key.name === "down") {
      moveCursor(1);
      return { type: "continue" };
    }
    if (key.name === "home") {
      state.cursors[state.section] = 0;
      return { type: "continue" };
    }
    if (key.name === "end") {
      state.cursors[state.section] = Math.max(0, selectableRows().length - 1);
      return { type: "continue" };
    }
    const focusedIndex = cursorRow();
    const focused = focusedIndex >= 0 ? rows()[focusedIndex] : undefined;
    if (
      focused?.kind === "text" &&
      character &&
      PRINTABLE.test(character) &&
      !key.ctrl &&
      !key.meta
    ) {
      startEditing(focused, character);
      return { type: "continue" };
    }
    if (/^[1-9]$/.test(character)) {
      const options = selectableRows().filter((index) => rows()[index]!.kind === "option");
      const position = Number(character) - 1;
      const target = options[position];
      if (target !== undefined) {
        state.cursors[state.section] = selectableRows().indexOf(target);
        return activate(rows()[target]!);
      }
      return { type: "continue" };
    }
    if (key.name === "return" || key.name === "enter" || key.name === "space") {
      const index = cursorRow();
      const row = index >= 0 ? rows()[index] : undefined;
      return row ? activate(row) : { type: "continue" };
    }
    return { type: "continue" };
  };

  const view = (): SetupSessionView => {
    const stage = input.stages[state.section];
    const sectionProblems = problems();
    return {
      version: input.version,
      stages: visibleStages,
      activeStage: state.section - firstSection,
      completed: visibleStages.map((_stage, index) => {
        const section = index + firstSection;
        return (
          section < LAUNCH_SECTION &&
          Boolean(state.visited[section]) &&
          !sectionProblems.some((problem) => problem.section === section)
        );
      }),
      title: `${state.section - firstSection + 1}. ${stage?.label ?? ""}`,
      description: stage?.description ?? "",
      rows: rows(),
      cursorRow: cursorRow(),
      mode: state.editing ? "edit" : "navigate",
      notice: state.notice,
    };
  };

  // Advanced setup starts on the chosen connection. The normal flow asks for an
  // address only when one could not be detected.
  focusRow(ACCESS_SECTION, advanced ? `access:${state.accessMode}` : "host");
  focusRow(INFERENCE_SECTION, `provider:${state.provider}`);

  return { state, view, rows, problems, configuration, handle };
};

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_LINE = "\u001b[2K";

/**
 * Drive a setup session on the current terminal. Resolves with the configuration
 * once the user applies it, `null` when they cancel, and rejects on Ctrl-C.
 */
export const runSetupSession = (input: SetupSessionInput): Promise<SetupConfiguration | null> =>
  new Promise((resolve, reject) => {
    const session = createSetupSession(input);
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    const styled = colorEnabled();
    let rendered = 0;
    let offset = 0;

    const paint = (lines: readonly string[]) => {
      const chunks: string[] = [];
      if (rendered > 0) chunks.push(`\r${rendered > 1 ? `\u001b[${rendered - 1}A` : ""}`);
      const total = Math.max(rendered, lines.length);
      for (let index = 0; index < total; index += 1) {
        chunks.push(`${CLEAR_LINE}${lines[index] ?? ""}${index < total - 1 ? "\n" : ""}`);
      }
      const target = Math.max(lines.length, 1) - 1;
      const climb = total - 1 - target;
      if (climb > 0) chunks.push(`\r\u001b[${climb}A`);
      stdout.write(chunks.join(""));
      rendered = lines.length;
    };

    const frame = (): string[] => {
      const columns = stdout.columns;
      const rows = typeof stdout.rows === "number" && stdout.rows > 0 ? stdout.rows : 24;
      const view = renderSetupSession({ ...session.view(), width: columns, color: styled });
      const bodyLimit = Math.max(6, rows - view.header.length - view.footer.length - 1);
      const clamped = clampViewport(view.body, view.cursorLine, bodyLimit, offset, styled);
      offset = clamped.offset;
      return [...view.header, ...clamped.lines, ...view.footer];
    };

    const render = () => paint(frame());
    const onResize = () => {
      // Old lines rewrap unpredictably at a new width, so start from a clean screen.
      stdout.write("\u001b[2J\u001b[H");
      rendered = 0;
      render();
    };
    const finish = () => {
      stdin.off("keypress", onKeypress);
      stdout.off("resize", onResize);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      // readline resumes stdin for any later prompt; pausing prevents a finished
      // session from keeping Node or Bun alive.
      stdin.pause();
      paint([]);
      stdout.write(SHOW_CURSOR);
    };
    const onKeypress = (character = "", key: SessionKey = {}) => {
      let outcome: SessionOutcome;
      try {
        outcome = session.handle(character, key);
      } catch (error) {
        finish();
        reject(error);
        return;
      }
      if (outcome.type === "continue") {
        render();
        return;
      }
      finish();
      if (outcome.type === "complete") resolve(outcome.configuration);
      else if (outcome.type === "cancel") resolve(null);
      else reject(new CliError("Setup cancelled."));
    };

    emitKeypressEvents(stdin);
    stdin.on("keypress", onKeypress);
    stdout.on("resize", onResize);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);
    render();
  });
