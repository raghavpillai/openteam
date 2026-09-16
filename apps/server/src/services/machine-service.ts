import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import { HOST_BRIDGE_PATHS, parseHostMachinesResponse } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import { MachineRelay } from "../machine-relay";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class MachineService {
  constructor(private readonly db: PrismaClient, private readonly token: string, private readonly fetcher: typeof fetch = fetch, readonly relay = new MachineRelay(), private readonly authDisabled = false) {}

  async list(probe = false) {
    const rows = await this.db.hostMachine.findMany({ orderBy: { createdAt: "asc" } });
    return Promise.all(rows.map(async row => {
      let connected = row.transport === "relay" ? this.relay.connected(row.machineId) && await this.sessionValid(row.authSessionId) : false;
      if (row.enabled && row.transport === "direct" && probe && row.bridgeUrl) try {
        const machine = await this.probe(row.bridgeUrl);
        connected = machine.machineId === row.machineId;
        if (connected) Object.assign(row, await this.db.hostMachine.update({ where: { machineId: row.machineId }, data: { label: machine.label, localToolPermission: machine.localToolPermission, lastSeenAt: new Date() } }));
      } catch { /* Offline machines remain in the roster. */ }
      else if (row.transport === "direct" && !probe) connected = !!(row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < 60_000);
      // Never return enrollment credentials or session identifiers to clients/tools.
      return { machineId: row.machineId, label: row.label, bridgeUrl: row.bridgeUrl, transport: row.transport, enabled: row.enabled, localToolPermission: row.localToolPermission, lastSeenAt: row.lastSeenAt, connected: row.enabled && connected };
    }));
  }

  private async sessionValid(id: string | null) {
    if (id === null) return this.authDisabled;
    const session = await this.db.session.findUnique({ where: { id }, select: { expiresAt: true } });
    return !!session && session.expiresAt > new Date();
  }

  private async probe(bridgeUrl: string) {
    const response = await this.fetcher(`${bridgeUrl}${HOST_BRIDGE_PATHS.machines}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: "{}", redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new ApiError(409, "machine_unavailable", "The computer did not accept the deployment bridge token. Open its desktop app and check the address.");
    const machines = parseHostMachinesResponse(await response.json()).machines;
    if (machines.length !== 1) throw new ApiError(409, "machine_identity_invalid", "The endpoint must identify one physical computer");
    return machines[0]!;
  }

  async save(raw: unknown) {
    const input = raw as { bridgeUrl?: unknown };
    if (!input || typeof input.bridgeUrl !== "string") throw new ApiError(400, "machine_url_required", "Enter the computer's bridge URL");
    let url: URL; try { url = new URL(input.bridgeUrl); } catch { throw new ApiError(400, "machine_url_invalid", "Use an HTTP or HTTPS bridge URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new ApiError(400, "machine_url_invalid", "Use an HTTP or HTTPS origin without credentials, paths or query parameters");
    const machine = await this.probe(url.origin);
    const existing = await this.db.hostMachine.findUnique({ where: { machineId: machine.machineId } });
    if (existing && (existing.transport === "relay" || existing.bridgeUrl !== url.origin)) throw new ApiError(409, "machine_identity_conflict", "This computer ID already belongs to another connection");
    return this.db.hostMachine.upsert({ where: { machineId: machine.machineId }, create: { machineId: machine.machineId, label: machine.label, bridgeUrl: url.origin, localToolPermission: machine.localToolPermission, lastSeenAt: new Date() }, update: { label: machine.label, localToolPermission: machine.localToolPermission, lastSeenAt: new Date(), enabled: true } });
  }

  async enroll(raw: unknown, authSessionId: string | null) {
    const input = raw as { machineId?: unknown; label?: unknown; localToolPermission?: unknown };
    if (!input || typeof input.machineId !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.machineId) || typeof input.label !== "string" || !input.label.trim() || input.label.length > 200 || !["ask", "always", "never"].includes(String(input.localToolPermission))) throw new ApiError(400, "machine_identity_invalid", "Invalid desktop identity");
    if (!await this.sessionValid(authSessionId)) throw new ApiError(401, "unauthorized", "Sign in again to connect this computer");
    const credential = randomBytes(32).toString("base64url");
    await this.db.$transaction(async tx => {
      const existing = await tx.hostMachine.findUnique({ where: { machineId: input.machineId as string } });
      if (existing && (!existing.enabled || existing.transport !== "relay")) throw new ApiError(403, "machine_disabled", "This computer is disabled. Enable it in Connected computers before reconnecting.");
      const data = { label: (input.label as string).trim(), transport: "relay", credentialHash: hash(credential), authSessionId, localToolPermission: input.localToolPermission as string, lastSeenAt: null };
      await tx.hostMachine.upsert({ where: { machineId: input.machineId as string }, create: { machineId: input.machineId as string, ...data }, update: data });
    });
    this.relay.disconnect(input.machineId);
    return { machineId: input.machineId, credential };
  }

  async authenticate(request: Request) {
    const machineId = request.headers.get("x-openteam-machine-id") ?? "";
    const credential = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const row = machineId.length <= 128 ? await this.db.hostMachine.findUnique({ where: { machineId } }) : null;
    if (!row?.enabled || row.transport !== "relay" || !row.credentialHash || !credential || !timingSafeEqual(Buffer.from(hash(credential)), Buffer.from(row.credentialHash)) || !await this.sessionValid(row.authSessionId)) {
      throw new ApiError(401, "machine_unauthorized", "Computer enrollment is no longer authorized");
    }
    return row;
  }

  async assertRoutable(machineId: string) {
    const row = await this.db.hostMachine.findUnique({ where: { machineId } });
    if (!row?.enabled || row.transport !== "relay" || !await this.sessionValid(row.authSessionId)) throw new ApiError(403, "machine_unavailable", "This computer is not available");
  }

  async preferred(botId: string, channelId?: string) {
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(botId) || (channelId && !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(channelId))) throw new ApiError(400, "machine_context_invalid", "Invalid conversation context");
    const latest = await this.db.channelMessage.findFirst({
      where: { sender: "user", ...(channelId ? { channelId } : {}), channel: { archivedAt: null, members: { some: { botId } } } },
      orderBy: { sequence: "desc" }, select: { metadata: true },
    });
    const metadata = latest?.metadata as Record<string, unknown> | undefined;
    const machineId = typeof metadata?.sourceMachineId === "string" ? metadata.sourceMachineId : undefined;
    // Keep a disabled/offline choice so routing fails explicitly instead of
    // silently moving a private operation onto another computer.
    return { machineId: machineId && await this.db.hostMachine.findUnique({ where: { machineId }, select: { machineId: true } }) ? machineId : null };
  }

  async observe(raw: unknown) {
    const input = raw as { machineId?: unknown; connected?: unknown };
    if (typeof input?.machineId !== "string" || typeof input.connected !== "boolean") throw new ApiError(400, "machine_observation_invalid", "Invalid computer status");
    await this.db.hostMachine.updateMany({ where: { machineId: input.machineId, transport: "direct" }, data: { lastSeenAt: input.connected ? new Date() : null } });
    return { updated: true };
  }

  async heartbeat(machineId: string, raw: unknown) {
    const input = raw as { label?: unknown; localToolPermission?: unknown };
    if (typeof input?.label !== "string" || !input.label.trim() || input.label.length > 200 || !["ask", "always", "never"].includes(String(input.localToolPermission))) throw new ApiError(400, "machine_identity_invalid", "Invalid desktop status");
    await this.db.hostMachine.updateMany({ where: { machineId, enabled: true, transport: "relay" }, data: { label: input.label.trim(), localToolPermission: input.localToolPermission as string, lastSeenAt: new Date() } });
  }

  async revokeSession(authSessionId: string) {
    const rows = await this.db.hostMachine.findMany({ where: { authSessionId }, select: { machineId: true } });
    await this.db.hostMachine.updateMany({ where: { authSessionId }, data: { credentialHash: null, lastSeenAt: null } });
    for (const row of rows) this.relay.disconnect(row.machineId);
  }

  async setEnabled(machineId: string, enabled: boolean) {
    await this.db.hostMachine.update({ where: { machineId }, data: { enabled, ...(!enabled ? { credentialHash: null, lastSeenAt: null } : {}) } });
    if (!enabled) this.relay.disconnect(machineId);
    return { updated: true };
  }
  async remove(machineId: string) {
    const row = await this.db.hostMachine.findUnique({ where: { machineId } });
    if (row?.transport === "relay") await this.setEnabled(machineId, false);
    else await this.db.hostMachine.deleteMany({ where: { machineId } });
    this.relay.disconnect(machineId);
    return { removed: true };
  }
  async display() { return await this.db.computerDisplaySettings.findUnique({ where: { id: "global" } }) ?? { width: 1280, height: 800 }; }
  async saveDisplay(raw: unknown) {
    const value = raw as { width: number; height: number };
    if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 640 || value.width > 7680 || value.height < 480 || value.height > 4320) throw new ApiError(400, "invalid_display", "Choose a width of 640–7680 and height of 480–4320 pixels");
    return this.db.computerDisplaySettings.upsert({ where: { id: "global" }, create: { id: "global", width: value.width, height: value.height }, update: { width: value.width, height: value.height } });
  }
}
