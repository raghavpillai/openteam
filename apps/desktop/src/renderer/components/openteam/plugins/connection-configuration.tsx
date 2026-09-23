import type { PluginConnectionView, PluginSettingsView } from "@openteam/contracts";
import type {
  PluginConfigurationInput,
  PluginConfigurationView,
} from "@openteam/contracts/plugin-management";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { inputClass, PluginButton, PluginField, usePluginOperation } from "./plugin-ui";
import { PluginAuthorization, openAutomaticPluginSignIn } from "./plugin-authorization";
import { pluginAuthorization, pluginProviderSetupSteps, pluginProviderSetupDescription } from "@openteam/product-core/plugin-authorization";

export function ConnectionConfiguration({
  connection,
  settings,
  refresh,
}: {
  connection: PluginConnectionView;
  settings: PluginSettingsView;
  refresh: () => Promise<unknown>;
}) {
  const [config, setConfig] = useState<PluginConfigurationView | null>(null);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [secrets, setSecrets] = useState<NonNullable<PluginConfigurationInput["secrets"]>>({});
  const [alias, setAlias] = useState(connection.alias);
  const [newAlias, setNewAlias] = useState("");
  const [instructions, setInstructions] = useState(connection.instructions);
  const [endpoint, setEndpoint] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [cwd, setCwd] = useState("");
  const [headers, setHeaders] = useState("");
  const [env, setEnv] = useState("");
  const [callbackMode, setCallbackMode] = useState<NonNullable<PluginConfigurationInput["oauthCallbackMode"]>>("auto");
  const [loopbackPort, setLoopbackPort] = useState(0);
  const [authMethod, setAuthMethod] =
    useState<PluginConfigurationInput["tokenEndpointAuthMethod"]>("none");
  const [testTool, setTestTool] = useState("");
  const [testArgs, setTestArgs] = useState("{}");
  const [testResult, setTestResult] = useState("");
  const [testArmed, setTestArmed] = useState(false);
  const automaticCallbackMode = config?.callbackUrl.startsWith("https://") ? "server" : "manual";
  const resolvedCallbackMode = callbackMode === "auto" ? automaticCallbackMode : callbackMode;
  const [removeArmed, setRemoveArmed] = useState(false);
  const load = useCallback(async () => {
    const next = await api.pluginConfiguration(connection.id);
    setConfig(next);
    setValues(next.values);
    setSecrets({});
    setHeaders("");
    setEnv("");
    setEndpoint(next.endpoint ?? "");
    setCommand(next.command ?? "");
    setArgs(JSON.stringify(next.args, null, 2));
    setCwd(next.cwd ?? "");
    setCallbackMode(next.oauthCallbackMode ?? "auto");
    setLoopbackPort(next.oauthLoopbackPort ?? 0);
    setAuthMethod(
      next.tokenEndpointAuthMethod as PluginConfigurationInput["tokenEndpointAuthMethod"]
    );
  }, [connection.id]);
  const operation = usePluginOperation(async () => {
    await refresh();
    await load();
  });
  useEffect(() => {
    void operation.run(load, undefined, { refreshAfter: false });
  }, [load]);
  const save = () =>
    api.savePluginConfiguration(connection.id, {
      values,
      secrets,
      ...(connection.transport === "http"
        ? { endpoint }
        : connection.transport === "stdio" && config?.runtime !== "desktop"
          ? { command, args: JSON.parse(args), cwd }
          : {}),
      ...(headers.trim() ? { headers: JSON.parse(headers) } : {}),
      ...(env.trim() ? { env: JSON.parse(env) } : {}),
      ...(connection.auth === "oauth" ? { tokenEndpointAuthMethod: authMethod, oauthCallbackMode: callbackMode, oauthLoopbackPort: loopbackPort } : {}),
    });
  const connect = async (reauth = false) => {
    await save();
    setHeaders("");
    setEnv("");
    if (connection.auth === "oauth") {
      const result = await api.authenticatePlugin(connection.id, reauth);
      openAutomaticPluginSignIn(resolvedCallbackMode, result.authorizationUrl);
    } else await api.connectPlugin(connection.id);
  };
  if (!config)
    return (
      <div>
        {operation.feedback}
        <p className="text-sm">Loading connection setup…</p>
      </div>
    );
  return (
    <div className="grid gap-5">
      {operation.feedback}
      <PluginAuthorization connection={connection} busy={operation.busy}
        onRetry={() => void operation.run(async () => {
          const result = await api.authenticatePlugin(connection.id);
          openAutomaticPluginSignIn(connection.oauthCallbackMode, result.authorizationUrl);
        })}
        onCancel={() => { const session = pluginAuthorization(connection); if (session) void operation.run(() => api.cancelPluginAuthentication(connection.id, session.state)); }} />
      <div>
        <h3 className="font-medium">
          {connection.name} · {connection.alias}
        </h3>
        <p className="text-sm text-foreground-secondary">
          {config.runtime === "desktop"
            ? "Runs on your local computer through OpenTeam desktop"
            : connection.transport === "stdio"
            ? "Runs on your Bot computer"
            : "Connects to the configured server"}{" "}
          · {connection.status.replaceAll("_", " ")}
        </p>
        {connection.statusMessage && <p className="mt-2 text-sm">{connection.statusMessage}</p>}
      </div>
      {config.setup && (
        <section className="rounded-xl bg-black/5 p-4 dark:bg-white/5">
          <h4 className="font-medium">{config.setup.title}</h4>
          <p className="mt-1 text-sm">{pluginProviderSetupDescription(connection.pluginKey, config.setup.description)}</p>
          <ol className="my-3 list-decimal space-y-1 pl-5 text-sm">
            {pluginProviderSetupSteps(connection.pluginKey, resolvedCallbackMode, config.setup.steps).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {config.setup.documentationUrl && (
            <a
              className="text-sm text-blue-600 underline"
              href={config.setup.documentationUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open provider setup guide
            </a>
          )}
          {config.setup.requiredScopes.length > 0 && (
            <p className="mt-3 break-words text-xs text-foreground-secondary">
              Requested scopes: {config.setup.requiredScopes.join(", ")}
            </p>
          )}
        </section>
      )}
      {connection.auth === "oauth" && (
        <PluginField label="Sign-in callback" help="Automatic uses your HTTPS server callback, or manual callback paste for HTTP. Google needs a Web application client for HTTPS and a Desktop app client for manual paste. Both work independently of the desktop app.">
          <select className={inputClass} aria-label="Sign-in callback" value={callbackMode} onChange={event => setCallbackMode(event.target.value as NonNullable<PluginConfigurationInput["oauthCallbackMode"]>)}>
            <option value="auto">Automatic (recommended)</option>
            <option value="manual" disabled={config.manualCallbackSupported === false}>Paste callback URL</option>
            <option value="desktop">Desktop listener (advanced)</option>
            <option value="server">Server callback</option>
          </select>
          {callbackMode === "desktop" && <PluginField label="Desktop callback port" help="Use 0 to select an available port. If your provider requires a fixed URL, register http://127.0.0.1:PORT/callback and enter that port here.">
            <input className={inputClass} aria-label="Desktop callback port" type="number" min={0} max={65535} value={loopbackPort} onChange={event => setLoopbackPort(Number(event.target.value))} />
          </PluginField>}
        </PluginField>
      )}
      {connection.auth === "oauth" && resolvedCallbackMode === "manual" && config.manualCallbackSupported === false && (
        <p role="status" className="text-sm">This provider requires HTTPS. Configure Tailscale Serve or your own HTTPS domain before authorizing.</p>
      )}
      {connection.auth === "oauth" && callbackMode !== "desktop" && (
        <PluginField
          label="OAuth callback URL"
          help={resolvedCallbackMode === "manual" ? "Use an OAuth client that permits loopback redirects. For Google, create a Desktop app client. After authorization, paste the full returned URL into OpenTeam." : "Register this exact URL with the provider’s Web application client."}
        >
          <div className="flex gap-2">
            <input
              readOnly
              aria-label="OAuth callback URL"
              className={inputClass}
              value={resolvedCallbackMode === "manual" ? config.manualCallbackUrl : config.callbackUrl}
            />
            <PluginButton onClick={() => void navigator.clipboard.writeText((resolvedCallbackMode === "manual" ? config.manualCallbackUrl : config.callbackUrl) ?? "")}>
              Copy
            </PluginButton>
          </div>
        </PluginField>
      )}
      {config.fields.map((field) => (
        <PluginField
          key={field.key}
          label={`${field.label}${field.required ? " *" : ""}`}
          help={field.helpText}
        >
          {field.secret ? (
            <div className="flex gap-2">
              <select
                className={inputClass}
                aria-label={`${field.label} action`}
                value={secrets[field.key]?.action ?? "keep"}
                onChange={(event) =>
                  setSecrets({
                    ...secrets,
                    [field.key]:
                      event.target.value === "replace"
                        ? { action: "replace", value: "" }
                        : { action: event.target.value as "keep" | "clear" },
                  })
                }
              >
                <option value="keep">
                  {config.configuredSecrets.includes(field.key)
                    ? "Keep saved value"
                    : "Not configured"}
                </option>
                <option value="replace">Replace</option>
                <option value="clear">Clear</option>
              </select>
              {secrets[field.key]?.action === "replace" && (
                <input
                  aria-label={field.label}
                  autoComplete="off"
                  type="password"
                  className={inputClass}
                  value={(secrets[field.key] as { value: string }).value}
                  onChange={(event) =>
                    setSecrets({
                      ...secrets,
                      [field.key]: { action: "replace", value: event.target.value },
                    })
                  }
                />
              )}
            </div>
          ) : field.enum ? (
            <select
              className={inputClass}
              aria-label={field.label}
              value={String(values[field.key] ?? field.default ?? "")}
              onChange={(event) =>
                setValues({
                  ...values,
                  [field.key]: field.enum!.find((value) => String(value) === event.target.value)!,
                })
              }
            >
              <option value="">Choose…</option>
              {field.enum.map((value) => (
                <option key={String(value)} value={String(value)}>
                  {String(value)}
                </option>
              ))}
            </select>
          ) : field.type === "boolean" ? (
            <input
              aria-label={field.label}
              type="checkbox"
              checked={Boolean(values[field.key] ?? field.default ?? false)}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.checked })}
            />
          ) : (
            <input
              aria-label={field.label}
              className={inputClass}
              autoComplete="off"
              type={field.type === "number" || field.type === "integer" ? "number" : "text"}
              step={field.type === "integer" ? 1 : "any"}
              placeholder={field.placeholder}
              value={String(values[field.key] ?? field.default ?? "")}
              onChange={(event) =>
                setValues({
                  ...values,
                  [field.key]:
                    field.type === "number" || field.type === "integer"
                      ? Number(event.target.value)
                      : event.target.value,
                })
              }
            />
          )}
        </PluginField>
      ))}
      {config.runtime !== "desktop" && <details className="rounded-xl border border-black/10 p-3 dark:border-white/10">
        <summary className="cursor-pointer text-sm font-medium">Server settings</summary>
        <div className="mt-4 grid gap-4">
          {connection.transport === "http" && (
            <PluginField label="MCP server URL">
              <input
                aria-label="MCP server URL"
                className={inputClass}
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </PluginField>
          )}
          {connection.transport === "stdio" && (
            <>
              <PluginField label="Command">
                <input
                  className={inputClass}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </PluginField>
              <PluginField
                label="Arguments"
                help="JSON array; each item is one argument, so spaces and quotes are preserved."
              >
                <textarea
                  className={inputClass}
                  rows={3}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </PluginField>
              <PluginField label="Working directory on Bot computer">
                <input
                  className={inputClass}
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                />
              </PluginField>
              <PluginField
                label="Replace environment values"
                help={`Saved keys: ${config.environmentNames.join(", ") || "none"}. Leave blank to keep; use {} to clear.`}
              >
                <textarea
                  aria-label="Environment values"
                  className={inputClass}
                  rows={3}
                  placeholder='{"API_KEY":"…"}'
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                />
              </PluginField>
            </>
          )}
          {connection.transport === "http" && (
            <PluginField
              label="Replace request headers"
              help={`Saved keys: ${config.headerNames.join(", ") || "none"}. Leave blank to keep; use {} to clear.`}
            >
              <textarea
                aria-label="Request headers"
                className={inputClass}
                rows={3}
                placeholder='{"Authorization":"Bearer …"}'
                value={headers}
                onChange={(event) => setHeaders(event.target.value)}
              />
            </PluginField>
          )}
          {connection.auth === "oauth" && (
            <PluginField label="OAuth client authentication">
              <select
                className={inputClass}
                value={authMethod}
                onChange={(event) => setAuthMethod(event.target.value as typeof authMethod)}
              >
                <option value="none">Public client (PKCE)</option>
                <option value="client_secret_post">Client secret in request</option>
                <option value="client_secret_basic">Client secret via HTTP Basic</option>
              </select>
            </PluginField>
          )}
          <p className="break-all text-xs text-foreground-secondary">
            Stable tool namespace: {config.namespace}
          </p>
        </div>
      </details>}
      <div className="flex flex-wrap gap-2">
        <PluginButton
          disabled={operation.busy}
          onClick={() =>
            void operation.run(save, "Configuration saved. You can finish connecting later.")
          }
        >
          Save configuration
        </PluginButton>
        <PluginButton
          primary
          disabled={operation.busy}
          onClick={() =>
            void operation.run(
              () => connect(),
              connection.auth === "oauth"
                ? "Finish authorization in your browser."
                : "Connected and tools refreshed."
            )
          }
        >
          {connection.auth === "oauth" ? "Save and authorize" : "Save and connect"}
        </PluginButton>
        {connection.status === "ready" && (
          <PluginButton
            disabled={operation.busy}
            onClick={() =>
              void operation.run(() => api.disconnectPlugin(connection.id), "Disconnected.")
            }
          >
            Disconnect
          </PluginButton>
        )}
        <PluginButton
          disabled={operation.busy}
          onClick={() =>
            void operation.run(
              () => api.restartPluginConnection(connection.id),
              "Connection restarted and tools refreshed."
            )
          }
        >
          Restart / refresh tools
        </PluginButton>
      </div>
      <section className="grid gap-3 border-t border-black/10 pt-4 dark:border-white/10">
        <h4 className="font-medium">Account</h4>
        <div className="flex gap-2">
          <input
            aria-label="Account name"
            className={inputClass}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
          <PluginButton
            disabled={operation.busy}
            onClick={() =>
              void operation.run(
                () => api.renamePluginAccount(connection.id, alias),
                "Account renamed."
              )
            }
          >
            Rename
          </PluginButton>
        </div>
        <div className="flex gap-2">
          <input
            aria-label="New account name"
            className={inputClass}
            placeholder="Name another account"
            value={newAlias}
            onChange={(event) => setNewAlias(event.target.value)}
          />
          <PluginButton
            disabled={operation.busy || !newAlias.trim()}
            onClick={() =>
              void operation.run(
                () => api.addPluginAccount(connection.id, newAlias),
                "Account added. Select it to configure and authorize separately."
              )
            }
          >
            Add account
          </PluginButton>
        </div>
        <div className="flex gap-2">
          {connection.auth === "oauth" && (
            <PluginButton
              disabled={operation.busy}
              onClick={() => void operation.run(() => connect(true))}
            >
              Reauthorize
            </PluginButton>
          )}
          <PluginButton
            disabled={operation.busy}
            onClick={() =>
              removeArmed
                ? void operation.run(() => api.removePluginAccount(connection.id))
                : setRemoveArmed(true)
            }
          >
            {removeArmed ? "Confirm remove account credentials and grants" : "Remove account"}
          </PluginButton>
        </div>
      </section>
      <PluginField label="Instructions for Bots using this connection">
        <textarea
          className={inputClass}
          rows={3}
          maxLength={500}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <PluginButton
          disabled={operation.busy}
          onClick={() =>
            void operation.run(
              () => api.setMcpInstructions(connection.id, instructions),
              "Instructions saved."
            )
          }
        >
          Save instructions
        </PluginButton>
      </PluginField>
      <section className="grid gap-2">
        <h4 className="font-medium">Tools ({connection.tools.length})</h4>
        <p className="text-xs text-foreground-secondary">
          Disabled tools are hidden from Bots. Approval controls apply independently.
        </p>
        {connection.tools.map((tool) => {
          const policy = settings.policies.find(
            (candidate) =>
              candidate.connectionId === connection.id && candidate.toolName === tool.name
          );
          return (
            <div
              className="flex items-center gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
              key={tool.name}
            >
              <input
                type="checkbox"
                aria-label={`Enable ${tool.name}`}
                disabled={operation.busy}
                checked={policy?.enabled !== false}
                onChange={(event) =>
                  void operation.run(() =>
                    api.setPluginPolicy(connection.id, {
                      botId: null,
                      toolName: tool.name,
                      decision: policy?.decision ?? tool.defaultDecision,
                      enabled: event.target.checked,
                    })
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm">{tool.name}</p>
                <p className="line-clamp-2 text-xs text-foreground-secondary">{tool.description}</p>
              </div>
              <select
                aria-label={`Approval for ${tool.name}`}
                className="rounded-lg bg-transparent p-2 text-sm"
                disabled={operation.busy}
                value={policy?.decision ?? tool.defaultDecision}
                onChange={(event) =>
                  void operation.run(() =>
                    api.setPluginPolicy(connection.id, {
                      botId: null,
                      toolName: tool.name,
                      decision: event.target.value as "allow" | "prompt" | "deny",
                    })
                  )
                }
              >
                <option value="allow">Allow</option>
                <option value="prompt">Ask first</option>
                <option value="deny">Deny</option>
              </select>
            </div>
          );
        })}
      </section>
      {connection.tools.length > 0 && (
        <section className="grid gap-3 rounded-xl border border-black/10 p-4 dark:border-white/10">
          <h4 className="font-medium">Test a tool</h4>
          <select
            className={inputClass}
            aria-label="Tool to test"
            value={testTool}
            onChange={(event) => {
              setTestTool(event.target.value);
              setTestArmed(false);
              setTestResult("");
            }}
          >
            <option value="">Choose a tool…</option>
            {connection.tools.map((tool) => (
              <option key={tool.name} value={tool.name}>
                {tool.name}
              </option>
            ))}
          </select>
          <PluginField label="Test arguments (JSON)">
            <textarea
              className={inputClass}
              rows={4}
              value={testArgs}
              onChange={(event) => {
                setTestArgs(event.target.value);
                setTestArmed(false);
              }}
            />
          </PluginField>
          {testArmed && (
            <p className="text-sm">
              This tool may change provider data. Review the arguments above before confirming.
            </p>
          )}
          <PluginButton
            disabled={operation.busy || !testTool || connection.status !== "ready"}
            onClick={() => {
              const sideEffect =
                connection.tools.find((tool) => tool.name === testTool)?.risk !== "read";
              if (sideEffect && !testArmed) {
                setTestArmed(true);
                return;
              }
              void operation.run(async () => {
                const response = await api.testPluginConnection(connection.id, {
                  toolName: testTool,
                  arguments: JSON.parse(testArgs),
                  confirmSideEffect: sideEffect,
                });
                setTestResult(JSON.stringify(response.result, null, 2));
                setTestArmed(false);
              });
            }}
          >
            {testArmed ? "Confirm and run test" : "Run test"}
          </PluginButton>
          {testResult && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
              {testResult}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
