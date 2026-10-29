import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import { HOST_BRIDGE_PATHS, parseHostMachinesResponse } from "@openteam/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openteam/db";
import { MachineRelay } from "../machine-relay";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Allowed recipients match the exact handle a send names; emails ignore case. */
export const messagesRecipientKey = (recipient: string) => recipient.includes("@") ? recipient.trim().toLowerCase() : recipient.trim();

export type MachineMessagesState = "ready" | "needs_permission" | "off" | "unavailable";
/** What tools and clients may see of a Mac's Messages state. */
const messagesView = (row: { messagesEnabled: boolean; messagesPermissions: unknown }) => {
  const permissions = row.messagesPermissions as { fullDiskAccess?: boolean; automation?: string; contacts?: string } | null;
  const messages: MachineMessagesState = !permissions ? "unavailable" : !row.messagesEnabled ? "off" : permissions.fullDiskAccess ? "ready" : "needs_permission";
  return { messages, messagesPermissions: permissions ? { fullDiskAccess: !!permissions.fullDiskAccess, automation: permissions.automation ?? "unknown", contacts: permissions.contacts ?? "unknown" } : null };
};
export class MachineService {
  constructor(private readonly db: PrismaClient, private readonly token: string, private readonly fetcher: typeof fetch = fetch, readonly relay = new MachineRelay(), private readonly authDisabled = false) {}

  async list(probe = false) {
    const rows = await this.db.hostMachine.findMany({ orderBy: { createdAt: "asc" } });
    return Promise.all(rows.map(async row => {
      let connected = row.transport === "relay" ? this.relay.connected(row.machineId) && await this.sessionValid(row.authSessionId) : false;
      if (row.enabled && row.transport === "direct" && probe && row.bridgeUrl) try {
        const machine = await this.probe(row.bridgeUrl);
        connected = machine.machineId === row.machineId;
        if (connected) Object.assign(row, await this.db.hostMachine.update({ where: { machineId: row.machineId }, data: { label: machine.label, lastSeenAt: new Date() } }));
      } catch { /* Offline machines remain in the roster. */ }
      else if (row.transport === "direct" && !probe) connected = !!(row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < 60_000);
      // Never return enrollment credentials or session identifiers to clients/tools.
      return { machineId: row.machineId, label: row.label, bridgeUrl: row.bridgeUrl, transport: row.transport, enabled: row.enabled, lastSeenAt: row.lastSeenAt, connected: row.enabled && connected, ...messagesView(row) };
    }));
  }

  /** The Mac a Messages tool runs on: the one named, else the user's latest source Mac, else the only ready one. */
  async messagesMachine(botId: string, channelId?: string, requested?: string) {
    if (requested !== undefined && (typeof requested !== "string" || requested.length > 128)) throw new ApiError(400, "machine_context_invalid", "Invalid machineId");
    const machines = (await this.list()).filter(machine => machine.transport === "relay");
    const usable = machines.filter(machine => machine.connected && machine.messages !== "off" && machine.messages !== "unavailable");
    const roster = () => machines.length
      ? ` Computers: ${machines.map(machine => `${machine.label} (${machine.machineId}): ${machine.connected ? `messages ${machine.messages}` : machine.enabled ? "offline" : "disabled"}`).join("; ")}.`
      : "";
    if (requested) {
      const machine = machines.find(row => row.machineId === requested);
      if (!machine) throw new ApiError(404, "messages_machine_unknown", `No computer has machineId ${requested}. Call ListMachines and use one of its machine IDs.${roster()}`);
      if (!machine.enabled) throw new ApiError(409, "messages_machine_disabled", `${machine.label} is disabled in Settings → Computer, so Messages can't be used there.${roster()}`);
      if (!machine.connected) throw new ApiError(409, "messages_machine_offline", `${machine.label} is offline: its OpenTeam desktop app must be open and the Mac awake.${roster()}`);
      if (machine.messages === "unavailable") throw new ApiError(409, "messages_machine_unsupported", `${machine.label} can't use Messages: it isn't a Mac, or its OpenTeam app needs an update.`);
      if (machine.messages === "off") throw new ApiError(409, "messages_machine_off", `Messages is turned off on ${machine.label}. Only the user can turn it on, in that Mac's OpenTeam Settings → Computer → Messages. Do not retry while it stays off.`);
      return { machineId: machine.machineId, label: machine.label };
    }
    const { machineId: preferred } = await this.preferred(botId, channelId);
    const chosen = usable.find(machine => machine.machineId === preferred) ?? (usable.length === 1 ? usable[0] : undefined);
    if (chosen) return { machineId: chosen.machineId, label: chosen.label };
    if (usable.length > 1) throw new ApiError(409, "messages_machine_ambiguous", `Messages is on for more than one connected Mac. Pass machineId to choose one, or ask the user which Mac to use.${roster()}`);
    if (machines.some(machine => machine.connected && machine.messages === "off")) throw new ApiError(409, "messages_machine_off", `Messages is turned off on every connected Mac. Only the user can turn it on, in that Mac's OpenTeam Settings → Computer → Messages. Do not retry while it stays off.${roster()}`);
    throw new ApiError(409, "messages_machine_offline", `No Mac with Messages turned on is connected: the OpenTeam desktop app must be open on a Mac that is awake and online.${roster()}`);
  }

  /** Grants a Mac reports; turning Messages on or off there withdraws every send permission. */
  private async reportMessages(machineId: string, raw: unknown) {
    const input = raw as Record<string, unknown> | undefined;
    const permissions = input && typeof input === "object" && !Array.isArray(input) && typeof input.enabled === "boolean"
      ? {
          fullDiskAccess: input.fullDiskAccess === true,
          automation: ["granted", "denied", "notAsked"].includes(input.automation as string) ? input.automation as string : "unknown",
          contacts: ["granted", "denied", "notAsked"].includes(input.contacts as string) ? input.contacts as string : "unknown",
        }
      : null;
    const enabled = permissions ? (input as { enabled: boolean }).enabled : false;
    await this.db.$transaction(async tx => {
      const row = await tx.hostMachine.findUnique({ where: { machineId }, select: { messagesEnabled: true } });
      if (!row) return;
      if (row.messagesEnabled !== enabled) {
        await tx.messagesAllowedRecipient.deleteMany({ where: { machineId } });
        await tx.hostMachine.update({ where: { machineId }, data: { messagesSendWithoutAsking: false } });
      }
      await tx.hostMachine.update({ where: { machineId }, data: { messagesEnabled: enabled, messagesPermissions: permissions ?? Prisma.DbNull } });
    });
  }

  async messagesSettings(machineId: string) {
    const row = await this.db.hostMachine.findUnique({ where: { machineId }, include: { messagesAllowedRecipients: { orderBy: { createdAt: "asc" } } } });
    if (!row) throw new ApiError(404, "machine_not_found", "Computer not found");
    return {
      machineId,
      sendWithoutAsking: row.messagesSendWithoutAsking,
      allowedRecipients: row.messagesAllowedRecipients.map(({ recipient, recipientName }) => ({ recipient, recipientName })),
    };
  }

  async updateMessagesSettings(machineId: string, raw: unknown) {
    const input = raw as { sendWithoutAsking?: unknown; removeRecipient?: unknown };
    if (!input || typeof input !== "object") throw new ApiError(400, "messages_settings_invalid", "Invalid Messages settings");
    const row = await this.db.hostMachine.findUnique({ where: { machineId }, select: { messagesEnabled: true } });
    if (!row) throw new ApiError(404, "machine_not_found", "Computer not found");
    if (typeof input.sendWithoutAsking === "boolean") {
      if (input.sendWithoutAsking && !row.messagesEnabled) throw new ApiError(409, "messages_off", "Turn on Messages on this Mac first");
      await this.db.hostMachine.update({ where: { machineId }, data: { messagesSendWithoutAsking: input.sendWithoutAsking } });
    }
    if (typeof input.removeRecipient === "string") await this.db.messagesAllowedRecipient.deleteMany({ where: { machineId, recipient: input.removeRecipient } });
    return this.messagesSettings(machineId);
  }

  /** Runs one desktop capability on a connected Mac through its relay channel. */
  async callCapability(machineId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    await this.assertRoutable(machineId);
    const response = await this.relay.forward(machineId, HOST_BRIDGE_PATHS.capabilities, new Request(`http://desktop${HOST_BRIDGE_PATHS.capabilities}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
    }));
    const value = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new ApiError(502, "machine_operation_failed", typeof value.error === "string" ? value.error : `The computer rejected the operation (${response.status})`);
    return value;
  }

  /** Whether a send from this Mac to this recipient skips the approval card. */
  async messagesSendAllowed(machineId: string, recipient: string | undefined) {
    const row = await this.db.hostMachine.findUnique({ where: { machineId }, select: { messagesEnabled: true, messagesSendWithoutAsking: true } });
    if (!row?.messagesEnabled) return false;
    if (row.messagesSendWithoutAsking) return true;
    return !!recipient && !!await this.db.messagesAllowedRecipient.findUnique({ where: { machineId_recipient: { machineId, recipient: messagesRecipientKey(recipient) } } });
  }

  async allowMessagesRecipient(machineId: string, recipient: string, recipientName?: string | null) {
    const row = await this.db.hostMachine.findUnique({ where: { machineId }, select: { messagesEnabled: true } });
    if (!row?.messagesEnabled) throw new ApiError(409, "messages_off", "Messages is turned off on this Mac");
    const key = messagesRecipientKey(recipient);
    await this.db.messagesAllowedRecipient.upsert({
      where: { machineId_recipient: { machineId, recipient: key } },
      create: { machineId, recipient: key, recipientName: recipientName ?? null },
      update: { recipientName: recipientName ?? undefined },
    });
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
    return this.db.hostMachine.upsert({ where: { machineId: machine.machineId }, create: { machineId: machine.machineId, label: machine.label, bridgeUrl: url.origin, lastSeenAt: new Date() }, update: { label: machine.label, lastSeenAt: new Date(), enabled: true } });
  }

  async enroll(raw: unknown, authSessionId: string | null) {
    const input = raw as { machineId?: unknown; label?: unknown };
    if (!input || typeof input.machineId !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.machineId) || typeof input.label !== "string" || !input.label.trim() || input.label.length > 200) throw new ApiError(400, "machine_identity_invalid", "Invalid desktop identity");
    if (!await this.sessionValid(authSessionId)) throw new ApiError(401, "unauthorized", "Sign in again to connect this computer");
    const credential = randomBytes(32).toString("base64url");
    await this.db.$transaction(async tx => {
      const existing = await tx.hostMachine.findUnique({ where: { machineId: input.machineId as string } });
      if (existing && (!existing.enabled || existing.transport !== "relay")) throw new ApiError(403, "machine_disabled", "This computer is disabled. Enable it in Connected computers before reconnecting.");
      const data = { label: (input.label as string).trim(), transport: "relay", credentialHash: hash(credential), authSessionId, lastSeenAt: null };
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
    const input = raw as { label?: unknown };
    if (typeof input?.label !== "string" || !input.label.trim() || input.label.length > 200) throw new ApiError(400, "machine_identity_invalid", "Invalid desktop status");
    const updated = await this.db.hostMachine.updateMany({ where: { machineId, enabled: true, transport: "relay" }, data: { label: input.label.trim(), lastSeenAt: new Date() } });
    if (updated.count) await this.reportMessages(machineId, (raw as { messages?: unknown }).messages);
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
  /** Forgets a computer. A desktop app that is still signed in there joins again as new. */
  async remove(machineId: string) {
    await this.db.hostMachine.deleteMany({ where: { machineId } });
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
