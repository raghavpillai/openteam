import { SavedLoginTokenCipher } from "./saved-login-token";
import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { AuthExpiredError, type Client } from "@1password/sdk";

const invalid = () =>
  new ApiError(400, "saved_login_invalid", "Invalid saved-login connection request");
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/.test(value)) throw invalid();
  return value;
};
const label = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))
    throw invalid();
  return value.trim();
};
type Provider = Pick<Client, "items" | "vaults">;
export type SavedLoginProvider = (token: string) => Promise<Provider>;
const provider: SavedLoginProvider = async (token) => {
  const { createClient } = await import("@1password/sdk");
  return createClient({
    auth: token,
    integrationName: "OpenTeam saved logins",
    integrationVersion: "1.0.0",
  });
};

/** Owner-only connection management. Tokens are never part of metadata responses. */
export class SavedLoginService {
  constructor(
    private readonly db: PrismaClient,
    private readonly connect: SavedLoginProvider = provider,
    private readonly cipher = new SavedLoginTokenCipher()
  ) {}
  async view() {
    const rows = await this.db.savedLoginConnection.findMany({
      where: { enabled: true },
      orderBy: { id: "asc" },
      select: {
        id: true,
        accountId: true,
        vaultId: true,
        vaultName: true,
        generation: true,
        itemCount: true,
        lastSuccessfulSyncAt: true,
        lastSyncErrorCode: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      lifecycleState: row.lastSyncErrorCode === "provider-rejected" ? "provider-rejected" : "active",
    }));
  }
  async sync(input?: any) {
    const connectionId = input?.connectionId;
    if (
      connectionId !== undefined &&
      (typeof connectionId !== "string" || connectionId.length > 1024)
    )
      throw invalid();
    const rows = await this.db.savedLoginConnection.findMany({
      where: { enabled: true, ...(connectionId ? { id: connectionId } : {}) },
    });
    if (connectionId && !rows.length)
      throw new ApiError(
        404,
        "saved_login_not_found",
        "This saved-login connection is unavailable"
      );
    for (const row of rows) {
      try {
        await this.operation({ operation: "list", accountId: row.accountId, vaultId: row.vaultId });
      } catch {
        /* Persisted status explains each failure; other connections still refresh. */
      }
    }
    return this.view();
  }
  async importToken(input: any) {
    const token = typeof input?.token === "string" ? input.token.trim() : "";
    if (token.length > 16 * 1024 || !/^ops_[A-Za-z0-9_-]+$/.test(token)) throw invalid();
    // Validate through 1Password, rather than trusting token contents or user-entered vault IDs.
    let scopes: Array<{ id: string; title: string; itemCount: number }>;
    try {
      const client = await this.connect(token);
      const vaults = await client.vaults.list();
      if (!vaults.length || vaults.length > 1000) throw invalid();
      const seen = new Set<string>();
      scopes = [];
      // Validate every granted vault before saving any connection. Never trust token claims.
      for (const vault of vaults) {
        const vaultId = id(vault.id);
        if (seen.has(vaultId)) throw invalid();
        seen.add(vaultId);
        const title = label(vault.title);
        const itemCount = (await client.items.list(vaultId)).filter(
          value => value.state === "active" && ["Login", "Password"].includes(value.category)
        ).length;
        scopes.push({ id: vaultId, title, itemCount });
      }
    } catch {
      throw new ApiError(400, "saved_login_token_invalid", "Use a valid service account token with read access to the vaults you want to connect.");
    }
    // Each vault is independently approved and disconnected, even when a token grants several.
    const connections = scopes.map(vault => {
      const connectionId = `1password:service-account:${vault.id}`;
      return { vault, connectionId, encrypted: this.cipher.encrypt(token, connectionId) };
    });
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 7)::text`;
      for (const { vault, connectionId, encrypted } of connections) {
        const current = await tx.savedLoginConnection.findUnique({ where: { id: connectionId } });
        const data = {
          accountId: "service-account", vaultId: vault.id, vaultName: vault.title,
          token: encrypted, enabled: true, generation: (current?.generation ?? 0) + 1,
          // The provider controls imported-token expiry; do not invent a lifetime.
          itemCount: vault.itemCount, lastSuccessfulSyncAt: new Date(), lastSyncErrorCode: null,
        };
        await tx.savedLoginConnection.upsert({ where: { id: connectionId }, create: { id: connectionId, ...data }, update: data });
      }
    });
    return this.view();
  }
  async disconnect(connectionId: string) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 7)::text`;
      await tx.savedLoginConnection.updateMany({
        where: { id: connectionId },
        data: {
          token: null,
          enabled: false,
          generation: { increment: 1 },
        },
      });
    });
    return this.view();
  }
  /** Native main-process transport only; not a model tool or renderer IPC. */
  async operation(input: any) {
    if (!["list", "get"].includes(input?.operation)) throw invalid();
    const connection = await this.db.savedLoginConnection.findFirst({
      where: { accountId: id(input.accountId), vaultId: id(input.vaultId), enabled: true },
    });
    if (!connection?.token)
      throw new ApiError(
        409,
        "saved_login_renewal_required",
        "Renew this 1Password connection in Marketplace → 1Password"
      );
    try {
      const client = await this.connect(this.cipher.decrypt(connection.token, connection.id));
      const result =
        input.operation === "get"
          ? await client.items.get(connection.vaultId, id(input.itemId))
          : await client.items.list(connection.vaultId);
      // A disconnect/renewal that races the provider read invalidates its result.
      const current = await this.db.savedLoginConnection.findUnique({
        where: { id: connection.id },
      });
      if (
        !current?.enabled ||
        current.generation !== connection.generation
      )
        throw invalid();
      const item = (value: any, full: boolean) => ({
        id: value.id,
        title: value.title,
        category: String(value.category).toUpperCase(),
        updated_at: `${connection.generation}:${new Date(value.updatedAt).toISOString()}`,
        urls: value.websites.map((website: any) => ({
          href: website.url,
          autofillBehavior: website.autofillBehavior,
        })),
        ...(full
          ? {
              fields: value.fields
                .filter(
                  (field: any) => !field.sectionId && ["username", "password"].includes(field.id)
                )
                .map((field: any) => ({ purpose: field.id.toUpperCase(), value: field.value })),
            }
          : {}),
      });
      const output = Array.isArray(result)
        ? result
            .filter(
              (value) => value.state === "active" && ["Login", "Password"].includes(value.category)
            )
            .map((value) => item(value, false))
        : item(result, true);
      if (Array.isArray(output))
        await this.db.savedLoginConnection.updateMany({
          where: {
            id: connection.id,
            enabled: true,
            generation: connection.generation,
          },
          data: {
            itemCount: output.length,
            lastSuccessfulSyncAt: new Date(),
            lastSyncErrorCode: null,
          },
        });
      return output;
    } catch (error) {
      const status =
        (error as { status?: number; statusCode?: number })?.status ??
        (error as { statusCode?: number })?.statusCode;
      await this.db.savedLoginConnection.updateMany({
        where: {
          id: connection.id,
          enabled: true,
          generation: connection.generation,
        },
        data: {
          lastSyncErrorCode:
            error instanceof AuthExpiredError || status === 401 || status === 403
              ? "provider-rejected"
              : "provider-unavailable",
        },
      });
      throw new ApiError(
        503,
        "saved_login_provider_unavailable",
        "1Password is unavailable or the connection changed. Check saved-login settings."
      );
    }
  }
}
