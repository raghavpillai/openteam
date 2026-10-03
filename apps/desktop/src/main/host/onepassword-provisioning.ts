import { type NativeCommand } from "./native-command";
import { onePasswordError } from "@openteam/contracts/saved-logins";
import {
  credentialConnections,
  credentialConnectionId,
  type CapabilitySettingsStore,
  type CredentialProviderConnection,
} from "./capability-settings";

export type SavedLoginBackend = (
  operation: "import-token" | "view" | "disconnect" | "operation" | "sync" | "always-allow",
  input?: unknown,
  signal?: AbortSignal
) => Promise<any>;
const identifier = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/.test(value))
    throw new Error("Invalid 1Password account or vault ID");
  return value;
};
export class OnePasswordProvisioning {
  private busy = false;
  private controller?: AbortController;
  constructor(
    private readonly settings: CapabilitySettingsStore,
    private readonly backend: SavedLoginBackend
  ) {}
  cancel() {
    this.controller?.abort(onePasswordError("cancelled"));
  }
  async importToken(token: string) {
    if (this.busy) throw new Error("1Password setup is already running");
    if (typeof token !== "string" || token.length > 16 * 1024 || !/^ops_[A-Za-z0-9_-]+$/.test(token.trim())) throw new Error("Enter a valid 1Password service account token");
    this.busy = true;
    const controller = (this.controller = new AbortController());
    try { return await applySavedLoginConnections(this.settings, await this.backend("import-token", { token }, controller.signal)); }
    finally { this.busy = false; this.controller = undefined; }
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
    alwaysAllow: row.alwaysAllow === true,
    permissionRevision: Number(row.permissionRevision ?? 0),
    generation: Number(row.generation ?? 0),
    lifecycleState: String(row.lifecycleState ?? "active"),
    itemCount: Number(row.itemCount ?? 0),
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ?? null,
    lastSyncErrorCode: row.lastSyncErrorCode ?? null,
  }));
  return settings.mutate((settings) => {
    const connections = remote;
    if (JSON.stringify(connections) === JSON.stringify(credentialConnections(settings)))
      return settings;
    const permissions = (providers: CredentialProviderConnection[]) =>
      JSON.stringify(
        providers.map((row) => ({
          id: credentialConnectionId(row),
          alwaysAllow: row.alwaysAllow === true,
          generation: row.generation ?? 0,
          permissionRevision: row.permissionRevision ?? 0,
        }))
      );
    const changed = permissions(connections) !== permissions(credentialConnections(settings));
    return {
      ...settings,
      credentialProviders: connections,
      revocationEpoch: (settings.revocationEpoch ?? 0) + Number(changed),
    };
  });
}

export function brokerCredentialCommand(
  settings: CapabilitySettingsStore,
  backend: SavedLoginBackend
): NativeCommand {
  return async (file, args, signal) => {
    const accountId = args[args.indexOf("--account") + 1];
    const vaultId = args[args.indexOf("--vault") + 1];
    const config = credentialConnections(await settings.read()).find(
      (row) => row.account === accountId && row.vault === vaultId
    );
    if (!config) throw new Error("Saved-login connection not found");
    signal?.throwIfAborted();
    await applySavedLoginConnections(settings, await backend("view", undefined, signal));
    if (
      !credentialConnections(await settings.read()).some(
        (row) => credentialConnectionId(row) === credentialConnectionId(config)
      )
    )
      throw new Error("The saved-login connection was revoked");
    const operation =
      args[0] === "item" && ["get", "list"].includes(args[1]!)
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
