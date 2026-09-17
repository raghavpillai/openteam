import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { nativeCommand, type NativeCommand } from "./native-command";
import {
  credentialConnections,
  credentialConnectionId,
  type CapabilitySettingsStore,
} from "./capability-settings";

export type SavedLoginBackend = (
  operation: "view" | "begin" | "complete" | "disconnect" | "operation",
  input?: unknown
) => Promise<any>;
const identifier = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/.test(value))
    throw new Error("Invalid 1Password account or vault ID");
  return value;
};
export function provisioningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("OP_"))),
    OP_CACHE: "false",
    OP_BIOMETRIC_UNLOCK_ENABLED: "true",
    OP_LOAD_DESKTOP_APP_SETTINGS: "false",
  };
}
/** Only fixed provisioning verbs are available. This runner is never a model tool. */
export const runOnePasswordProvisioning: NativeCommand = async (_file, args, signal) => {
  const verb = args.slice(0, 2).join(" ");
  if (!["account list", "vault list", "vault create", "service-account create"].includes(verb))
    throw new Error("Unsupported 1Password setup operation");
  if (process.platform !== "darwin")
    throw new Error("1Password desktop provisioning currently requires macOS");
  let executable: string | undefined;
  for (const candidate of ["/opt/homebrew/bin/op", "/usr/local/bin/op", "/usr/bin/op"]) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      await nativeCommand(
        "/usr/bin/codesign",
        [
          "--verify",
          "--strict",
          '-R=identifier "com.1password.op" and anchor apple generic and certificate leaf[subject.OU] = "2BUA8C4S2C"',
          path,
        ],
        signal
      );
      executable = path;
      break;
    } catch {
      signal?.throwIfAborted();
    }
  }
  if (!executable)
    throw new Error("Install the signed 1Password CLI and enable its desktop integration");
  return new Promise<string>((resolve, reject) => {
    const process = spawn(executable!, args, {
      env: provisioningEnvironment(globalThis.process.env),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => process.kill("SIGKILL"), 240_000);
    process.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) process.kill("SIGKILL");
      else chunks.push(chunk);
    });
    process.stderr.resume();
    process.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("1Password setup could not start"));
    });
    process.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || size > 4 * 1024 * 1024)
        reject(new Error("1Password setup failed or was cancelled. Check its desktop approval."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
};

export class OnePasswordProvisioning {
  private busy = false;
  private uncertain = false;
  private pending:
    | { mintTicket: string; token: string; account: string; vault: string; vaultName: string }
    | undefined;
  constructor(
    private readonly settings: CapabilitySettingsStore,
    private readonly backend: SavedLoginBackend,
    private readonly run: NativeCommand = runOnePasswordProvisioning
  ) {}
  async accounts() {
    const rows = JSON.parse(await this.run("op", ["account", "list", "--format=json"]));
    if (!Array.isArray(rows)) throw new Error("1Password returned invalid account metadata");
    return rows.map((row) => ({
      id: identifier(row.account_uuid),
      label: String(row.email ?? row.url ?? row.account_uuid),
    }));
  }
  async connect(input: { account: string; vaultName: string; connectionId?: string }) {
    if (this.busy) throw new Error("1Password setup is already running");
    if (this.uncertain)
      throw new Error(
        "The previous setup may have created a service account. Review it in 1Password before restarting setup."
      );
    if (this.pending)
      throw new Error("Finish the pending connection before creating another service account");
    this.busy = true;
    try {
      const account = identifier(input.account),
        vaultName = input.vaultName?.trim();
      if (
        !vaultName ||
        vaultName.startsWith("-") ||
        vaultName.length > 256 ||
        /[\x00-\x1f\x7f]/.test(vaultName)
      )
        throw new Error("Enter a vault name");
      const existing = input.connectionId
        ? credentialConnections(await this.settings.read()).find(
            (row) => credentialConnectionId(row) === input.connectionId
          )
        : undefined;
      if (input.connectionId && (!existing?.broker || existing.account !== account))
        throw new Error("The connection to renew is unavailable");
      let vault = existing?.vault;
      if (!vault) {
        const rows = JSON.parse(
          await this.run("op", ["vault", "list", "--account", account, "--format=json"])
        );
        if (!Array.isArray(rows)) throw new Error("1Password returned invalid vault metadata");
        const matches = rows.filter((row) => row.name === vaultName);
        if (matches.length > 1)
          throw new Error("More than one vault has that name. Choose an unambiguous vault name.");
        const selected =
          matches[0] ??
          JSON.parse(
            await this.run("op", [
              "vault",
              "create",
              vaultName,
              "--account",
              account,
              "--format=json",
            ])
          );
        vault = identifier(selected.id);
      }
      const ticket = await this.backend("begin", {
        accountId: account,
        vaultId: vault,
        vaultName,
        connectionId: input.connectionId,
      });
      this.uncertain = true;
      const token = (
        await this.run("op", [
          "service-account",
          "create",
          `OpenTeam bots ${new Date().toISOString().slice(0, 10)} ${crypto.randomUUID().slice(0, 8)}`,
          "--account",
          account,
          "--vault",
          `${vault}:read_items`,
          "--expires-in",
          `${ticket.providerExpiresInSeconds}s`,
          "--raw",
        ])
      ).trim();
      if (!token || /\s/.test(token))
        throw new Error("1Password returned an invalid service account token");
      this.pending = { mintTicket: ticket.mintTicket, token, account, vault, vaultName };
      this.uncertain = false;
      return await this.finish();
    } finally {
      this.busy = false;
    }
  }
  async finish() {
    const pending = this.pending;
    if (!pending) return this.settings.read();
    // Repeating completion with the same ticket is idempotent after a lost response.
    await this.backend("complete", { mintTicket: pending.mintTicket, token: pending.token });
    const result = await this.settings.mutate((settings) => {
      const connection = {
        account: pending.account,
        vault: pending.vault,
        vaultName: pending.vaultName,
        broker: true,
      };
      const providers = [
        ...credentialConnections(settings).filter(
          (row) => credentialConnectionId(row) !== credentialConnectionId(connection)
        ),
        connection,
      ];
      return {
        ...settings,
        credentialProvider: providers[0] ?? null,
        credentialProviders: providers,
        revocationEpoch: (settings.revocationEpoch ?? 0) + 1,
      };
    });
    this.pending = undefined;
    return result;
  }
  acknowledgeUncertainSetup() {
    if (this.busy || this.pending) throw new Error("Finish the pending connection first");
    this.uncertain = false;
  }
  async refresh() {
    const rows = await this.backend("view");
    if (!Array.isArray(rows)) throw new Error("Invalid saved-login connection metadata");
    const remote = rows.map((row) => ({
      account: identifier(row.accountId),
      vault: identifier(row.vaultId),
      vaultName: String(row.vaultName),
      broker: true,
    }));
    return this.settings.mutate((settings) => {
      const connections = [
        ...credentialConnections(settings).filter(
          (row) =>
            !row.broker &&
            !remote.some((other) => credentialConnectionId(row) === credentialConnectionId(other))
        ),
        ...remote,
      ];
      if (JSON.stringify(connections) === JSON.stringify(credentialConnections(settings)))
        return settings;
      return {
        ...settings,
        credentialProvider: connections[0] ?? null,
        credentialProviders: connections,
        autoFill: settings.autoFill.filter((key) =>
          connections.some((row) => key.startsWith(credentialConnectionId(row) + ":"))
        ),
        revocationEpoch: (settings.revocationEpoch ?? 0) + 1,
      };
    });
  }
  async disconnect(connectionId: string) {
    await this.backend("disconnect", { connectionId });
    return this.settings.update({ removeCredentialConnection: connectionId });
  }
}

export function brokerCredentialCommand(
  settings: CapabilitySettingsStore,
  backend: SavedLoginBackend,
  fallback: NativeCommand = nativeCommand
): NativeCommand {
  return async (file, args, signal) => {
    const accountId = args[args.indexOf("--account") + 1];
    const vaultId = args[args.indexOf("--vault") + 1];
    const config = credentialConnections(await settings.read()).find(
      (row) => row.account === accountId && (args[0] === "whoami" || row.vault === vaultId)
    );
    if (!config?.broker) return fallback(file, args, signal);
    signal?.throwIfAborted();
    const operation =
      args[0] === "whoami"
        ? "status"
        : args[0] === "item" && ["get", "list"].includes(args[1]!)
          ? args[1]
          : undefined;
    if (!operation) throw new Error("Unsupported saved-login operation");
    const result = await backend("operation", {
      operation,
      accountId: config.account,
      vaultId: config.vault,
      ...(operation === "get" ? { itemId: args[2] } : {}),
    });
    signal?.throwIfAborted();
    return JSON.stringify(result);
  };
}
