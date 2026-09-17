import { createHash } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import type { Client } from "@1password/sdk";

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
    private readonly connect: SavedLoginProvider = provider
  ) {}
  async view() {
    return this.db.savedLoginConnection.findMany({
      where: { enabled: true },
      orderBy: { id: "asc" },
      select: {
        id: true,
        accountId: true,
        vaultId: true,
        vaultName: true,
        generation: true,
        expiresAt: true,
      },
    });
  }
  async begin(input: any) {
    let accountId = id(input?.accountId),
      vaultId = id(input?.vaultId),
      vaultName = label(input?.vaultName);
    const connectionId = `1password:${accountId}:${vaultId}`;
    const row = await this.db.savedLoginConnection.findUnique({ where: { id: connectionId } });
    if (input.connectionId && input.connectionId !== connectionId) throw invalid();
    const seconds = input.expiresInSeconds === undefined ? 90 * 86400 : input.expiresInSeconds;
    if (!Number.isInteger(seconds) || seconds < 3600 || seconds > 365 * 86400) throw invalid();
    const mint = await this.db.savedLoginMint.create({
      data: {
        connectionId,
        accountId,
        vaultId,
        vaultName,
        expectedGeneration: row?.generation ?? 0,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        providerExpiresAt: new Date(Date.now() + seconds * 1000),
      },
    });
    return {
      mintTicket: mint.id,
      connectionId,
      expectedGeneration: mint.expectedGeneration,
      providerExpiresInSeconds: seconds,
    };
  }
  async complete(input: any) {
    const mintTicket = id(input?.mintTicket);
    if (
      typeof input?.token !== "string" ||
      input.token.length < 20 ||
      input.token.length > 32768 ||
      /\s/.test(input.token)
    )
      throw invalid();
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const ticket = await this.db.savedLoginMint.findUnique({ where: { id: mintTicket } });
    if (!ticket) throw invalid();
    if (!ticket.completedAt) {
      if (ticket.expiresAt.getTime() < Date.now()) throw invalid();
      try {
        const client = await this.connect(input.token);
        const vaults = await client.vaults.list();
        if (vaults.length !== 1 || vaults[0]?.id !== ticket.vaultId) throw invalid();
        // Verify the intended vault is readable before storing a connection.
        await client.items.list(ticket.vaultId);
      } catch {
        throw new ApiError(
          400,
          "saved_login_provider_unavailable",
          "1Password could not validate read access to the selected vault. No connection was saved."
        );
      }
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 7)::text`;
      const fresh = await tx.savedLoginMint.findUniqueOrThrow({ where: { id: mintTicket } });
      const current = await tx.savedLoginConnection.findUnique({
        where: { id: fresh.connectionId },
      });
      if (fresh.completedAt) {
        if (
          fresh.tokenHash !== tokenHash ||
          !current?.enabled ||
          current.generation !== fresh.expectedGeneration + 1
        )
          throw invalid();
        return;
      }
      if (
        fresh.expiresAt.getTime() < Date.now() ||
        (current?.generation ?? 0) !== fresh.expectedGeneration
      )
        throw invalid();
      const data = {
        accountId: fresh.accountId,
        vaultId: fresh.vaultId,
        vaultName: fresh.vaultName,
        token: input.token,
        generation: fresh.expectedGeneration + 1,
        enabled: true,
        expiresAt: fresh.providerExpiresAt,
      };
      await tx.savedLoginConnection.upsert({
        where: { id: fresh.connectionId },
        create: { id: fresh.connectionId, ...data },
        update: data,
      });
      await tx.savedLoginMint.update({
        where: { id: mintTicket },
        data: { tokenHash, completedAt: new Date() },
      });
    });
    return this.view();
  }
  async disconnect(connectionId: string) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 7)::text`;
      await tx.savedLoginConnection.updateMany({
        where: { id: connectionId },
        data: { token: null, enabled: false, generation: { increment: 1 } },
      });
      await tx.savedLoginMint.deleteMany({ where: { connectionId } });
    });
    return this.view();
  }
  /** Native main-process transport only; not a model tool or renderer IPC. */
  async operation(input: any) {
    if (!["list", "get", "status"].includes(input?.operation)) throw invalid();
    const connection = await this.db.savedLoginConnection.findFirst({
      where: { accountId: id(input.accountId), vaultId: id(input.vaultId), enabled: true },
    });
    if (!connection?.token || (connection.expiresAt && connection.expiresAt.getTime() < Date.now()))
      throw new ApiError(
        409,
        "saved_login_renewal_required",
        "Renew this 1Password connection in Computer settings"
      );
    try {
      const client = await this.connect(connection.token);
      const result =
        input.operation === "get"
          ? await client.items.get(connection.vaultId, id(input.itemId))
          : await client.items.list(connection.vaultId);
      // A disconnect/renewal that races the provider read invalidates its result.
      const current = await this.db.savedLoginConnection.findUnique({
        where: { id: connection.id },
      });
      if (!current?.enabled || current.generation !== connection.generation) throw invalid();
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
      return Array.isArray(result)
        ? result
            .filter(
              (value) => value.state === "active" && ["Login", "Password"].includes(value.category)
            )
            .map((value) => item(value, false))
        : item(result, true);
    } catch {
      throw new ApiError(
        503,
        "saved_login_provider_unavailable",
        "1Password is unavailable or the connection changed. Check saved-login settings."
      );
    }
  }
}
