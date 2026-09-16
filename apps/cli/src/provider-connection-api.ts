import { execFile } from "node:child_process";
import { readManifest, type InstallationPaths } from "./config";
import { readReusableCredential, type LoginDetectionOptions } from "./detected-logins";
import { requireComposeProject } from "./docker";
import { CliError } from "./errors";
import type { CommandRunner } from "./process";

export interface AuthSession {
  id: string;
  providerId: string;
  authType: "oauth" | "api_key";
  status: "running" | "waiting" | "connected" | "failed" | "cancelled";
  prompt: {
    id: string;
    type: "text" | "secret" | "select" | "manual_code";
    message: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  } | null;
  authorizationUrl: string | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  messages: string[];
  error: string | null;
}
export interface ProviderConnectionAPI {
  start(provider: string, auth: "oauth" | "api_key"): Promise<AuthSession>;
  read(id: string): Promise<AuthSession>;
  respond(id: string, prompt: string, value: string): Promise<AuthSession>;
  cancel(id: string): Promise<void>;
  importLogin(provider: string, signal?: AbortSignal): Promise<void>;
}

export type Invocation = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
export type AsyncProcess = (
  invocation: Invocation,
  input?: string,
  timeoutMs?: number,
  signal?: AbortSignal
) => Promise<string>;

/** Pipe secrets to the child; never include them in argv or surface raw child errors. */
export const runConnectionProcess: AsyncProcess = (invocation, input, timeoutMs = 15_000, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      invocation.command,
      [...invocation.args],
      {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 256_000,
        signal,
      },
      (error, output) => {
        if (error)
          reject(
            new CliError(
              error.killed
                ? "The connection request timed out. Check openteam doctor, then retry."
                : "The connection command failed. Check openteam doctor, then retry."
            )
          );
        else resolve(output);
      }
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

// Use the computer's existing authenticated connection API through Docker. This also
// works with installed server versions that predate CLI-specific HTTP auth routes.
// The control token stays inside the container; prompt responses arrive on stdin.
export const AUTH_REQUEST_SCRIPT = [
  "const input = JSON.parse(await new Response(Bun.stdin.stream()).text());",
  'if (!/^\\/v1\\/inference\\/(providers\\/[^/]+\\/auth-sessions|auth-sessions\\/[^/]+(?:\\/respond)?)$/.test(input.path)) throw new Error("Invalid auth route");',
  "const port = Number(process.env.OPENTEAM_COMPUTER_PORT || 8790);",
  'const response = await fetch("http://127.0.0.1:" + port + input.path, {',
  'method: input.method, redirect: "error", signal: AbortSignal.timeout(10000),',
  'headers: {authorization: "Bearer " + process.env.OPENTEAM_CONTROL_TOKEN, "content-type": "application/json"},',
  "...(input.body === undefined ? {} : {body: JSON.stringify(input.body)})});",
  "console.log(JSON.stringify({status: response.status, body: await response.json().catch(() => null)}));",
].join("\n");

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () =>
  new CliError("The connection service returned invalid data. Update OpenTeam and retry.");

export const parseAuthSession = (value: unknown): AuthSession => {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.providerId !== "string" ||
    !["oauth", "api_key"].includes(String(value.authType)) ||
    !["running", "waiting", "connected", "failed", "cancelled"].includes(String(value.status))
  )
    throw invalid();
  const prompt = value.prompt;
  if (
    prompt !== null &&
    (!object(prompt) ||
      typeof prompt.id !== "string" ||
      !["text", "secret", "select", "manual_code"].includes(String(prompt.type)) ||
      typeof prompt.message !== "string" ||
      (prompt.type === "select" &&
        (!Array.isArray(prompt.options) ||
          !prompt.options.length ||
          prompt.options.some(
            (option) =>
              !object(option) || typeof option.id !== "string" || typeof option.label !== "string"
          ))))
  )
    throw invalid();
  const device = value.deviceCode;
  if (
    device !== null &&
    (!object(device) ||
      typeof device.userCode !== "string" ||
      typeof device.verificationUri !== "string")
  )
    throw invalid();
  if (value.authorizationUrl !== null && typeof value.authorizationUrl !== "string")
    throw invalid();
  // Copy only fields that the connection UI uses. Unexpected credential fields are discarded.
  return {
    id: value.id,
    providerId: value.providerId,
    authType: value.authType as AuthSession["authType"],
    status: value.status as AuthSession["status"],
    prompt: object(prompt)
      ? {
          id: prompt.id as string,
          type: prompt.type as NonNullable<AuthSession["prompt"]>["type"],
          message: prompt.message as string,
          ...(Array.isArray(prompt.options)
            ? {
                options: prompt.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  ...(typeof option.description === "string"
                    ? { description: option.description }
                    : {}),
                })),
              }
            : {}),
        }
      : null,
    authorizationUrl: value.authorizationUrl as string | null,
    deviceCode: object(device)
      ? {
          userCode: device.userCode as string,
          verificationUri: device.verificationUri as string,
        }
      : null,
    messages: [],
    error: typeof value.error === "string" ? value.error : null,
  };
};

export const createProviderConnectionAPI = (
  paths: InstallationPaths,
  runner: CommandRunner,
  processRun: AsyncProcess = runConnectionProcess,
  detection: LoginDetectionOptions = { runner }
): ProviderConnectionAPI => {
  const project = requireComposeProject(paths, runner, readManifest(paths)?.projectName);
  const request = async (path: string, method = "GET", body?: unknown, allowMissing = false) => {
    const raw = await processRun(
      project.invocation(["exec", "--no-TTY", "computer", "bun", "-e", AUTH_REQUEST_SCRIPT]),
      JSON.stringify({ path, method, ...(body === undefined ? {} : { body }) })
    );
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      throw invalid();
    }
    if (!object(result) || typeof result.status !== "number") throw invalid();
    if (allowMissing && result.status === 404) return null;
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 404)
        throw new CliError(
          "The connection session is unavailable. Go back and start a new connection."
        );
      if (result.status === 401 || result.status === 403)
        throw new CliError(
          "OpenTeam could not access its connection service. Run openteam doctor."
        );
      throw new CliError(
        "The connection service rejected the request (HTTP " +
          result.status +
          "). Go back and retry."
      );
    }
    return result.body;
  };
  const sessionPath = (id: string) => "/v1/inference/auth-sessions/" + encodeURIComponent(id);
  return {
    start: async (provider, authType) =>
      parseAuthSession(
        await request(
          "/v1/inference/providers/" + encodeURIComponent(provider) + "/auth-sessions",
          "POST",
          { authType }
        )
      ),
    read: async (id) => parseAuthSession(await request(sessionPath(id))),
    respond: async (id, promptId, value) =>
      parseAuthSession(await request(sessionPath(id) + "/respond", "POST", { promptId, value })),
    cancel: async (id) => {
      await request(sessionPath(id), "DELETE", undefined, true);
    },
    importLogin: async (provider, signal) => {
      signal?.throwIfAborted();
      if (provider !== "anthropic" && provider !== "openai-codex")
        throw new CliError("This provider does not support importing a local login.");
      let found = readReusableCredential(provider, { ...detection, runner: undefined });
      // A Keychain prompt must not block the terminal event loop; cancellation remains usable.
      if (
        !found &&
        provider === "anthropic" &&
        (detection.platform ?? process.platform) === "darwin" &&
        !(detection.env ?? process.env).CLAUDE_CONFIG_DIR
      ) {
        try {
          const raw = await processRun(
            {
              command: "security",
              args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
            },
            undefined,
            10_000,
            signal
          );
          found = readReusableCredential(provider, {
            ...detection,
            runner: { run: () => ({ status: 0, stdout: raw, stderr: "" }) },
          });
        } catch {
          /* No readable Keychain login; offer browser sign-in. */
        }
      }
      signal?.throwIfAborted();
      const name = provider === "anthropic" ? "Claude Code" : "Codex";
      if (!found)
        throw new CliError(
          "No reusable " +
            name +
            " login found on this computer. Sign in with " +
            name +
            " first, or choose Browser sign-in."
        );
      try {
        await processRun(
          project.invocation([
            "exec",
            "--no-TTY",
            "computer",
            "openteam-pi-auth",
            "import",
            provider,
          ]),
          JSON.stringify(found.credential),
          40_000
        );
      } catch {
        throw new CliError(
          "Could not import the " +
            name +
            " login. It may have expired. Sign in there again, or choose Browser sign-in."
        );
      }
      // A successful subprocess exit alone does not prove that authentication was stored.
      const raw = await processRun(
        project.invocation(["exec", "--no-TTY", "computer", "openteam-pi-auth", "providers"])
      );
      let providers: unknown;
      try {
        providers = JSON.parse(raw);
      } catch {
        throw invalid();
      }
      if (
        !Array.isArray(providers) ||
        !providers.some(
          (p) =>
            object(p) &&
            p.id === provider &&
            (p.configured === true || p.connected === true) &&
            p.authType === "oauth"
        )
      )
        throw new CliError(
          "The imported login was not saved. Choose Browser sign-in to reconnect."
        );
    },
  };
};
