import { createHash } from "node:crypto";
import type { PrismaClient } from "@openteam/db";
import { effectiveToolPolicy, connectionNamespace } from "@openteam/plugin-sdk";
import {
  parseConnectorTransfer,
  CONNECTOR_TRANSFER_MAX_BYTES,
} from "@openteam/contracts/connector-transfers";
import { canonicalJson, toolSnapshot } from "./values";
import { toJson } from "../service-utils";
import { FileTransferProvider } from "./file-transfer-providers";
import type { PluginTransport } from "./transport";
const providers = new Set(["google-drive", "onedrive", "gmail"]);
interface Context {
  botId: string;
  runId: string;
  callId: string;
}
export class ConnectorFileTransfers {
  constructor(
    private readonly db: PrismaClient,
    private readonly token: PluginTransport["fileAccessToken"],
    private readonly provider = (token: string) => new FileTransferProvider(token)
  ) {}
  private async resolve(botId: string, connectionName: string, tool: string) {
    const connections = await this.db.pluginConnection.findMany({
      where: {
        installation: {
          status: "installed",
          mode: { not: "disabled" },
          enablements: { some: { botId, enabled: true } },
        },
        grants: { some: { botId, enabled: true } },
      },
      include: { installation: true, policies: { where: { OR: [{ botId }, { botId: null }] } } },
    });
    const available = connections.filter((c) => providers.has(c.installation.pluginKey));
    const matches = available.filter((c) =>
      [
        c.id,
        c.name,
        connectionNamespace(c.id),
        c.installation.pluginKey,
        `${c.installation.pluginKey} (account="${c.alias}")`,
      ].includes(connectionName)
    );
    if (matches.length !== 1)
      throw new Error(
        `Select one available file connection by ID: ${available.map((c) => `${c.name} account=${c.alias} id=${c.id}`).join(", ") || "none; connect Google Drive, OneDrive or Gmail"}`
      );
    const connection = matches[0]!;
    if (connection.status !== "ready")
      throw new Error("Authenticate this file connection before transferring files");
    // Respect both the unified action's policy and existing connector file policy.
    const policy = effectiveToolPolicy(
      connection.policies,
      tool,
      botId,
      tool === "upload_file" ? "prompt" : "allow"
    );
    const aliases =
      tool === "upload_file"
        ? ["create_file", "update_draft", "upload_file", "upload_drive_item"]
        : ["download_file_content", "get_message", "download_file", "get_drive_item"];
    const denied = toolSnapshot(connection.toolSnapshot).some(
      (t) =>
        aliases.includes(t.name) &&
        (() => {
          const p = effectiveToolPolicy(connection.policies, t.name, botId, t.defaultDecision);
          return !p.enabled || p.decision === "deny";
        })()
    );
    if (!policy.enabled || policy.decision === "deny" || denied)
      throw new Error("File transfer is denied by this account's tool policy");
    return { connection, decision: policy.decision };
  }
  async prepare(context: Context, raw: Record<string, any>) {
    const input = parseConnectorTransfer(raw.tool, raw.input);
    const { connection, decision } = await this.resolve(context.botId, input.connection, raw.tool);
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson({
          tool: raw.tool,
          input: { ...input, connection: connection.id },
          sha256: raw.sha256 ?? null,
          sizeBytes: raw.sizeBytes ?? null,
        })
      )
      .digest("hex");
    const previous = await this.db.connectorFileTransfer.findUnique({
      where: { callId: context.callId },
    });
    if (
      previous &&
      (previous.fingerprint !== fingerprint ||
        previous.runId !== context.runId ||
        previous.botId !== context.botId)
    )
      throw new Error("Transfer call ID cannot be reused for a different operation");
    if (!previous)
      await this.db.connectorFileTransfer.create({
        data: {
          callId: context.callId,
          runId: context.runId,
          botId: context.botId,
          connectionId: connection.id,
          tool: raw.tool,
          fingerprint,
          status: "prepared",
        },
      });
    return {
      connectionId: connection.id,
      connectionName: connection.name,
      provider: connection.installation.pluginKey,
      decision,
      fingerprint,
      status: previous?.status ?? "prepared",
      ...(previous?.status === "completed" ? { result: previous.result } : {}),
    };
  }
  async execute(context: Context, raw: Record<string, any>, signal?: AbortSignal) {
    const input = parseConnectorTransfer(raw.tool, raw.input);
    const { connection, decision } = await this.resolve(context.botId, input.connection, raw.tool);
    const record = await this.db.connectorFileTransfer.findUnique({
      where: { callId: context.callId },
    });
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson({
          tool: raw.tool,
          input: { ...input, connection: connection.id },
          sha256: raw.sha256 ?? null,
          sizeBytes: raw.sizeBytes ?? null,
        })
      )
      .digest("hex");
    if (
      !record ||
      record.fingerprint !== fingerprint ||
      record.runId !== context.runId ||
      record.botId !== context.botId ||
      record.connectionId !== connection.id
    )
      throw new Error("Transfer was not prepared for this exact account and file");
    if (record.status === "completed" && raw.tool === "upload_file") return record.result;
    if (decision === "prompt" && raw.reviewed !== true)
      throw new Error("This transfer needs user approval");
    if (
      raw.tool === "upload_file" &&
      (!raw.sha256 ||
        !Number.isSafeInteger(raw.sizeBytes) ||
        raw.sizeBytes < 0 ||
        raw.sizeBytes > CONNECTOR_TRANSFER_MAX_BYTES ||
        typeof raw.bytesBase64 !== "string" ||
        raw.bytesBase64.length > Math.ceil(CONNECTOR_TRANSFER_MAX_BYTES / 3) * 4)
    )
      throw new Error("Invalid upload staging envelope");
    const bytes = raw.tool === "upload_file" ? Buffer.from(raw.bytesBase64, "base64") : undefined;
    if (
      bytes &&
      (bytes.length !== raw.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== raw.sha256)
    )
      throw new Error("Staged file bytes changed after review");
    const claim = await this.db.connectorFileTransfer.updateMany({
      where: {
        callId: context.callId,
        status: {
          in: raw.tool === "download_file" ? ["prepared", "completed", "failed"] : ["prepared"],
        },
      },
      data: { status: "running" },
    });
    if (!claim.count)
      throw new Error(
        "Transfer is already running or its write outcome is uncertain; inspect the destination before retrying"
      );
    try {
      const api = this.provider(await this.token(connection));
      const upload = () =>
        api.upload(
          connection.installation.pluginKey,
          input.sourcePath,
          input.destination,
          bytes!,
          signal
        );
      const result =
        raw.tool === "upload_file"
          ? connection.installation.pluginKey === "gmail"
            ? await this.db.$transaction(
                async (tx) => {
                  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gmail-draft:${connection.id}:${input.destination.draftId}`}, 0))`;
                  signal?.throwIfAborted();
                  return upload();
                },
                { maxWait: 130_000, timeout: 130_000 }
              )
            : await upload()
          : await api.download(connection.installation.pluginKey, input.source, signal);
      const { bytes: downloaded, ...metadata } = result as Record<string, any>;
      await this.db.connectorFileTransfer.update({
        where: { callId: context.callId },
        data: {
          status: "completed",
          result: toJson({ ...metadata, ...(downloaded ? { sizeBytes: downloaded.length } : {}) }),
        },
      });
      return {
        ...metadata,
        ...(downloaded
          ? { bytesBase64: downloaded.toString("base64"), sizeBytes: downloaded.length }
          : {}),
      };
    } catch (error) {
      await this.db.connectorFileTransfer.update({
        where: { callId: context.callId },
        data: { status: "failed" },
      });
      throw error;
    }
  }
}
