import { Button, Field, Choices } from "./plugin-controls";
import type { PluginWorkspaceModel } from "./use-plugin-workspace";
export function CustomMcp({ model }: { model: PluginWorkspaceModel }) {
  const {
    customName,
    setCustomName,
    values,
    customTransport,
    setCustomTransport,
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
    customAuth,
    setCustomAuth,
    busy,
    run,
    api,
  } = model;
  return (
    <>
      <Field label="Server name" value={customName} onChange={setCustomName} />
      <Choices
        label="Runs through"
        values={["HTTP", "Bot computer"]}
        current={customTransport}
        onChange={setCustomTransport}
      />
      {customTransport === "HTTP" ? (
        <>
          <Field label="Server URL" value={endpoint} onChange={setEndpoint} />
          <Field label="Headers (JSON)" value={headers} onChange={setHeaders} multiline />
        </>
      ) : (
        <>
          <Field label="Command on Bot computer" value={command} onChange={setCommand} />
          <Field label="Arguments (JSON array)" value={args} onChange={setArgs} multiline />
          <Field label="Working directory" value={cwd} onChange={setCwd} />
          <Field label="Environment (JSON)" value={env} onChange={setEnv} multiline />
        </>
      )}
      <Choices
        label="Authentication"
        values={["none", "token", "oauth"]}
        current={customAuth}
        onChange={setCustomAuth}
      />
      <Button
        disabled={busy || !customName}
        onPress={() =>
          void run(
            () =>
              api((client) =>
                client.addCustomMcp({
                  name: customName,
                  auth: customAuth as "none" | "token" | "oauth",
                  ...(customTransport === "HTTP"
                    ? { url: endpoint, headers: headers ? JSON.parse(headers) : {} }
                    : {
                        command,
                        args: JSON.parse(args),
                        cwd,
                        env: env ? JSON.parse(env) : {},
                      }),
                })
              ),
            "Server added. Open Connections to finish setup."
          )
        }
      >
        Add server
      </Button>
    </>
  );
}
