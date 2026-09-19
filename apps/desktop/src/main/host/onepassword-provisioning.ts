import { nativeCommand, type NativeCommand } from "./native-command";
import { onePasswordError, onePasswordErrorCode } from "@openteam/contracts/saved-logins";
import {
  credentialConnections,
  credentialConnectionId,
  type CapabilitySettingsStore,
} from "./capability-settings";

export type SavedLoginBackend = (
  operation: "view" | "begin" | "complete" | "disconnect" | "operation" | "sync" | "always-allow",
  input?: unknown,
  signal?: AbortSignal
) => Promise<any>;
const identifier = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/.test(value))
    throw new Error("Invalid 1Password account or vault ID");
  return value;
};
export { provisioningEnvironment } from "./onepassword-cli";

export class OnePasswordProvisioning {
  private busy = false;
  private controller?: AbortController;
  private uncertain = false;
  private pending:
    | {
        mintTicket: string;
        token: string;
        account: string;
        vault: string;
        vaultName: string;
        expectedGeneration: number;
      }
    | undefined;
  constructor(
    private readonly settings: CapabilitySettingsStore,
    private readonly backend: SavedLoginBackend,
    private readonly run: NativeCommand,
    private readonly prepare?: (signal: AbortSignal) => Promise<unknown>
  ) {}
  async accounts() {
    if (this.busy) throw new Error("1Password setup is already running");
    this.busy = true;
    const controller = (this.controller = new AbortController());
    try {
      const rows = JSON.parse(
        await this.run("op", ["account", "list", "--format=json"], controller.signal)
      );
      controller.signal.throwIfAborted();
      if (!Array.isArray(rows) || rows.length > 50)
        throw new Error("1Password returned invalid account metadata");
      return rows.map((row) => ({
        id: identifier(row.account_uuid),
        label: String(row.email ?? row.url ?? row.account_uuid),
      }));
    } finally {
      this.busy = false;
      this.controller = undefined;
    }
  }
  cancel() {
    this.controller?.abort(onePasswordError("cancelled"));
  }
  async connect(input: { account: string; vaultName: string; connectionId?: string }) {
    if (this.busy) throw new Error("1Password setup is already running");
    if (this.uncertain) throw onePasswordError("delivery-indeterminate");
    if (this.pending) throw onePasswordError("completion-pending");
    this.busy = true;
    const controller = (this.controller = new AbortController());
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
      await this.prepare?.(controller.signal);
      controller.signal.throwIfAborted();
      let vault = existing?.vault;
      if (!vault) {
        const rows = JSON.parse(
          await this.run(
            "op",
            ["vault", "list", "--account", account, "--format=json"],
            controller.signal
          )
        );
        if (!Array.isArray(rows) || rows.length > 1000)
          throw new Error("1Password returned invalid vault metadata");
        const matches = rows.filter((row) => row.name === vaultName);
        if (matches.length > 1) throw onePasswordError("conflict");
        const selected =
          matches[0] ??
          JSON.parse(
            await this.run(
              "op",
              ["vault", "create", vaultName, "--account", account, "--format=json"],
              controller.signal
            )
          );
        vault = identifier(selected.id);
      }
      const ticket = await this.backend(
        "begin",
        {
          accountId: account,
          vaultId: vault,
          vaultName,
          connectionId: input.connectionId,
        },
        controller.signal
      );
      identifier(ticket.mintTicket);
      controller.signal.throwIfAborted();
      if (
        !Number.isSafeInteger(ticket.providerExpiresInSeconds) ||
        ticket.providerExpiresInSeconds < 60 ||
        ticket.providerExpiresInSeconds > 365 * 86400
      )
        throw new Error("The server returned an invalid 1Password token lifetime");
      if (
        ticket.connectionId !== `1password:${account}:${vault}` ||
        !Number.isSafeInteger(ticket.expectedGeneration) ||
        ticket.expectedGeneration < 0
      )
        throw new Error("The server returned an invalid 1Password mint ticket");
      this.uncertain = true;
      const token = (
        await this.run(
          "op",
          [
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
          ],
          controller.signal
        ).catch((error) => {
          if (
            [
              "denied",
              "permission",
              "service-account-limit",
              "conflict",
              "integration-off",
            ].includes(onePasswordErrorCode(error) ?? "")
          )
            this.uncertain = false;
          throw error;
        })
      ).trim();
      if (token.length > 16 * 1024 || !/^ops_[A-Za-z0-9_-]+$/.test(token))
        throw new Error("1Password returned an invalid service account token");
      this.pending = {
        mintTicket: ticket.mintTicket,
        token,
        account,
        vault,
        vaultName,
        expectedGeneration: ticket.expectedGeneration,
      };
      this.uncertain = false;
      controller.signal.throwIfAborted();
      return await this.finish();
    } catch (error) {
      if (this.pending) throw onePasswordError("completion-pending");
      if (this.uncertain) throw onePasswordError("delivery-indeterminate");
      throw error;
    } finally {
      this.busy = false;
      this.controller = undefined;
    }
  }
  async finish() {
    const pending = this.pending;
    if (!pending) return this.settings.read();
    // Repeating completion with the same ticket is idempotent after a lost response.
    const rows = await this.backend("complete", {
      mintTicket: pending.mintTicket,
      token: pending.token,
    }).catch(() => {
      throw onePasswordError("completion-pending");
    });
    if (
      !Array.isArray(rows) ||
      !rows.some(
        (row) =>
          row.id === `1password:${pending.account}:${pending.vault}` &&
          row.accountId === pending.account &&
          row.vaultId === pending.vault &&
          row.generation === pending.expectedGeneration + 1
      )
    )
      throw onePasswordError("completion-pending");
    const result = await applySavedLoginConnections(this.settings, rows);
    this.pending = undefined;
    return result;
  }
  acknowledgeUncertainSetup() {
    if (this.busy || this.pending) throw new Error("Finish the pending connection first");
    this.uncertain = false;
  }
  async refresh() {
    const rows = await this.backend("view");
    return applySavedLoginConnections(this.settings, rows);
  }
  async sync(connectionId?: string) {
    return applySavedLoginConnections(this.settings, await this.backend("sync", { connectionId }));
  }
  async setAlwaysAllow(connectionId: string, alwaysAllow: boolean) {
    if (typeof alwaysAllow !== "boolean") throw new Error("Invalid saved-login permission");
    const rows = await this.backend("always-allow", { connectionId, alwaysAllow });
    await this.settings.mutate((settings) => ({
      ...settings,
      autoFill: settings.autoFill.filter((key) => !key.startsWith(connectionId + ":")),
      revocationEpoch: (settings.revocationEpoch ?? 0) + 1,
    }));
    return applySavedLoginConnections(this.settings, rows);
  }
  async disconnect(connectionId: string) {
    await this.backend("disconnect", { connectionId });
    return this.settings.update({ removeCredentialConnection: connectionId });
  }
}

async function applySavedLoginConnections(settings: CapabilitySettingsStore, rows: unknown) {
  if (!Array.isArray(rows)) throw new Error("Invalid saved-login connection metadata");
  const remote = rows.map((row) => ({
    account: identifier(row.accountId),
    vault: identifier(row.vaultId),
    vaultName: String(row.vaultName),
    broker: true,
    alwaysAllow: row.alwaysAllow === true,
    permissionRevision: Number(row.permissionRevision ?? 0),
    generation: Number(row.generation ?? 0),
    lifecycleState: String(row.lifecycleState ?? "active"),
    expiresAt: row.expiresAt ?? null,
    itemCount: Number(row.itemCount ?? 0),
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ?? null,
    lastSyncErrorCode: row.lastSyncErrorCode ?? null,
  }));
  return settings.mutate((settings) => {
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
    const permissions = (providers: typeof connections) =>
      JSON.stringify(
        providers.map((row) => ({
          id: credentialConnectionId(row),
          broker: row.broker === true,
          alwaysAllow: row.alwaysAllow === true,
          generation: row.generation ?? 0,
          permissionRevision: row.permissionRevision ?? 0,
        }))
      );
    const changed = permissions(connections) !== permissions(credentialConnections(settings));
    return {
      ...settings,
      credentialProvider: connections[0] ?? null,
      credentialProviders: connections,
      autoFill: settings.autoFill.filter((key) =>
        connections.some((row) => {
          const previous = credentialConnections(settings).find(
            (old) => credentialConnectionId(old) === credentialConnectionId(row)
          );
          return (
            key.startsWith(credentialConnectionId(row) + ":") &&
            (!row.broker || (row.permissionRevision ?? 0) === (previous?.permissionRevision ?? 0))
          );
        })
      ),
      revocationEpoch: (settings.revocationEpoch ?? 0) + Number(changed),
    };
  });
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
    await applySavedLoginConnections(settings, await backend("view", undefined, signal));
    if (
      !credentialConnections(await settings.read()).some(
        (row) => credentialConnectionId(row) === credentialConnectionId(config)
      )
    )
      throw new Error("The saved-login connection was revoked");
    const operation =
      args[0] === "whoami"
        ? "status"
        : args[0] === "item" && ["get", "list"].includes(args[1]!)
          ? args[1]
          : undefined;
    if (!operation) throw new Error("Unsupported saved-login operation");
    let result: unknown;
    try {
      result = await backend(
        "operation",
        {
          operation,
          accountId: config.account,
          vaultId: config.vault,
          ...(operation === "get" ? { itemId: args[2] } : {}),
        },
        signal
      );
    } finally {
      await applySavedLoginConnections(settings, await backend("view", undefined, signal));
    }
    signal?.throwIfAborted();
    return JSON.stringify(result);
  };
}
