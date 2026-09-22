import { Linking, Pressable, Switch, Text, View } from "react-native";

import { Button, Field, Choices } from "./plugin-controls";
import type { PluginWorkspaceModel } from "./use-plugin-workspace";
import { pluginProviderSetupSteps, pluginProviderSetupDescription } from "@openteam/product-core/plugin-authorization";
import { PluginAuthorization } from "./plugin-authorization";
export function ConnectionSettings({ model }: { model: PluginWorkspaceModel }) {
  const {
    allConnections,
    setConnectionId,
    connectionId,
    theme,
    alias,
    connection,
    config,
    paragraph,
    values,
    secrets,
    setSecrets,
    setValues,
    endpoint,
    setEndpoint,
    headers,
    setHeaders,
    command,
    setCommand,
    args,
    setArgs,
    cwd,
    setCwd,
    env,
    setEnv,
    method,
    setMethod,
    callbackMode,
    setCallbackMode,
    busy,
    run,
    saveConfig,
    authorize,
    api,
    setAlias,
    newAlias,
    setNewAlias,
    confirm,
    instructions,
    setInstructions,
    testToolName,
    setTestToolName,
    setTestResult,
    testArguments,
    setTestArguments,
    testTool,
    testResult,
    settings,
  } = model;
  return (
    <>
      {allConnections.map((entry) => (
        <Pressable
          key={entry.id}
          onPress={() => setConnectionId(entry.id)}
          style={{
            borderWidth: 1,
            borderColor: entry.id === connectionId ? theme.accent : theme.separator,
            borderRadius: 10,
            padding: 12,
          }}
        >
          <Text style={{ color: theme.text }}>
            {entry.name} · {entry.alias}
          </Text>
          <Text style={{ color: theme.textMuted }}>{entry.status.replaceAll("_", " ")}</Text>
        </Pressable>
      ))}
      {connection && config && (
        <>
          <PluginAuthorization connection={connection} refresh={model.refresh} />
          {paragraph(
            connection.statusMessage ??
              (connection.transport === "stdio"
                ? "Runs on your Bot computer."
                : "Connects to the configured MCP server.")
          )}
          {config.setup && (
            <View style={{ gap: 8 }}>
              {paragraph(pluginProviderSetupDescription(connection.pluginKey, config.setup.description))}
              {pluginProviderSetupSteps(connection.pluginKey, callbackMode === "auto" ? (config.callbackUrl.startsWith("https://") ? "server" : "manual") : callbackMode, config.setup.steps).map((step, index) => (
                <Text key={step} style={{ color: theme.text }}>
                  {index + 1}. {step}
                </Text>
              ))}
              {config.setup.documentationUrl && (
                <Button onPress={() => void Linking.openURL(config.setup!.documentationUrl!)}>
                  Open provider setup guide
                </Button>
              )}
            </View>
          )}
          {connection.auth === "oauth" && (
            <View style={{ gap: 6 }}>
              <Choices label="Sign-in callback" values={["auto", "server", "manual", "desktop"]} current={callbackMode} onChange={value => setCallbackMode(value as typeof callbackMode)} />
              {paragraph("Automatic returns to your HTTPS server, or uses callback paste for HTTP. For Google, use a Web application client for HTTPS and a Desktop app client for paste.")}
              {config.manualCallbackSupported === false && paragraph("This provider requires HTTPS; callback paste is not available.")}
              <Text style={{ color: theme.text, fontWeight: "600" }}>OAuth callback URL</Text>
              <Text selectable style={{ color: theme.textMuted }}>
                {(callbackMode === "manual" || (callbackMode === "auto" && !config.callbackUrl.startsWith("https://"))) ? config.manualCallbackUrl : config.callbackUrl}
              </Text>
            </View>
          )}
          {config.fields.map((field) => (
            <View key={field.key} style={{ gap: 7 }}>
              {field.secret ? (
                <>
                  <Choices
                    label={field.label}
                    values={["keep", "replace", "clear"]}
                    current={secrets[field.key]?.action ?? "keep"}
                    onChange={(action) =>
                      setSecrets({
                        ...secrets,
                        [field.key]:
                          action === "replace"
                            ? { action: "replace", value: "" }
                            : { action: action as "keep" | "clear" },
                      })
                    }
                  />
                  {paragraph(
                    config.configuredSecrets.includes(field.key)
                      ? "Saved securely on your server."
                      : "No saved value."
                  )}
                  {secrets[field.key]?.action === "replace" && (
                    <Field
                      label={`New ${field.label}`}
                      secret
                      value={(secrets[field.key] as { value: string }).value}
                      onChange={(value) =>
                        setSecrets({ ...secrets, [field.key]: { action: "replace", value } })
                      }
                    />
                  )}
                </>
              ) : field.type === "boolean" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: theme.text }}>{field.label}</Text>
                  <Switch
                    accessibilityLabel={field.label}
                    value={Boolean(values[field.key] ?? field.default)}
                    onValueChange={(value) => setValues({ ...values, [field.key]: value })}
                  />
                </View>
              ) : field.enum ? (
                <Choices
                  label={field.label}
                  values={field.enum.map(String)}
                  current={String(values[field.key] ?? field.default ?? "")}
                  onChange={(value) =>
                    setValues({
                      ...values,
                      [field.key]: field.enum!.find((candidate) => String(candidate) === value)!,
                    })
                  }
                />
              ) : (
                <Field
                  label={field.label}
                  value={String(values[field.key] ?? field.default ?? "")}
                  onChange={(value) =>
                    setValues({
                      ...values,
                      [field.key]:
                        field.type === "number" || field.type === "integer" ? Number(value) : value,
                    })
                  }
                />
              )}{" "}
              {field.helpText && paragraph(field.helpText)}
            </View>
          ))}
          {connection.transport === "http" ? (
            <>
              <Field label="MCP server URL" value={endpoint} onChange={setEndpoint} />
              <Field
                label="Replace request headers (JSON; blank keeps saved values)"
                value={headers}
                onChange={setHeaders}
                multiline
              />
              {paragraph(`Saved header keys: ${config.headerNames.join(", ") || "none"}`)}
            </>
          ) : connection.transport === "stdio" ? (
            <>
              <Field label="Command" value={command} onChange={setCommand} />
              <Field label="Arguments (JSON array)" value={args} onChange={setArgs} multiline />
              <Field label="Working directory on Bot computer" value={cwd} onChange={setCwd} />
              <Field
                label="Replace environment (JSON; blank keeps saved values)"
                value={env}
                onChange={setEnv}
                multiline
              />
              {paragraph(`Saved environment keys: ${config.environmentNames.join(", ") || "none"}`)}
            </>
          ) : null}
          {connection.auth === "oauth" && (
            <Choices
              label="OAuth client authentication"
              current={method}
              values={["none", "client_secret_post", "client_secret_basic"]}
              onChange={setMethod}
            />
          )}
          <Button
            disabled={busy}
            onPress={() =>
              void run(saveConfig, "Configuration saved. Finish connecting whenever you're ready.")
            }
          >
            Save configuration
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              void run(
                () => authorize(),
                connection.auth === "oauth"
                  ? "Finish authorization in your browser."
                  : "Connected.",
                connection.auth === "oauth" ? "error" : "outcome"
              )
            }
          >
            {connection.auth === "oauth" ? "Save and authorize" : "Save and connect"}
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              void run(() => api((client) => client.restartPluginConnection(connectionId)))
            }
          >
            Restart / refresh tools
          </Button>
          {connection.status === "ready" && (
            <Button
              disabled={busy}
              onPress={() => void run(() => api((client) => client.disconnectPlugin(connectionId)))}
            >
              Disconnect
            </Button>
          )}
          <Field label="Account name" value={alias} onChange={setAlias} />
          <Button
            disabled={busy}
            onPress={() =>
              void run(() => api((client) => client.renamePluginAccount(connectionId, alias)))
            }
          >
            Rename account
          </Button>
          <Field label="New account name" value={newAlias} onChange={setNewAlias} />
          <Button
            disabled={busy || !newAlias}
            onPress={() =>
              void run(
                () => api((client) => client.addPluginAccount(connectionId, newAlias)),
                "Account added. Select it to configure it separately."
              )
            }
          >
            Add account
          </Button>
          {connection.auth === "oauth" && (
            <Button disabled={busy} onPress={() => void run(() => authorize(true))}>
              Reauthorize
            </Button>
          )}
          <Button
            disabled={busy}
            onPress={() =>
              confirm(
                "Remove account",
                "Remove this account's credentials and access grants?",
                () => api((client) => client.removePluginAccount(connectionId))
              )
            }
          >
            Remove account
          </Button>
          <Field
            label="Instructions for Bots"
            value={instructions}
            onChange={setInstructions}
            multiline
          />
          <Button
            disabled={busy}
            onPress={() =>
              void run(() => api((client) => client.setMcpInstructions(connectionId, instructions)))
            }
          >
            Save instructions
          </Button>
          {connection.status === "ready" && connection.tools.length > 0 && (
            <View style={{ gap: 10 }}>
              <Choices
                label="Test tool"
                values={connection.tools.map((tool) => tool.name)}
                current={testToolName}
                onChange={(value) => {
                  setTestToolName(value);
                  setTestResult("");
                }}
              />
              <Field
                label="Test arguments (JSON)"
                value={testArguments}
                onChange={setTestArguments}
                multiline
              />
              <Button
                disabled={busy || !testToolName}
                onPress={() =>
                  connection.tools.find((tool) => tool.name === testToolName)?.risk === "read"
                    ? void run(() => testTool())
                    : confirm(
                        "Run tool test",
                        "This tool can change data. Review the arguments before running it.",
                        () => testTool(true)
                      )
                }
              >
                Run test
              </Button>
              {testResult ? (
                <Text selectable style={{ color: theme.text }}>
                  {testResult}
                </Text>
              ) : null}
            </View>
          )}
          {connection.tools.map((tool) => {
            const policy = settings.policies.find(
              (candidate) =>
                candidate.connectionId === connectionId && candidate.toolName === tool.name
            );
            return (
              <View
                key={tool.name}
                style={{
                  gap: 8,
                  padding: 12,
                  borderRadius: 10,
                  borderColor: theme.separator,
                  borderWidth: 1,
                }}
              >
                <Text style={{ color: theme.text }}>{tool.name}</Text>
                {paragraph(tool.description)}
                <Switch
                  accessibilityLabel={`Enable ${tool.name}`}
                  disabled={busy}
                  value={policy?.enabled !== false}
                  onValueChange={(enabled) =>
                    void run(() =>
                      api((client) =>
                        client.setPluginPolicy(connectionId, {
                          botId: null,
                          toolName: tool.name,
                          enabled,
                          decision: policy?.decision ?? tool.defaultDecision,
                        })
                      )
                    )
                  }
                />
                <Choices
                  label="Approval"
                  values={["allow", "prompt", "deny"]}
                  current={policy?.decision ?? tool.defaultDecision}
                  onChange={(decision) =>
                    void run(() =>
                      api((client) =>
                        client.setPluginPolicy(connectionId, {
                          botId: null,
                          toolName: tool.name,
                          decision: decision as "allow" | "prompt" | "deny",
                        })
                      )
                    )
                  }
                />
              </View>
            );
          })}
        </>
      )}
    </>
  );
}
