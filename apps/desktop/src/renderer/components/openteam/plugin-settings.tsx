import type {
  PluginBotAccessItemView,
  PluginBotAccessView,
  PluginCatalogItemView,
  PluginConnectionView,
  PluginInstallView,
  PluginSettingsView,
} from "@openteam/contracts";
import {
  executePluginAccessTransition,
  planPluginConnectionGrant,
  planPluginSkillAccess,
} from "@openteam/product-core/plugin-access";
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
  Plug,
  Search,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import { api } from "../../client/openteam-api";
import { cn } from "../../lib/cn";
import {
  createCoalescedRefresh,
  mergePluginConnectionStatuses,
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
  pluginBotAccessWindow,
} from "../../lib/plugin-settings-scale";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

const loadPluginSettingsDetail = () => import("./plugin-settings-detail");
const PluginPolicySelect = lazy(() =>
  loadPluginSettingsDetail().then((module) => ({ default: module.PluginPolicySelect }))
);
const PluginAuthSelect = lazy(() =>
  loadPluginSettingsDetail().then((module) => ({ default: module.PluginAuthSelect }))
);

const PluginWorkspace = lazy(() => import("./plugins/plugin-workspace"));
import { PluginMark } from "./plugins/plugin-mark";
import { PluginCopyButton } from "./plugins/plugin-copy-button";
import { PluginAccountRow, AddPluginAccount } from "./plugins/plugin-accounts";
import { MarketplaceView, InstalledPluginsView } from "./plugins/marketplace-browse";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";

type MarketplacePage = "marketplace" | "installed" | "detail" | "custom" | "manage";

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

function CustomMcpView({
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
}: {
  busy: boolean;
  connection: PluginConnectionView;
  plugin: PluginCatalogItemView;
  onAuthenticate: () => void;
  onConfigureOAuth: (input: { clientId: string; clientSecret: string; scope: string }) => void;
  onConfigureToken: (token: string) => void;
}) {
  const setup = plugin.setup;
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  if (!setup) return null;

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
      onConfigureToken(values.token?.trim() ?? "");
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
                  Authorized redirect URI
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
  const field =
    "h-8 rounded-[7px] border border-black/[0.08] bg-background px-2 text-[10.5px] outline-none dark:border-white/10 dark:bg-[#1d1d1d]";
  useEffect(() => setAlias(connection.alias), [connection.alias]);
  useEffect(() => setInstructions(connection.instructions), [connection.instructions]);
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
      {connection.auth === "oauth" && connection.status !== "ready" ? (
        <div className="mt-3 rounded-[9px] bg-black/[0.035] p-3 dark:bg-black/20">
          <div className="mb-2 text-[10.5px] leading-4 text-foreground-secondary">
            Self-hosted OAuth clients must allow this callback URL:
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

function PluginDetail({
  accessEpoch,
  busy,
  data,
  plugin,
  onAddAccount,
  onGrant,
  onAuthenticate,
  onConfigureToken,
  onConfigureOAuth,
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
  onAddAccount: (connection: PluginConnectionView, alias: string) => void;
  onGrant: (
    connection: PluginConnectionView,
    bot: PluginBotAccessItemView,
    enabled: boolean
  ) => void;
  onAuthenticate: (connection: PluginConnectionView) => void;
  onConfigureToken: (connection: PluginConnectionView, token: string) => void;
  onConfigureOAuth: (
    connection: PluginConnectionView,
    input: { clientId: string; clientSecret: string; scope: string }
  ) => void;
  onInstructions: (connection: PluginConnectionView, instructions: string) => void;
  onInstall: (plugin: PluginCatalogItemView, values?: Record<string, string>) => void;
  onPolicy: (connectionId: string, toolName: string, decision: "deny" | "prompt" | "allow") => void;
  onRemoveAccount: (connection: PluginConnectionView) => void;
  onRename: (connection: PluginConnectionView, alias: string) => void;
  onRemove: (plugin: PluginCatalogItemView) => void;
  onRestart: (connection: PluginConnectionView) => void;
  onSkill: (pluginKey: string, bot: PluginBotAccessItemView, enabled: boolean) => void;
  onToggle: (connection: PluginConnectionView) => void;
}) {
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const [setupAccountId, setSetupAccountId] = useState<string | null>(null);
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
    connections.find((c) => c.status !== "ready" && (!c.configured || plugin.setup?.kind === "none"));
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
            <PluginCopyButton pluginKey={plugin.key} compact />
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
        <PluginCopyButton pluginKey={plugin.key} />
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
            onClick={() => onRemove(plugin)}
            type="button"
          >
            Uninstall
          </button>
        )}
      </div>
      <p className="mt-4 max-w-[720px] text-[12px] leading-[18px] text-foreground-secondary">
        {plugin.description}
      </p>

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

export function PluginDialog({
  onOpenChange,
  open,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: { pluginId: string; nonce: number } | null;
}) {
  const [page, setPage] = useState<MarketplacePage>("marketplace");
  const [managementSection, setManagementSection] = useState<
    "installed" | "private" | "sources" | "develop"
  >("installed");
  const openManagement = (section: typeof managementSection = "installed") => {
    setManagementSection(section);
    setPage("manage");
  };
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [data, setData] = useState<PluginSettingsView | null>(null);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useMemo(
    () =>
      createCoalescedRefresh(api.pluginSettings, (settings) => {
        setData(settings);
        setSettingsEpoch((epoch) => epoch + 1);
      }),
    []
  );
  const needsAuthConnectionIds = useMemo(
    () =>
      (data?.installs ?? [])
        .flatMap((install) => install.connections)
        .filter((connection) => connection.status === "needs_auth")
        .map((connection) => connection.id)
        .sort(),
    [data]
  );
  const statusRefresh = useMemo(
    () =>
      createCoalescedRefresh(
        () => api.pluginConnectionStatuses(needsAuthConnectionIds),
        (statuses) => {
          setData((current) =>
            current ? mergePluginConnectionStatuses(current, statuses) : current
          );
        }
      ),
    [needsAuthConnectionIds]
  );
  useEffect(() => {
    if (!open) return;
    refresh().catch((cause) => setError(errorMessage(cause)));
  }, [open, refresh]);
  const needsPluginAuthentication = needsAuthConnectionIds.length > 0;
  useEffect(() => {
    if (!open || !needsPluginAuthentication) return;
    const timer = window.setInterval(() => {
      statusRefresh().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [needsPluginAuthentication, open, statusRefresh]);
  useEffect(() => {
    if (open) return;
    setPage("marketplace");
    setSelectedKey(null);
    setError(null);
  }, [open]);

  const mutate = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await refresh();
        window.dispatchEvent(new Event("openteam:plugins-changed"));
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const selected = useMemo(() => {
    const pinned = data?.installs.find((plugin) => plugin.pluginKey === selectedKey)?.catalog;
    if (pinned) return pinned;
    const catalogPlugin = data?.catalog.find((plugin) => plugin.key === selectedKey);
    if (catalogPlugin) return catalogPlugin;
    const install = data?.installs.find((plugin) => plugin.pluginKey === selectedKey);
    return install ? catalogPluginForInstall(install) : null;
  }, [data, selectedKey]);
  useEffect(() => {
    // A custom package can disappear from the catalog when it is uninstalled.
    if (data && page === "detail" && selectedKey && !selected) {
      setPage("marketplace");
      setSelectedKey(null);
    }
  }, [data, page, selected, selectedKey]);
  const openDetail = (plugin: PluginCatalogItemView) => {
    void loadPluginSettingsDetail();
    setSelectedKey(plugin.key);
    setPage("detail");
    setError(null);
  };
  useEffect(() => {
    if (!open || !target || !data) return;
    const plugin =
      data.installs.find((candidate) => candidate.pluginKey === target.pluginId)?.catalog ??
      data.catalog.find((candidate) => candidate.key === target.pluginId);
    if (plugin) {
      setSelectedKey(plugin.key);
      setPage("detail");
      setError(null);
      return;
    }
    setPage("marketplace");
    setSelectedKey(null);
    setError(`Plugin “${target.pluginId}” is not available in this catalog.`);
  }, [data, open, target]);
  const authenticateConnection = (connection: PluginConnectionView) => {
    void mutate(connection.id, async () => {
      if (connection.auth !== "oauth") return api.connectPlugin(connection.id);
      const result = await api.authenticatePlugin(connection.id);
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      return result;
    });
  };
  const toggleConnection = (connection: PluginConnectionView) => {
    if (connection.status !== "ready" && connection.auth === "oauth") {
      authenticateConnection(connection);
      return;
    }
    void mutate(connection.id, () =>
      connection.status === "ready"
        ? api.disconnectPlugin(connection.id)
        : api.connectPlugin(connection.id)
    );
  };

  const title =
    page === "detail" && selected
      ? selected.name
      : page === "custom"
        ? "Add custom MCP"
        : page === "manage"
          ? "Manage plugins"
          : "Marketplace";
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex h-[min(700px,calc(100vh-80px))] w-[min(800px,calc(100vw-40px))] flex-col max-w-none gap-0 overflow-hidden rounded-[13px] border-black/10 bg-background p-0 text-foreground shadow-[0_24px_72px_rgba(0,0,0,0.24)] dark:border-[#303030]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
        surface="modal"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Browse, install, connect, and configure OpenTeam plugins.
        </DialogDescription>
        <header className="relative flex h-[66px] shrink-0 items-center px-8">
          {page === "detail" || page === "custom" || page === "manage" ? (
            <button
              aria-label="Back to Marketplace"
              className="absolute left-3.5 grid size-8 place-items-center cursor-pointer rounded-full text-foreground-secondary outline-none transition-colors duration-120 ease-out hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              onClick={() => setPage(page === "custom" ? "installed" : "marketplace")}
              type="button"
            >
              <ChevronLeft className="size-4" />
            </button>
          ) : null}
          {page === "detail" || page === "custom" || page === "manage" ? (
            <div className="w-full text-center text-[12px] font-medium">{title}</div>
          ) : (
            <div className="flex w-full items-center justify-between pr-8">
              <div className="text-[16px] font-semibold">Marketplace</div>
              <div className="flex items-center gap-2">
                <span className={primaryButton}>
                  <Plug className="size-3.5" />
                  Plugins
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={secondaryButton} aria-label="Manage plugins">
                      Manage
                      <ChevronDown className="size-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setPage("installed")}>
                      Your plugins
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openManagement("installed")}>
                      Accounts and settings
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openManagement("private")}>
                      Private skills
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openManagement("sources")}>
                      Plugin sources
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openManagement("develop")}>
                      Develop plugins
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPage("custom")}>
                      Add custom MCP
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}
          <button
            aria-label="Close plugins"
            className="absolute right-3.5 grid size-8 place-items-center cursor-pointer rounded-full text-foreground-tertiary outline-none transition-colors duration-120 ease-out hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X className="size-4" strokeWidth={1.7} />
          </button>
        </header>

        {error ? (
          <div className="mx-8 mb-3 rounded-[8px] bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}
        {data && (
          <MarketplaceView
            hidden={page !== "marketplace"}
            busy={busy}
            data={data}
            onInstall={(plugin) => {
              if (plugin.setup || plugin.setupFields.length) {
                openDetail(plugin);
                void mutate(plugin.key, () => api.installPlugin(plugin.key));
              } else {
                void mutate(plugin.key, () => api.installPlugin(plugin.key));
              }
            }}
            onOpen={openDetail}
            onShowInstalled={() => setPage("installed")}
          />
        )}
        {!data ? (
          <div className="grid flex-1 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-foreground-tertiary" />
          </div>
        ) : page === "installed" ? (
          <InstalledPluginsView
            data={data}
            busy={busy}
            onOpen={openDetail}
            onBack={() => setPage("marketplace")}
            onManage={openManagement}
            onRetry={(connection) =>
              connection.auth === "oauth" && connection.status === "needs_auth"
                ? authenticateConnection(connection)
                : void mutate(connection.id, () => api.restartPluginConnection(connection.id))
            }
            catalogFallback={catalogPluginForInstall}
          />
        ) : page === "manage" ? (
          <Suspense fallback={<p className="p-8 text-sm">Loading plugin management…</p>}>
            <PluginWorkspace
              key={managementSection}
              initialSection={managementSection}
              settings={data}
              refresh={refresh}
              onOpen={openDetail}
              initialPluginKey={selectedKey}
            />
          </Suspense>
        ) : page === "marketplace" ? null : page === "custom" ? (
          <CustomMcpView
            busy={busy === "custom-mcp"}
            onBack={() => setPage("installed")}
            onSubmit={(input) =>
              void mutate("custom-mcp", () => api.addCustomMcp(input)).then((created) => {
                if (created) setPage("installed");
              })
            }
          />
        ) : selected ? (
          <PluginDetail
            accessEpoch={settingsEpoch}
            busy={busy}
            data={data}
            key={selected.key}
            onAddAccount={(connection, alias) => {
              void mutate(`account:${connection.id}`, () =>
                api.addPluginAccount(connection.id, alias)
              );
            }}
            onGrant={(connection, bot, enabled) => {
              const transition = planPluginConnectionGrant(
                selected.key,
                bot,
                connection.id,
                enabled
              );
              void mutate(`${connection.id}:${bot.id}`, () =>
                executePluginAccessTransition(transition, {
                  setEnablement: api.setPluginEnablement,
                  setGrant: api.setPluginGrant,
                })
              );
            }}
            onAuthenticate={authenticateConnection}
            onConfigureToken={(connection, token) =>
              void mutate(connection.id, async () => {
                await api.configurePluginConnection(connection.id, { token });
                return api.connectPlugin(connection.id);
              })
            }
            onConfigureOAuth={(connection, input) =>
              void mutate(connection.id, async () => {
                await api.configurePluginConnection(connection.id, input);
                const result = await api.authenticatePlugin(connection.id);
                window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
                return result;
              })
            }
            onInstructions={(connection, instructions) =>
              void mutate(connection.id, () => api.setMcpInstructions(connection.id, instructions))
            }
            onInstall={(plugin, values) =>
              void mutate(plugin.key, () => api.installPlugin(plugin.key, values))
            }
            onPolicy={(connectionId, toolName, decision) =>
              void mutate(`${connectionId}:${toolName}`, () =>
                api.setPluginPolicy(connectionId, { botId: null, toolName, decision })
              )
            }
            onRemoveAccount={(connection) =>
              void mutate(connection.id, () => api.removePluginAccount(connection.id))
            }
            onRename={(connection, alias) =>
              void mutate(connection.id, () => api.renamePluginAccount(connection.id, alias))
            }
            onRemove={(plugin) => void mutate(plugin.key, () => api.uninstallPlugin(plugin.key))}
            onSkill={(pluginKey, bot, enabled) => {
              const transition = planPluginSkillAccess(pluginKey, bot, enabled);
              void mutate(`skill:${pluginKey}:${bot.id}`, () =>
                executePluginAccessTransition(transition, {
                  setEnablement: api.setPluginEnablement,
                  setGrant: api.setPluginGrant,
                })
              );
            }}
            onRestart={(connection) =>
              void mutate(connection.id, () => api.restartPluginConnection(connection.id))
            }
            onToggle={toggleConnection}
            plugin={selected}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
