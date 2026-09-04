import { emitKeypressEvents } from "node:readline";
import { API_PORT } from "./constants";
import type { DetectedLogin, ReusableProvider } from "./detected-logins";
import { CliError } from "./errors";
import type { RuntimeInferenceSettings } from "./runtime-settings";
import {
  ACCESS_CHOICES,
  accessLabel,
  type AccessMode,
  BUILTIN_PROVIDER_CHOICES,
  bindHostsFor,
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_CHOICE,
  configuredAccessMode,
  type CustomProviderApi,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_RUNTIME_INFERENCE,
  defaultProviderAuthType,
  existingReachableHost,
  publicUrlFor,
  recommendedAccessMode,
  type SetupConfiguration,
  THINKING_LEVELS,
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
  /** Vendor CLI sign-ins found on this machine that Pi can reuse. */
  detectedLogins?: readonly DetectedLogin[];
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

/** Sections the user can move between with left/right; Review is the last one. */
export const SESSION_SECTION_COUNT = 4;
const ACCESS_SECTION = 0;
const OWNER_SECTION = 1;
const RUNTIME_SECTION = 2;
const REVIEW_SECTION = 3;

interface ProviderOption {
  id: string;
  provider: string;
  authType: "oauth" | "api_key";
  label: string;
  description: string;
}

const BUILTIN_PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    id: "openai-codex",
    provider: "openai-codex",
    authType: "oauth",
    label: "OpenAI with ChatGPT Plus/Pro",
    description: "Sign in to ChatGPT in the browser once the stack is up.",
  },
  {
    id: "anthropic",
    provider: "anthropic",
    authType: "oauth",
    label: "Anthropic with Claude Pro/Max",
    description: "Sign in to Claude in the browser; harness traffic may bill as extra usage.",
  },
  {
    id: "anthropic-key",
    provider: "anthropic",
    authType: "api_key",
    label: "Anthropic with an API key",
    description: "Paste an Anthropic API key.",
  },
  {
    id: "openai",
    provider: "openai",
    authType: "api_key",
    label: "OpenAI with an API key",
    description: "Paste an OpenAI API key for directly billed models.",
  },
];
const PRINTABLE = /^[^\p{Cc}]+$/u;

const hostLabel = (mode: AccessMode): { label: string; placeholder: string } => {
  if (mode === "https" || mode === "proxy") {
    return { label: "Public domain", placeholder: "bot.example.com (A/AAAA record points here)" };
  }
  if (mode === "http") return { label: "Public host", placeholder: "hostname or IPv4 address" };
  return { label: "Private host", placeholder: "hostname or IPv4 address" };
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
  const initialAccess = configuredAccessMode(input.current, fresh, detectedPrivateHost);
  const recommendedAccess = recommendedAccessMode(detectedPrivateHost);
  const existingHost = existingReachableHost(input.current);
  const currentThinking = currentInference.reasoning as ThinkingLevel;
  // A stored private address is a poor default for a public domain field; leave it blank instead.
  const defaultHostFor = (mode: AccessMode): string => {
    if (mode === "local") return "";
    if (mode === "https" || mode === "proxy") {
      if (!existingHost) return "";
      try {
        return validatePublicDomain(existingHost);
      } catch {
        return "";
      }
    }
    if (mode === "http") return existingHost ?? "";
    return existingHost ?? detectedPrivateHost ?? "";
  };

  const detectedLogins = input.detectedLogins ?? [];
  const detectedFor = (provider: string, authType: string): DetectedLogin | undefined =>
    authType === "oauth" ? detectedLogins.find((login) => login.provider === provider) : undefined;
  // A sign-in already on this machine beats the stock default while nothing is authenticated.
  const initialOption = input.authenticated
    ? undefined
    : BUILTIN_PROVIDER_OPTIONS.find((option) => detectedFor(option.provider, option.authType));
  const initialProvider = initialOption?.provider ?? currentProvider;
  const initialAuthType = initialOption?.authType ?? defaultProviderAuthType(currentProvider);
  const initialModel =
    initialOption && initialOption.provider !== currentProvider
      ? (DEFAULT_PROVIDER_MODELS[initialOption.provider] ?? currentInference.modelId)
      : currentInference.modelId;

  const state: SessionState = {
    section: ACCESS_SECTION,
    cursors: new Array<number>(SESSION_SECTION_COUNT).fill(0),
    accessMode: initialAccess,
    host: defaultHostFor(initialAccess),
    httpAcknowledged: false,
    ownerUsername: input.currentOwnerUsername || "openteam",
    ownerPassword: null,
    apiPort: input.current.get("OPENTEAM_API_PORT") || String(API_PORT),
    timeZone: input.current.get("OPENTEAM_TIME_ZONE") || "UTC",
    workerConcurrency: input.current.get("OPENTEAM_WORKER_CONCURRENCY") || "8",
    thinking: THINKING_LEVELS.includes(currentThinking) ? currentThinking : "high",
    provider: initialProvider,
    model: initialModel,
    custom: {
      id: "my-provider",
      name: "",
      baseUrl: "",
      api: "openai-responses",
      model: "",
      reasoning: true,
    },
    authenticate: !input.authenticated,
    authType: initialAuthType,
    apiKey: null,
    editing: null,
    notice: null,
  };

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
    const rows: SessionRow[] = [{ kind: "heading", text: "Access mode" }];
    for (const choice of ACCESS_CHOICES) {
      rows.push({
        kind: "option",
        id: `access:${choice.value}`,
        label: choice.title,
        description: choice.description,
        selected: state.accessMode === choice.value,
        ...(choice.value === recommendedAccess ? { recommended: true } : {}),
      });
    }
    if (state.accessMode !== "local") {
      const { label, placeholder } = hostLabel(state.accessMode);
      rows.push({ kind: "heading", text: "Address" });
      rows.push(textRow("host", label, state.host, { placeholder }));
    }
    if (state.accessMode === "http") {
      rows.push({
        kind: "toggle",
        id: "httpAck",
        label: "Continue without encryption",
        description:
          "Passwords and session tokens travel in cleartext, and the iOS app refuses public HTTP.",
        checked: state.httpAcknowledged,
      });
    }
    return rows;
  };

  const ownerRows = (): SessionRow[] => {
    if (ownerConfigured) {
      return [
        {
          kind: "note",
          text: `Keeping the existing owner account (${state.ownerUsername}) and active sessions. Change it with openteam account update.`,
          tone: "success",
        },
      ];
    }
    return [
      { kind: "heading", text: "Owner account" },
      textRow("username", "Username", state.ownerUsername),
      textRow("password", "Password", state.ownerPassword ?? "", {
        placeholder: "8-128 characters, required",
        secret: true,
        editingLabel: state.editing?.phase === "confirm" ? "Confirm password" : undefined,
      }),
    ];
  };

  const runtimeRows = (): SessionRow[] => {
    const rows: SessionRow[] = [];
    if (advanced) {
      rows.push({ kind: "heading", text: "Server" });
      rows.push(textRow("apiPort", "API port", state.apiPort));
      rows.push(textRow("timeZone", "Time zone", state.timeZone));
    }
    rows.push({ kind: "heading", text: "Inference provider" });
    for (const option of providerOptions()) {
      const detected = detectedFor(option.provider, option.authType);
      rows.push({
        kind: "option",
        id: `provider:${option.id}`,
        label: option.label,
        description: detected
          ? `Reuses your ${detected.source} sign-in; no browser login needed.`
          : option.description,
        selected: state.provider === option.provider && state.authType === option.authType,
        ...(option.provider === initialProvider && option.authType === initialAuthType
          ? { recommended: true }
          : {}),
        ...(detected ? { badge: "detected" } : {}),
      });
    }
    rows.push({ kind: "heading", text: "Model" });
    if (state.provider === "custom") {
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
        label: "Compatible API",
        value: state.custom.api,
      });
      rows.push(
        textRow("custom.model", "Model", state.custom.model, { placeholder: "model id (required)" })
      );
      rows.push({
        kind: "toggle",
        id: "custom.reasoning",
        label: "This model supports reasoning",
        checked: state.custom.reasoning,
      });
    } else {
      rows.push(textRow("model", "Model", state.model, { placeholder: "model id (required)" }));
    }
    if (advanced) {
      rows.push({
        kind: "cycle",
        id: "thinking",
        label: "Reasoning effort",
        value: state.thinking,
      });
      rows.push(textRow("workerConcurrency", "Concurrent bot jobs", state.workerConcurrency));
    }
    rows.push({ kind: "heading", text: "Authentication" });
    const again = input.authenticated && state.provider === currentProvider;
    rows.push({
      kind: "toggle",
      id: "authenticate",
      label: `Configure ${providerId()} authentication ${again ? "again" : "now"}`,
      checked: state.authenticate,
    });
    if (state.authenticate && state.authType === "api_key") {
      rows.push(
        textRow("apiKey", "API key or password", state.apiKey ?? "", {
          placeholder: "required",
          secret: true,
        })
      );
    }
    return rows;
  };

  const providerOptions = (): readonly ProviderOption[] => {
    const options: ProviderOption[] = [...BUILTIN_PROVIDER_OPTIONS];
    if (!currentProviderIsBuiltin) {
      options.push({
        id: currentProvider,
        provider: currentProvider,
        authType: "api_key",
        label: `Keep existing provider (${currentProvider})`,
        description: "Reuse the custom provider already registered with Pi.",
      });
    }
    options.push({
      id: "custom",
      provider: "custom",
      authType: "api_key",
      label: CUSTOM_PROVIDER_CHOICE.label,
      description: CUSTOM_PROVIDER_CHOICE.description,
    });
    return options;
  };

  const reusableProvider = (): ReusableProvider | null =>
    state.provider === "openai-codex" || state.provider === "anthropic" ? state.provider : null;

  const reuseLogin = (): { provider: ReusableProvider; source: string } | undefined => {
    const provider = reusableProvider();
    if (!provider || !state.authenticate || state.authType !== "oauth") return undefined;
    const detected = detectedFor(provider, "oauth");
    return detected ? { provider, source: detected.source } : undefined;
  };

  const signInSummary = (): string => {
    if (!state.authenticate) return "unchanged";
    if (state.authType === "api_key") return "API key";
    const reused = reuseLogin();
    return reused ? `reuse ${reused.source}` : "browser sign-in after launch";
  };

  const reviewRows = (): SessionRow[] => {
    const rows: SessionRow[] = [
      { kind: "heading", text: "Summary" },
      { kind: "field", label: "Access", value: accessLabel(state.accessMode) },
      { kind: "field", label: "Address", value: publicUrl() },
      { kind: "field", label: "Owner", value: state.ownerUsername },
      {
        kind: "field",
        label: "Model",
        value: `${providerId()}/${activeModel() || "<model>"} · ${state.thinking}`,
      },
      { kind: "field", label: "Sign-in", value: signInSummary() },
      { kind: "field", label: "API port", value: state.apiPort },
    ];
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
    rows.push({ kind: "action", id: "apply", label: "Apply and start OpenTeam", primary: true });
    rows.push({ kind: "action", id: "cancel", label: "Cancel without changes" });
    return rows;
  };

  const rows = (section = state.section): readonly SessionRow[] => {
    switch (section) {
      case ACCESS_SECTION:
        return accessRows();
      case OWNER_SECTION:
        return ownerRows();
      case RUNTIME_SECTION:
        return runtimeRows();
      default:
        return reviewRows();
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
          message: `${label} is required in Access.`,
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
          message: "Acknowledge the public HTTP warning in Access.",
        });
      }
    }
    if (!ownerConfigured && !state.ownerPassword) {
      found.push({
        section: OWNER_SECTION,
        rowId: "password",
        message: "Set the owner password in Owner.",
      });
    }
    if (state.provider === "custom") {
      if (!state.custom.id) {
        found.push({
          section: RUNTIME_SECTION,
          rowId: "custom.id",
          message: "Enter the custom provider id in Runtime.",
        });
      }
      if (!state.custom.baseUrl) {
        found.push({
          section: RUNTIME_SECTION,
          rowId: "custom.baseUrl",
          message: "Enter the custom provider base URL in Runtime.",
        });
      }
      if (!state.custom.model) {
        found.push({
          section: RUNTIME_SECTION,
          rowId: "custom.model",
          message: "Enter the custom provider model in Runtime.",
        });
      }
    } else if (!state.model) {
      found.push({
        section: RUNTIME_SECTION,
        rowId: "model",
        message: "Enter the inference model in Runtime.",
      });
    }
    if (state.authenticate && state.authType === "api_key" && !state.apiKey) {
      found.push({
        section: RUNTIME_SECTION,
        rowId: "apiKey",
        message: `Enter the ${providerId()} API key or password in Runtime.`,
      });
    }
    return found;
  };

  const configuration = (): SetupConfiguration => {
    const remaining = problems();
    if (remaining.length) throw new CliError(remaining[0]!.message);
    const host = reachableHost();
    const custom = state.provider === "custom";
    return {
      accessMode: state.accessMode,
      ...bindHostsFor(state.accessMode, host),
      publicUrl: publicUrlFor(state.accessMode, host, state.apiPort),
      ownerUsername: state.ownerUsername,
      ownerPassword: ownerConfigured ? undefined : (state.ownerPassword ?? undefined),
      apiPort: state.apiPort,
      timeZone: state.timeZone,
      provider: custom ? state.custom.id : state.provider,
      model: activeModel(),
      thinking: state.thinking,
      workerConcurrency: state.workerConcurrency,
      authenticate: state.authenticate,
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
      reuseLogin: reuseLogin(),
    };
  };

  const setAccess = (mode: AccessMode): void => {
    state.accessMode = mode;
    if (!state.host) state.host = defaultHostFor(mode);
  };

  const setProvider = (next: string, authType: "oauth" | "api_key"): void => {
    if (next === state.provider && authType === state.authType) return;
    const sameAsCurrent =
      next === currentProvider && authType === defaultProviderAuthType(currentProvider);
    state.provider = next;
    if (next !== "custom") {
      state.model =
        next === currentProvider
          ? currentInference.modelId
          : (DEFAULT_PROVIDER_MODELS[next] ?? currentInference.modelId);
    }
    state.authenticate = !input.authenticated || !sameAsCurrent;
    state.authType = authType;
    state.apiKey = null;
  };

  const moveCursor = (delta: number): void => {
    const selectable = selectableRows();
    if (!selectable.length) return;
    const current = state.cursors[state.section] ?? 0;
    state.cursors[state.section] = (current + delta + selectable.length) % selectable.length;
  };

  const advanceCursor = (): void => {
    const selectable = selectableRows();
    const current = state.cursors[state.section] ?? 0;
    if (current < selectable.length - 1) state.cursors[state.section] = current + 1;
  };

  const sectionProblems = (section: number): SessionProblem[] =>
    problems().filter((problem) => problem.section === section);

  /** Point the highlight at the next missing field in this section, wrapping to the first. */
  const focusProblem = (section: number): void => {
    const remaining = sectionProblems(section);
    if (!remaining.length) return;
    const selectable = selectableRows(section);
    const ids = selectable.map((index) => rowId(rows(section)[index]!));
    const current = state.cursors[section] ?? 0;
    const positions = remaining
      .map((problem) => ids.indexOf(problem.rowId))
      .filter((position) => position >= 0);
    const next = positions.find((position) => position > current) ?? positions[0];
    if (next !== undefined) state.cursors[section] = next;
  };

  /** Move to the next section that has something to do; Review always waits for Apply. */
  const advanceSection = (): void => {
    let next = state.section + 1;
    while (next < REVIEW_SECTION && selectableRows(next).length === 0) next += 1;
    state.section = Math.min(next, REVIEW_SECTION);
  };

  /** A choice was made: leave the section when nothing is missing, else show what is. */
  const finishSelection = (): void => {
    if (state.section >= REVIEW_SECTION) return;
    if (sectionProblems(state.section).length === 0) advanceSection();
    else focusProblem(state.section);
  };

  /** A field was saved: the section is done once its last field is filled in. */
  const finishField = (): void => {
    if (state.section >= REVIEW_SECTION) return;
    if (sectionProblems(state.section).length) {
      focusProblem(state.section);
      return;
    }
    const selectable = selectableRows();
    const current = state.cursors[state.section] ?? 0;
    if (current >= selectable.length - 1) advanceSection();
    else advanceCursor();
  };

  const startEditing = (row: Extract<SessionRow, { kind: "text" }>): void => {
    state.editing = {
      rowId: row.id,
      buffer: row.secret ? "" : row.value,
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
        store(validateIntegerInRange("Concurrent bot jobs", 1, 64), (normalized) => {
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
        if (!value) throw new Error("Provider API key or password cannot be empty.");
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
        finishField();
        return { type: "continue" };
      }
      try {
        commitText(editing.rowId, editing.buffer);
      } catch (error) {
        editing.error = error instanceof Error ? error.message : String(error);
        return { type: "continue" };
      }
      state.editing = null;
      finishField();
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
        if (group === "access") {
          setAccess(value as AccessMode);
        } else {
          const option = providerOptions().find((candidate) => candidate.id === value);
          if (option) setProvider(option.provider, option.authType);
        }
        finishSelection();
        return { type: "continue" };
      }
      case "text":
        startEditing(row);
        return { type: "continue" };
      case "toggle":
        if (row.id === "httpAck") {
          state.httpAcknowledged = !state.httpAcknowledged;
          finishSelection();
        } else if (row.id === "authenticate") state.authenticate = !state.authenticate;
        else if (row.id === "custom.reasoning") state.custom.reasoning = !state.custom.reasoning;
        return { type: "continue" };
      case "cycle":
        if (row.id === "custom.api") {
          const index = CUSTOM_PROVIDER_APIS.indexOf(state.custom.api);
          state.custom.api = CUSTOM_PROVIDER_APIS[(index + 1) % CUSTOM_PROVIDER_APIS.length]!;
        } else if (row.id === "thinking") {
          const index = THINKING_LEVELS.indexOf(state.thinking);
          state.thinking = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
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
      state.section = Math.max(0, state.section - 1);
      return { type: "continue" };
    }
    if (key.name === "right" || key.name === "tab") {
      state.section = Math.min(SESSION_SECTION_COUNT - 1, state.section + 1);
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
      stages: input.stages,
      activeStage: state.section,
      completed: input.stages.map(
        (_stage, index) =>
          index < REVIEW_SECTION && !sectionProblems.some((problem) => problem.section === index)
      ),
      title: `${state.section + 1}. ${stage?.label ?? ""}`,
      description: stage?.description ?? "",
      rows: rows(),
      cursorRow: cursorRow(),
      mode: state.editing ? "edit" : "navigate",
      notice: state.notice,
    };
  };

  // Start on the currently selected access option so Enter simply confirms it.
  focusRow(ACCESS_SECTION, `access:${state.accessMode}`);
  focusRow(RUNTIME_SECTION, `provider:${initialOption?.id ?? state.provider}`);

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
