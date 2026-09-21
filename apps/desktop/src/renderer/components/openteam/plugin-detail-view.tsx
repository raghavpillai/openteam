import type {
PluginBotAccessItemView,
PluginBotAccessView,
PluginCatalogItemView,
PluginConnectionView,
PluginInstallView,
PluginSettingsView,
} from "@openteam/contracts";
import { pluginAuthorization } from "@openteam/product-core/plugin-authorization";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import {
Check,
ChevronDown,
ChevronLeft,
ChevronRight,
Copy,
ExternalLink,
KeyRound,
LoaderCircle,
Plus,
Search
} from "lucide-react";
import { lazy,Suspense,useEffect,useId,useMemo,useState } from "react";
import { api } from "../../client/openteam-api";
import { cn } from "../../lib/cn";
import {
PLUGIN_BOT_ACCESS_PAGE_SIZE,
PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
pluginBotAccessWindow
} from "../../lib/plugin-settings-scale";

const loadPluginSettingsDetail = () => import("./plugin-settings-detail");
const PluginPolicySelect = lazy(() =>
  loadPluginSettingsDetail().then((module) => ({ default: module.PluginPolicySelect }))
);
const PluginAuthSelect = lazy(() =>
  loadPluginSettingsDetail().then((module) => ({ default: module.PluginAuthSelect }))
);

import { AddPluginAccount,PluginAccountRow } from "./plugins/plugin-accounts";
import { PluginMark } from "./plugins/plugin-mark";

type MarketplacePage = "marketplace" | "installed" | "detail" | "custom" | "manage";
type OAuthCallbackSettings = { oauthCallbackMode: "auto" | "desktop" | "server" | "manual"; oauthLoopbackPort: number };

const primaryButton =
  "inline-flex h-[26px] shrink-0 items-center justify-center gap-1.5 cursor-pointer rounded-full bg-black px-3 text-[13px] font-medium text-white outline-none transition-opacity duration-120 ease-out hover:opacity-80 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-45 dark:bg-white dark:text-black";
const secondaryButton =
  "inline-flex h-[26px] shrink-0 items-center justify-center gap-1.5 cursor-pointer rounded-full bg-[#77777717] px-3 text-[13px] text-foreground outline-none transition-colors duration-120 ease-out hover:bg-[#7777772b] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-45";

const errorMessage = (cause: unknown) => clientErrorMessage(cause, "Plugin operation failed");

const installFor = (data: PluginSettingsView, pluginKey: string) =>
  data.installs.find((plugin) => plugin.pluginKey === pluginKey);

const catalogPluginForInstall = (install: PluginInstallView): PluginCatalogItemView => ({
  key: install.pluginKey,
  version: install.version,
  name: install.name,
  description: install.description,
  publisher: install.publisher,
  category: "MCP",
  featured: false,
  installed: true,
  components: [
    ...(install.hasSkills ? (["skills"] as const) : []),
    ...(install.connections.length ? (["mcp"] as const) : []),
  ],
  connections: install.connections.map((connection) => ({
    key: connection.connectorKey,
    name: connection.name,
    transport: connection.transport,
    auth: connection.auth,
    tools: connection.tools,
  })),
  skills: [],
  homepageUrl: null,
  sourceUrl: null,
  sourceRevision: null,
  logoUrl: null,
  setupFields: [],
  setup: null,
});

export function CustomMcpView({
  busy,
  onBack,
  onSubmit,
}: {
  busy: boolean;
  onBack: () => void;
  onSubmit: (input: {
    name: string;
    url?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    auth: "none" | "token" | "oauth";
    alias: string;
  }) => void;
}) {
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [args, setArgs] = useState("[]");
  const [cwd, setCwd] = useState("");
  const [configuration, setConfiguration] = useState("");
  const [auth, setAuth] = useState<"none" | "token" | "oauth">("none");
  const [alias, setAlias] = useState("default");
  const field =
    "h-9 w-full rounded-[8px] border border-black/10 bg-black/[0.035] px-3 text-[12px] outline-none focus:border-black/20 dark:border-white/10 dark:bg-[#222] dark:focus:border-white/20";
  const parsedConfiguration = (() => {
    if (!configuration.trim()) return {};
    try {
      const value = JSON.parse(configuration) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const entries = Object.entries(value);
      if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
        return null;
      }
      return Object.fromEntries(entries);
    } catch {
      return null;
    }
  })();
  const parsedArgs = (() => {
    try {
      const value: unknown = JSON.parse(args);
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as string[])
        : null;
    } catch {
      return null;
    }
  })();
  const valid =
    name.trim().length >= 2 &&
    location.trim().length > 0 &&
    parsedConfiguration !== null &&
    (transport !== "stdio" || parsedArgs !== null);
  return (
    <form
      className="mx-auto w-full max-w-[560px] px-8 pb-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit({
          name: name.trim(),
          ...(transport === "http"
            ? { url: location.trim() }
            : {
                command: location.trim(),
                args: parsedArgs ?? [],
                cwd: cwd.trim() || undefined,
              }),
          ...(transport === "stdio"
            ? { env: parsedConfiguration ?? undefined }
            : { headers: parsedConfiguration ?? undefined }),
          auth,
          alias: alias.trim() || "default",
        });
      }}
    >
      <button
        className="mb-6 inline-flex items-center gap-1 text-[11px] text-foreground-secondary hover:text-foreground"
        onClick={onBack}
        type="button"
      >
        <ChevronLeft className="size-3.5" /> Back to Installed
      </button>
      <div className="mb-6">
        <h2 className="text-[15px] font-medium">Add custom MCP</h2>
        <p className="mt-1 text-[11.5px] leading-5 text-foreground-secondary">
          Remote servers run through OpenTeam. Local commands run on the shared bot computer.
        </p>
      </div>
      <div className="space-y-4 rounded-[14px] bg-black/[0.035] p-4 dark:bg-white/[0.055]">
        <label className="block text-[11px] text-foreground-secondary">
          Name
          <input
            className={cn(field, "mt-1.5")}
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
        </label>
        <div>
          <div className="mb-1.5 text-[11px] text-foreground-secondary">Transport</div>
          <div className="inline-flex rounded-[8px] bg-black/[0.06] p-0.5 dark:bg-black/30">
            {(["http", "stdio"] as const).map((value) => (
              <button
                className={cn(
                  "h-7 rounded-[6px] px-3 text-[11px] capitalize",
                  transport === value && "bg-background shadow-sm"
                )}
                key={value}
                onClick={() => setTransport(value)}
                type="button"
              >
                {value === "http" ? "Remote HTTP" : "Local stdio"}
              </button>
            ))}
          </div>
        </div>
        <label className="block text-[11px] text-foreground-secondary">
          {transport === "http" ? "MCP URL" : "Command"}
          <input
            className={cn(field, "mt-1.5 font-mono")}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={transport === "http" ? "https://example.com/mcp" : "npx"}
            value={location}
          />
        </label>
        {transport === "stdio" ? (
          <>
            <label className="block text-[11px] text-foreground-secondary">
              Arguments (JSON array)
              <input
                className={cn(field, "mt-1.5 font-mono")}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={'["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]'}
                value={args}
              />
            </label>
            <label className="block text-[11px] text-foreground-secondary">
              Working directory on Bot computer
              <input
                className={cn(field, "mt-1.5 font-mono")}
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/workspace"
              />
            </label>
            <label className="block text-[11px] text-foreground-secondary">
              Environment JSON (optional)
              <textarea
                className={cn(field, "mt-1.5 h-20 resize-none py-2 font-mono")}
                onChange={(e) => setConfiguration(e.target.value)}
                placeholder={'{"API_KEY":"value"}'}
                value={configuration}
              />
            </label>
          </>
        ) : (
          <>
            <div className="text-[11px] text-foreground-secondary">
              <span>Authentication</span>
              <Suspense
                fallback={
                  <span
                    aria-hidden="true"
                    className={cn(
                      field,
                      "mt-1.5 flex items-center text-foreground capitalize shadow-none"
                    )}
                  >
                    {auth}
                  </span>
                }
              >
                <PluginAuthSelect
                  className={cn(field, "mt-1.5 text-foreground shadow-none")}
                  onChange={setAuth}
                  value={auth}
                />
              </Suspense>
            </div>
            <label className="block text-[11px] text-foreground-secondary">
              Headers JSON (optional)
              <textarea
                className={cn(field, "mt-1.5 h-20 resize-none py-2 font-mono")}
                onChange={(e) => setConfiguration(e.target.value)}
                placeholder={'{"X-API-Key":"value"}'}
                value={configuration}
              />
            </label>
          </>
        )}
        <label className="block text-[11px] text-foreground-secondary">
          Account label
          <input
            className={cn(field, "mt-1.5")}
            onChange={(e) => setAlias(e.target.value)}
            value={alias}
          />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className={secondaryButton} onClick={onBack} type="button">
          Cancel
        </button>
        <button className={primaryButton} disabled={!valid || busy} type="submit">
          {busy ? <LoaderCircle className="size-3 animate-spin" /> : <Plus className="size-3" />}{" "}
          Add server
        </button>
      </div>
    </form>
  );
}

function DetailBlock({
  children,
  count,
  label,
  onOpenChange,
  open = false,
}: {
  children: React.ReactNode;
  count: number;
  label: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(open);
  const contentId = useId();
  const singular =
    label === "Connectors"
      ? "connector"
      : label === "Skills"
        ? "skill"
        : label === "Accounts"
          ? "account"
          : label === "Bot access"
            ? "bot"
            : label === "Tool policies"
              ? "tool"
              : "event";
  return (
    <section className="mt-6">
      <h3 className="mb-2 px-3.5 text-[13px] font-normal text-foreground-tertiary">{label}</h3>
      <div className="overflow-hidden rounded-[14px] bg-black/[0.08] dark:bg-white/[0.08]">
        <button
          aria-expanded={expanded}
          aria-controls={expanded ? contentId : undefined}
          className="flex min-h-[42px] w-full cursor-pointer items-center rounded-[14px] px-3.5 py-3 text-left text-[13px] leading-[18px] outline-none transition-colors duration-120 ease-out hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 aria-expanded:rounded-b-none dark:hover:bg-white/[0.08]"
          onClick={() => {
            setExpanded(!expanded);
            onOpenChange?.(!expanded);
          }}
          type="button"
        >
          <span className="flex-1">
            {count} {singular}
            {count === 1 ? "" : "s"}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 text-foreground-tertiary transition-transform duration-120 ease-out",
              expanded && "rotate-180"
            )}
          />
        </button>
        {expanded && <div id={contentId}>{children}</div>}
      </div>
    </section>
  );
}

function SquareToggle({
  busy,
  checked,
  label,
  onClick,
}: {
  busy: boolean;
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={cn(
        "grid size-5 cursor-pointer place-items-center rounded-[6px] border outline-none transition-colors duration-120 ease-out focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait",
        checked
          ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
          : "border-black/15 bg-background dark:border-white/20"
      )}
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {busy ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : checked ? (
        <Check className="size-3" strokeWidth={2.6} />
      ) : null}
    </button>
  );
}

function PluginSetupCard({
  busy,
  connection,
  plugin,
  onAuthenticate,
  onConfigureOAuth,
  onConfigureToken,
  onDismiss,
}: {
  busy: boolean;
  connection: PluginConnectionView;
  plugin: PluginCatalogItemView;
  onAuthenticate: () => void;
  onConfigureOAuth: (input: { clientId: string; clientSecret: string; scope: string }) => void;
  onConfigureToken: (token: string) => void;
  onDismiss: () => void;
}) {
  const setup = plugin.setup;
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (connection.configured) setValues({});
  }, [connection.id, connection.configured]);
  if (!setup || pluginAuthorization(connection)) return null;

  const ready = connection.status === "ready";
  const missingRequired = setup.fields.some(
    (field) => field.required && !values[field.key]?.trim()
  );
  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  };
  const submit = () => {
    if (setup.kind === "token") {
      if (connection.configured) onAuthenticate();
      else onConfigureToken(values.token?.trim() ?? "");
      return;
    }
    if (setup.kind === "oauth_client" && (!connection.configured || Object.keys(values).length)) {
      onConfigureOAuth({
        clientId: values.clientId?.trim() ?? "",
        clientSecret: values.clientSecret ?? "",
        scope: values.scope?.trim() ?? "",
      });
      return;
    }
    onAuthenticate();
  };
  const actionLabel = ready
    ? "Connected"
    : setup.kind === "token"
      ? connection.configured
        ? "Reconnect"
        : "Save token and connect"
      : setup.kind === "oauth_client"
        ? connection.configured
          ? "Authorize account"
          : "Save credentials and continue"
        : setup.kind === "none" ? "Connect" : "Continue to authorization";

  return (
    <section
      className={cn(
        "mt-5 overflow-hidden rounded-[12px] border",
        ready
          ? "border-emerald-500/20 bg-emerald-500/[0.045]"
          : "border-black/[0.07] bg-black/[0.025] dark:border-white/[0.08] dark:bg-white/[0.035]"
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
            ready
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-black/[0.06] text-foreground-secondary dark:bg-white/[0.08]"
          )}
        >
          {ready ? (
            <Check className="size-3.5" strokeWidth={2.4} />
          ) : (
            <KeyRound className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] font-medium">
              {ready ? `${plugin.name} is connected` : setup.title}
            </div>
            {setup.documentationUrl ? (
              <a
                className="inline-flex shrink-0 items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground"
                href={setup.documentationUrl}
                rel="noreferrer"
                target="_blank"
              >
                Setup guide <ExternalLink className="size-2.5" />
              </a>
            ) : null}
          </div>
          <p className="mt-0.5 text-[10.5px] leading-4 text-foreground-secondary">
            {ready
              ? `${connection.tools.length} tools are available from this account.`
              : setup.description}
          </p>
        </div>
      </div>

      {!ready ? (
        <div className="border-t border-black/[0.055] px-4 py-4 dark:border-white/[0.07]">
          {setup.steps.length ? (
            <ol className="grid gap-2.5">
              {setup.steps.map((step, index) => (
                <li
                  className="flex gap-2.5 text-[10.5px] leading-4 text-foreground-secondary"
                  key={step}
                >
                  <span className="grid size-[18px] shrink-0 place-items-center rounded-full border border-black/10 text-[9px] font-medium text-foreground dark:border-white/15">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}

          {setup.kind === "oauth_client" && connection.oauthRedirectUrl ? (
            <div className="mt-3 rounded-[8px] border border-black/[0.06] bg-background px-3 py-2.5 dark:border-white/[0.08] dark:bg-black/15">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9.5px] font-medium uppercase tracking-[0.04em] text-foreground-tertiary">
                  {connection.oauthCallbackMode === "manual" ? "Manual callback URI" : "Authorized redirect URI"}
                </span>
                <button
                  className="inline-flex items-center gap-1 text-[9.5px] text-foreground-secondary hover:text-foreground"
                  onClick={() => void copy("callback", connection.oauthRedirectUrl ?? "")}
                  type="button"
                >
                  {copied === "callback" ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copied === "callback" ? "Copied" : "Copy"}
                </button>
              </div>
              <code className="mt-1 block select-all break-all text-[10px] text-foreground">
                {connection.oauthRedirectUrl}
              </code>
              {<p className="mt-2 text-[10px] leading-4 text-foreground-secondary">
                {connection.oauthCallbackMode === "manual" ? "Your server uses HTTP. For Google, create a Desktop app OAuth client. Approve access in your browser, then paste the complete callback URL into OpenTeam on this device." : "Register this exact URL with your provider’s Web application OAuth client. HTTPS sign-in returns automatically on desktop or iOS."}
              </p>}
            </div>
          ) : null}

          {setup.requiredScopes.length ? (
            <details className="mt-3 text-[10px] text-foreground-secondary">
              <summary className="cursor-pointer select-none text-foreground-secondary">
                Required provider scopes ({setup.requiredScopes.length})
              </summary>
              <div className="mt-2 flex items-start gap-2 rounded-[8px] bg-black/[0.025] p-2.5 dark:bg-black/15">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all leading-4">
                  {setup.requiredScopes.join("\n")}
                </code>
                <button
                  aria-label="Copy required scopes"
                  className="grid size-6 shrink-0 place-items-center rounded-[6px] hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  onClick={() => void copy("scopes", setup.requiredScopes.join(" "))}
                  type="button"
                >
                  {copied === "scopes" ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
              </div>
            </details>
          ) : null}

          {setup.fields.length && !connection.configured ? (
            <div className="mt-3 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
              {setup.fields.map((field) => (
                <label className="space-y-1" key={field.key}>
                  <span className="block text-[10px] font-medium text-foreground-secondary">
                    {field.label}
                  </span>
                  <input
                    aria-label={field.label}
                    className="h-8 w-full rounded-[7px] border border-black/[0.08] bg-background px-2.5 text-[10.5px] outline-none placeholder:text-foreground-tertiary focus:border-black/20 dark:border-white/10 dark:bg-[#1d1d1d] dark:focus:border-white/20"
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                    placeholder={field.placeholder}
                    type={field.secret ? "password" : "text"}
                    value={values[field.key] ?? ""}
                  />
                  {field.helpText ? (
                    <span className="block text-[9.5px] leading-3.5 text-foreground-tertiary">
                      {field.helpText}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : connection.configured && setup.fields.length ? (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-700 dark:text-emerald-400">
              <Check className="size-3" /> Credentials saved
            </div>
          ) : null}

          {connection.statusMessage ? (
            <p className="mt-3 text-[10px] leading-4 text-foreground-tertiary">
              {connection.statusMessage}
            </p>
          ) : null}
          <button
            className={cn(primaryButton, "mt-3")}
            disabled={busy || (!connection.configured && missingRequired)}
            onClick={submit}
            type="button"
          >
            {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {actionLabel}
          </button>
          <button className={cn(secondaryButton, "ml-2")} type="button" disabled={busy} onClick={onDismiss}>Set up later</button>
        </div>
      ) : null}
    </section>
  );
}

function ConnectionSettingsRow({
  busy,
  connection,
  onAuthenticate,
  onConfigureOAuth,
  onConfigureCallback,
  onConfigureToken,
  onInstructions,
  onRemove,
  onRename,
  onRestart,
}: {
  busy: boolean;
  connection: PluginConnectionView;
  onAuthenticate: () => void;
  onConfigureOAuth: (input: { clientId: string; clientSecret: string; scope: string }) => void;
  onConfigureCallback?: (input: OAuthCallbackSettings) => void;
  onConfigureToken: (token: string) => void;
  onInstructions: (instructions: string) => void;
  onRemove: () => void;
  onRename: (alias: string) => void;
  onRestart: () => void;
}) {
  const [alias, setAlias] = useState(connection.alias);
  const [instructions, setInstructions] = useState(connection.instructions);
  const [token, setToken] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthScope, setOauthScope] = useState("");
  const [callbackMode, setCallbackMode] = useState<OAuthCallbackSettings["oauthCallbackMode"]>("auto");
  const [manualSupported, setManualSupported] = useState(true);
  useEffect(() => { let active = true; void api.pluginConfiguration(connection.id).then(config => { if (active) { setCallbackMode(config.oauthCallbackMode ?? "auto"); setManualSupported(config.manualCallbackSupported !== false); } }).catch(() => {}); return () => { active = false; }; }, [connection.id]);
  const [callbackPort, setCallbackPort] = useState(connection.oauthLoopbackPort ?? 0);
  const field =
    "h-8 rounded-[7px] border border-black/[0.08] bg-background px-2 text-[10.5px] outline-none dark:border-white/10 dark:bg-[#1d1d1d]";
  useEffect(() => setAlias(connection.alias), [connection.alias]);
  useEffect(() => setInstructions(connection.instructions), [connection.instructions]);
  useEffect(() => {
    setCallbackPort(connection.oauthLoopbackPort ?? 0);
  }, [connection.oauthLoopbackPort]);
  return (
    <div className="border-t border-black/[0.055] px-3 py-3 first:border-t-0 dark:border-white/[0.065]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
          {connection.name} · {connection.alias}
        </span>
        <span className="text-[10px] capitalize text-foreground-tertiary">
          {connection.transport} · {connection.status.replace("_", " ")}
        </span>
        {connection.auth === "oauth" && connection.status !== "ready" ? (
          <button
            className={secondaryButton}
            disabled={busy}
            onClick={onAuthenticate}
            type="button"
          >
            Authenticate
          </button>
        ) : null}
        <button className={secondaryButton} disabled={busy} onClick={onRestart} type="button">
          Restart
        </button>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(110px,0.7fr)_minmax(180px,1.4fr)_auto] gap-2 max-sm:grid-cols-1">
        <input
          aria-label="Account alias"
          className={field}
          onChange={(e) => setAlias(e.target.value)}
          value={alias}
        />
        <input
          aria-label="Connector instructions"
          className={field}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Instructions, e.g. reply in threads"
          value={instructions}
        />
        <div className="flex gap-1.5">
          <button
            className={secondaryButton}
            disabled={busy || alias.trim() === connection.alias}
            onClick={() => onRename(alias.trim())}
            type="button"
          >
            Rename
          </button>
          <button
            className={secondaryButton}
            disabled={busy || instructions.trim() === connection.instructions}
            onClick={() => onInstructions(instructions)}
            type="button"
          >
            Save
          </button>
        </div>
      </div>
      {connection.auth === "token" && connection.status !== "ready" ? (
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Bearer token"
            className={cn(field, "min-w-0 flex-1 font-mono")}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token"
            type="password"
            value={token}
          />
          <button
            className={secondaryButton}
            disabled={busy || !token}
            onClick={() => onConfigureToken(token)}
            type="button"
          >
            Save token
          </button>
        </div>
      ) : null}
      {connection.auth === "oauth" && onConfigureCallback ? (
        <div className="mt-3 grid gap-2 text-[10.5px]">
          <label className="grid gap-1">Sign-in callback
            <select className={field} aria-label="Sign-in callback" value={callbackMode} onChange={event => setCallbackMode(event.target.value as OAuthCallbackSettings["oauthCallbackMode"])}>
              <option value="auto">Automatic (recommended)</option>
              <option value="manual" disabled={!manualSupported}>Paste callback URL</option>
              <option value="desktop">Desktop listener (advanced)</option>
              <option value="server">Server callback</option>
            </select>
          </label>
          {callbackMode === "desktop" && <label className="grid gap-1">Desktop callback port (0 = automatic)
            <input className={field} aria-label="Desktop callback port" type="number" min={0} max={65535} value={callbackPort} onChange={event => setCallbackPort(Number(event.target.value))} />
          </label>}
          <p className="text-foreground-secondary">Automatic uses HTTPS when your server has it, or callback paste for HTTP. For Google use a Web application client with HTTPS, or a Desktop app client for manual paste. Changing the method may require a new provider client.</p>
          {!manualSupported && <p className="text-foreground-secondary">This provider requires an HTTPS server callback. Use Tailscale Serve or your own HTTPS domain.</p>}
          <button className={cn(secondaryButton, "justify-self-start")} type="button" disabled={busy} onClick={() => onConfigureCallback({ oauthCallbackMode: callbackMode, oauthLoopbackPort: callbackPort })}>Save callback settings</button>
        </div>
      ) : null}
      {connection.auth === "oauth" && connection.status !== "ready" ? (
        <div className="mt-3 rounded-[9px] bg-black/[0.035] p-3 dark:bg-black/20">
          <div className="mb-2 text-[10.5px] leading-4 text-foreground-secondary">
            {connection.oauthCallbackMode === "manual" ? "Manual sign-in uses a loopback callback. For Google, create a Desktop app client:" : "Current callback URL (save callback settings before registering it):"}
            <code className="mt-1 block select-all break-all text-[10px] text-foreground">
              {connection.oauthRedirectUrl}
            </code>
          </div>
          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
            <input
              aria-label="OAuth client ID"
              className={field}
              onChange={(event) => setOauthClientId(event.target.value)}
              placeholder="OAuth client ID"
              value={oauthClientId}
            />
            <input
              aria-label="OAuth client secret"
              className={field}
              onChange={(event) => setOauthClientSecret(event.target.value)}
              placeholder="OAuth client secret (optional)"
              type="password"
              value={oauthClientSecret}
            />
            <input
              aria-label="OAuth scopes"
              className={cn(field, "col-span-2 max-sm:col-span-1")}
              onChange={(event) => setOauthScope(event.target.value)}
              placeholder="Scopes (optional, space separated)"
              value={oauthScope}
            />
          </div>
          <button
            className={cn(secondaryButton, "mt-2")}
            disabled={busy || !oauthClientId.trim()}
            onClick={() =>
              onConfigureOAuth({
                clientId: oauthClientId.trim(),
                clientSecret: oauthClientSecret,
                scope: oauthScope.trim(),
              })
            }
            type="button"
          >
            Save client and authenticate
          </button>
        </div>
      ) : null}
      <button
        className="mt-3 text-[10.5px] text-red-600 hover:underline dark:text-red-400"
        disabled={busy}
        onClick={onRemove}
        type="button"
      >
        Remove account
      </button>
    </div>
  );
}

export function PluginDetail({
  accessEpoch,
  busy,
  data,
  plugin,
  onAddAccount,
  onGrant,
  onAuthenticate,
  onCancelAuthentication,
  onConfigureToken,
  onConfigureOAuth,
  onConfigureCallback,
  onInstructions,
  onInstall,
  onPolicy,
  onRemoveAccount,
  onRename,
  onRemove,
  onRestart,
  onSkill,
  onToggle,
}: {
  accessEpoch: number;
  busy: string | null;
  data: PluginSettingsView;
  plugin: PluginCatalogItemView;
  onAddAccount: (connection: PluginConnectionView, alias: string) => Promise<boolean>;
  onGrant: (
    connection: PluginConnectionView,
    bot: PluginBotAccessItemView,
    enabled: boolean
  ) => void;
  onAuthenticate: (connection: PluginConnectionView) => void;
  onCancelAuthentication: (connection: PluginConnectionView) => void;
  onConfigureToken: (connection: PluginConnectionView, token: string) => void;
  onConfigureOAuth: (
    connection: PluginConnectionView,
    input: { clientId: string; clientSecret: string; scope: string }
  ) => void;
  onConfigureCallback?: (connection: PluginConnectionView, input: OAuthCallbackSettings) => void;
  onInstructions: (connection: PluginConnectionView, instructions: string) => void;
  onInstall: (plugin: PluginCatalogItemView, values?: Record<string, string>) => void;
  onPolicy: (connectionId: string, toolName: string, decision: "deny" | "prompt" | "allow") => void;
  onRemoveAccount: (connection: PluginConnectionView) => void;
  onRename: (connection: PluginConnectionView, alias: string) => Promise<boolean>;
  onRemove: (plugin: PluginCatalogItemView) => void;
  onRestart: (connection: PluginConnectionView) => void;
  onSkill: (pluginKey: string, bot: PluginBotAccessItemView, enabled: boolean) => void;
  onToggle: (connection: PluginConnectionView) => void;
}) {
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const [setupAccountId, setSetupAccountId] = useState<string | null>(null);
  const [dismissedSetupIds, setDismissedSetupIds] = useState<string[]>([]);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [botAccessExpanded, setBotAccessExpanded] = useState(false);
  const [botAccessQuery, setBotAccessQuery] = useState("");
  const [botAccessOffset, setBotAccessOffset] = useState(0);
  const [botAccess, setBotAccess] = useState<PluginBotAccessView | null>(null);
  const [botAccessLoading, setBotAccessLoading] = useState(false);
  const [botAccessError, setBotAccessError] = useState<string | null>(null);
  const install = installFor(data, plugin.key);
  const connections = install?.connections ?? [];
  const hasBotAccess = Boolean(install && (install.connections.length || install.hasSkills));
  const botAccessScope = install ? `${accessEpoch}:${install.id}` : "";
  const setupConnection =
    connections.find((c) => c.id === setupAccountId && c.status !== "ready") ??
    connections.find((c) => !dismissedSetupIds.includes(c.id) && c.status !== "ready" && (!c.configured || plugin.setup?.kind === "none"));
  const recentActivity = data.activity
    .filter((entry) => entry.pluginKey === plugin.key)
    .slice(0, 8);
  useEffect(() => {
    if (!botAccessScope || !hasBotAccess) {
      setBotAccess(null);
      return;
    }
    if (!botAccessExpanded) return;
    const controller = new AbortController();
    setBotAccess(null);
    setBotAccessError(null);
    const timer = window.setTimeout(
      () => {
        setBotAccessLoading(true);
        api
          .pluginBotAccess(plugin.key, {
            query: botAccessQuery,
            offset: botAccessOffset,
            limit: PLUGIN_BOT_ACCESS_PAGE_SIZE,
            signal: controller.signal,
          })
          .then(setBotAccess)
          .catch((cause) => {
            if (!controller.signal.aborted) setBotAccessError(errorMessage(cause));
          })
          .finally(() => {
            if (!controller.signal.aborted) setBotAccessLoading(false);
          });
      },
      botAccessQuery ? 150 : 0
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    botAccessExpanded,
    botAccessOffset,
    botAccessQuery,
    botAccessScope,
    hasBotAccess,
    plugin.key,
  ]);
  const botAccessWindow = useMemo(
    () => pluginBotAccessWindow(botAccess?.bots ?? [], "", PLUGIN_BOT_ACCESS_PAGE_SIZE),
    [botAccess]
  );
  const visibleBots = botAccessWindow.items;
  return (
    <div className="bot-scrollbar min-h-0 flex-1 overflow-y-auto px-8 pb-8 max-sm:px-5">
      <div className="group/plugin-heading flex items-center gap-3 pt-1">
        <PluginMark logoUrl={plugin.logoUrl} name={plugin.name} size="lg" />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-center gap-1.5 text-[14px] font-medium">
            {plugin.name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-foreground-secondary">
            <span>{plugin.publisher}</span>
            {plugin.sourceUrl || plugin.homepageUrl ? (
              <a
                className="inline-flex items-center gap-1 hover:text-foreground"
                href={plugin.sourceUrl ?? plugin.homepageUrl ?? undefined}
                rel="noreferrer"
                target="_blank"
              >
                {plugin.sourceUrl ? "View Source" : "Website"} <ExternalLink className="size-2.5" />
              </a>
            ) : null}
          </div>
        </div>
        {!install ? (
          <button
            className={cn(primaryButton, "h-9 px-4")}
            disabled={
              busy === plugin.key ||
              plugin.setupFields.some((field) => field.required && !setupValues[field.key]?.trim())
            }
            onClick={() => onInstall(plugin, setupValues)}
            type="button"
          >
            {busy === plugin.key ? <LoaderCircle className="size-3 animate-spin" /> : null}
            Add
          </button>
        ) : (
          <button
            className={cn(secondaryButton, "h-9 px-4")}
            disabled={busy === plugin.key}
            onClick={() => setConfirmUninstall(true)}
            type="button"
          >
            Uninstall
          </button>
        )}
      </div>
      {confirmUninstall && install ? <div role="alert" className="mt-4 rounded-lg border border-red-500/20 p-3 text-[12px]">
        <p>Uninstall {plugin.name}? This removes its accounts, saved authentication and access for all Bots.</p>
        <div className="mt-2 flex gap-2">
          <button className={secondaryButton} type="button" disabled={Boolean(busy)} onClick={() => setConfirmUninstall(false)}>Cancel</button>
          <button className={primaryButton} type="button" disabled={Boolean(busy)} onClick={() => onRemove(plugin)}>Confirm uninstall</button>
        </div>
      </div> : null}
      <p className="mt-4 max-w-[720px] text-[12px] leading-[18px] text-foreground-secondary">
        {plugin.description}
      </p>

      {plugin.installationSteps?.length ? <details className="mt-4 text-[12px]"><summary className="cursor-pointer">Installation steps</summary><ol className="mt-2 list-decimal space-y-1 pl-5">{plugin.installationSteps.map(step => <li key={step}>{step}</li>)}</ol></details> : null}
      {!install && plugin.setup ? <details className="mt-3 text-[12px]"><summary className="cursor-pointer">Provider setup: {plugin.setup.title}</summary><p className="mt-2">{plugin.setup.description}</p><ol className="mt-2 list-decimal space-y-1 pl-5">{plugin.setup.steps.map(step => <li key={step}>{step}</li>)}</ol>{plugin.setup.documentationUrl && <a href={plugin.setup.documentationUrl} target="_blank" rel="noreferrer" className="underline">Provider setup guide</a>}</details> : null}
      {!install && plugin.setupFields.length ? (
        <div className="mt-5 grid grid-cols-2 gap-2 rounded-[10px] bg-black/[0.035] p-3 dark:bg-white/[0.045] max-sm:grid-cols-1">
          {plugin.setupFields.map((field) => (
            <label className="space-y-1" key={field.key}>
              <span className="block text-[10.5px] text-foreground-secondary">{field.label}</span>
              <input
                className="h-8 w-full rounded-[7px] border border-black/[0.08] bg-background px-2.5 text-[11px] outline-none dark:border-white/[0.09]"
                onChange={(event) =>
                  setSetupValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                type={field.secret ? "password" : "text"}
                value={setupValues[field.key] ?? ""}
              />
            </label>
          ))}
        </div>
      ) : null}

      {connections.length ? (
        <section className="mt-8">
          <h3 className="mb-1.5 px-3.5 text-[13px] text-foreground-tertiary">Accounts</h3>
          <div className="overflow-hidden rounded-[14px] bg-black/[0.08] dark:bg-white/[0.08]">
            {connections.map((connection) => (
              <PluginAccountRow
                key={connection.id}
                connection={connection}
                busy={busy === connection.id}
                onRename={(alias) => onRename(connection, alias)}
                onRemove={() => onRemoveAccount(connection)}
                onCancelAuthentication={() => onCancelAuthentication(connection)}
                onConnect={() => {
                  if (!connection.configured && plugin.setup) setSetupAccountId(connection.id);
                  else if (connection.auth === "oauth" && connection.status === "needs_auth")
                    onAuthenticate(connection);
                  else onRestart(connection);
                }}
              >
                <ConnectionSettingsRow
                  busy={busy === connection.id}
                  connection={connection}
                  onAuthenticate={() => onAuthenticate(connection)}
                  onConfigureOAuth={(input) => onConfigureOAuth(connection, input)}
                  onConfigureCallback={onConfigureCallback ? input => onConfigureCallback(connection, input) : undefined}
                  onConfigureToken={(token) => onConfigureToken(connection, token)}
                  onInstructions={(instructions) => onInstructions(connection, instructions)}
                  onRemove={() => onRemoveAccount(connection)}
                  onRename={(alias) => onRename(connection, alias)}
                  onRestart={() => onRestart(connection)}
                />
                {connection.status === "ready" && (
                  <button
                    type="button"
                    className="my-2 text-[12px] text-foreground-secondary hover:text-foreground"
                    onClick={() => onToggle(connection)}
                  >
                    Disconnect
                  </button>
                )}
              </PluginAccountRow>
            ))}
            <AddPluginAccount connections={connections} busy={Boolean(busy)} onAdd={onAddAccount} />
          </div>
          {setupConnection && plugin.setup ? (
            <PluginSetupCard
              key={setupConnection.id}
              busy={busy === setupConnection.id}
              connection={setupConnection}
              onAuthenticate={() => onAuthenticate(setupConnection)}
              onConfigureOAuth={(input) => onConfigureOAuth(setupConnection, input)}
              onConfigureToken={(token) => onConfigureToken(setupConnection, token)}
              onDismiss={() => { setDismissedSetupIds(ids => [...ids, setupConnection.id]); setSetupAccountId(null); }}
              plugin={plugin}
            />
          ) : null}
        </section>
      ) : null}
      {plugin.connections.length ? (
        <DetailBlock count={plugin.connections.length} label="Connectors">
          {plugin.connections.map((connection) => (
            <div
              key={connection.key}
              className="flex min-h-[42px] items-center justify-between gap-2 border-t border-black/[0.055] px-3.5 text-[13px] first:border-t-0 dark:border-white/[0.065]"
            >
              <span>{connection.name}</span>
              <span className="text-[12px] text-foreground-secondary">Connector</span>
            </div>
          ))}
        </DetailBlock>
      ) : null}

      {plugin.skills.length ? (
        <DetailBlock count={plugin.skills.length} label="Skills">
          {[...plugin.skills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((skill) => (
              <div
                className="flex min-h-[42px] items-center gap-2 border-t border-black/[0.055] px-3.5 first:border-t-0 dark:border-white/[0.065]"
                key={skill.name}
              >
                <span className="shrink-0 text-[13px]">{skill.name}</span>
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-foreground-tertiary"
                  title={skill.description}
                >
                  {skill.description}
                </span>
              </div>
            ))}
        </DetailBlock>
      ) : null}

      {install && (connections.length || install.hasSkills) && data.botCount > 0 ? (
        <DetailBlock
          count={botAccessQuery ? (botAccess?.total ?? 0) : data.botCount}
          label="Bot access"
          onOpenChange={setBotAccessExpanded}
          open={false}
        >
          {botAccessExpanded ? (
            <>
              {botAccessQuery || data.botCount > PLUGIN_BOT_ACCESS_PAGE_SIZE ? (
                <div className="border-t border-black/[0.055] p-2 first:border-t-0 dark:border-white/[0.065]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-foreground-tertiary" />
                    <input
                      aria-label="Filter Bot access"
                      className="h-8 w-full rounded-[8px] border border-black/[0.07] bg-background pl-8 pr-2.5 text-[11px] outline-none placeholder:text-foreground-tertiary focus:border-black/15 dark:border-white/[0.09] dark:focus:border-white/20"
                      maxLength={PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH}
                      onChange={(event) => {
                        setBotAccessOffset(0);
                        setBotAccessQuery(event.target.value);
                      }}
                      placeholder="Filter Bots"
                      value={botAccessQuery}
                    />
                  </div>
                </div>
              ) : null}
              {connections.map((connection) => (
                <div
                  className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
                  key={connection.id}
                >
                  <span className="min-w-[145px] flex-1 truncate text-[11.5px]">
                    {connection.name} · {connection.alias}
                  </span>
                  <div className="flex flex-wrap justify-end gap-3">
                    {visibleBots.map((bot) => {
                      const checked = bot.grantedConnectionIds.includes(connection.id);
                      const key = `${connection.id}:${bot.id}`;
                      return (
                        <div
                          className="flex items-center gap-1.5 text-[10.5px] text-foreground-secondary"
                          key={bot.id}
                        >
                          <span className="max-w-24 truncate">{bot.name}</span>
                          <SquareToggle
                            busy={busy === key}
                            checked={checked}
                            label={`${checked ? "Revoke" : "Grant"} ${connection.name} ${connection.alias} account for ${bot.name}`}
                            onClick={() => onGrant(connection, bot, !checked)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {install.hasSkills ? (
                <div className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 dark:border-white/[0.065]">
                  <span className="min-w-[145px] flex-1 truncate text-[11.5px]">Instructions and hooks</span>
                  <div className="flex flex-wrap justify-end gap-3">
                    {visibleBots.map((bot) => {
                      const checked = bot.skillsEnabled;
                      const key = `skill:${plugin.key}:${bot.id}`;
                      return (
                        <div
                          className="flex items-center gap-1.5 text-[10.5px] text-foreground-secondary"
                          key={bot.id}
                        >
                          <span className="max-w-24 truncate">{bot.name}</span>
                          <SquareToggle
                            busy={busy === key}
                            checked={checked}
                            label={`${checked ? "Disable" : "Enable"} ${plugin.name} instructions and hooks for ${bot.name}`}
                            onClick={() => onSkill(plugin.key, bot, !checked)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {botAccess &&
              (botAccess.offset > 0 ||
                botAccess.offset + botAccess.bots.length < botAccess.total) ? (
                <div className="flex h-9 items-center justify-between border-t border-black/[0.055] px-3 text-[10.5px] text-foreground-secondary dark:border-white/[0.065]">
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-35"
                    disabled={botAccessLoading || botAccess.offset === 0}
                    onClick={() =>
                      setBotAccessOffset(
                        Math.max(0, botAccess.offset - PLUGIN_BOT_ACCESS_PAGE_SIZE)
                      )
                    }
                    type="button"
                  >
                    <ChevronLeft className="size-3" /> Previous
                  </button>
                  <span>
                    {botAccess.bots.length ? botAccess.offset + 1 : 0}–
                    {botAccess.offset + botAccess.bots.length} of {botAccess.total}
                  </span>
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-35"
                    disabled={
                      botAccessLoading ||
                      botAccess.offset + botAccess.bots.length >= botAccess.total
                    }
                    onClick={() =>
                      setBotAccessOffset(botAccess.offset + PLUGIN_BOT_ACCESS_PAGE_SIZE)
                    }
                    type="button"
                  >
                    Next <ChevronRight className="size-3" />
                  </button>
                </div>
              ) : null}
              {botAccessLoading && !botAccess ? (
                <div className="grid h-12 place-items-center border-t border-black/[0.055] dark:border-white/[0.065]">
                  <LoaderCircle className="size-3.5 animate-spin text-foreground-tertiary" />
                </div>
              ) : null}
              {botAccess && botAccess.total === 0 ? (
                <div className="border-t border-black/[0.055] px-3 py-3 text-[10.5px] text-foreground-tertiary dark:border-white/[0.065]">
                  No Bots match that filter.
                </div>
              ) : null}
              {botAccessError ? (
                <div className="border-t border-black/[0.055] px-3 py-3 text-[10.5px] text-red-600 dark:border-white/[0.065] dark:text-red-400">
                  {botAccessError}
                </div>
              ) : null}
            </>
          ) : null}
        </DetailBlock>
      ) : null}

      {connections.some((connection) => connection.tools.length) ? (
        <DetailBlock
          count={connections.reduce((total, connection) => total + connection.tools.length, 0)}
          label="Tool policies"
          open={false}
        >
          {connections.flatMap((connection) =>
            connection.tools.map((tool) => {
              const policy = data.policies.find(
                (candidate) =>
                  candidate.connectionId === connection.id &&
                  candidate.botId === null &&
                  candidate.toolName === tool.name
              );
              const key = `${connection.id}:${tool.name}`;
              return (
                <div
                  className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 first:border-t-0 dark:border-white/[0.065]"
                  key={key}
                >
                  <span className="min-w-0 flex-1 text-[11.5px]">
                    <span className="block truncate">{tool.name}</span>
                    {connections.length > 1 && (
                      <span className="block truncate text-[10.5px] text-foreground-tertiary">
                        {connection.name} · {connection.alias}
                      </span>
                    )}
                  </span>
                  <Suspense
                    fallback={
                      <span className="inline-flex h-7 items-center rounded-[7px] border border-black/[0.07] bg-background px-2 text-[10.5px] capitalize text-foreground-secondary dark:border-white/[0.09]">
                        {policy?.decision ?? tool.defaultDecision}
                      </span>
                    }
                  >
                    <PluginPolicySelect
                      disabled={busy === key}
                      label={`Policy for ${tool.name} on ${connection.name} ${connection.alias} account`}
                      onChange={(value) => onPolicy(connection.id, tool.name, value)}
                      value={policy?.decision ?? tool.defaultDecision}
                    />
                  </Suspense>
                </div>
              );
            })
          )}
        </DetailBlock>
      ) : null}

      {recentActivity.length ? (
        <DetailBlock count={recentActivity.length} label="Activity" open={false}>
          {recentActivity.map((entry) => (
            <div
              className="flex min-h-10 items-center gap-3 border-t border-black/[0.055] px-3 text-[10.5px] first:border-t-0 dark:border-white/[0.065]"
              key={entry.id}
            >
              <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
              <span className="text-foreground-tertiary">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </DetailBlock>
      ) : null}
    </div>
  );
}
