import { spoolFile, type StagedFile } from "@openteam/plugin-sdk/file-spool";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@openteam/db";
import { fileTransferPolicy, connectionNamespace } from "@openteam/plugin-sdk";
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
        connectionNamespace(c.id,c.alias),
        c.installation.pluginKey,
        `${c.installation.pluginKey} (account="${c.alias}")`,
      ].includes(connectionName)
    );
    if (matches.length !== 1)
      throw Object.assign(new Error(
        `Select one available file connection by ID: ${available.map((c) => `${c.name} account=${c.alias} id=${c.id}`).join(", ") || "none; connect Google Drive, OneDrive or Gmail"}`
      ), {outcome:{kind:"unknown_connection",available:available.map(c=>`${c.installation.pluginKey} (account="${c.alias}")`)}});
    const connection = matches[0]!;
    if (connection.status !== "ready")
      throw Object.assign(new Error("Authenticate this file connection before transferring files"),{outcome:{kind:"needs_auth"}});
    // Respect both the unified action's policy and existing connector file policy.
    const policy = fileTransferPolicy(connection.policies, toolSnapshot(connection.toolSnapshot), botId, tool as "upload_file" | "download_file");
    if (!policy.enabled)
      throw Object.assign(new Error("File transfer is denied by this account's tool policy"), {outcome:{kind:"rejected",message:"This account's file policy denies the transfer."}});
    return { connection, decision: policy.decision };
  }
  async prepare(context: Context, raw: Record<string, any>) {
    const input = parseConnectorTransfer(raw.tool, raw.input);
    let resolved: Awaited<ReturnType<ConnectorFileTransfers["resolve"]>>;
    try { resolved=await this.resolve(context.botId,input.connection,raw.tool); }
    catch(error) { if((error as any).outcome)return {outcome:(error as any).outcome}; throw error; }
    const {connection,decision}=resolved;
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
  async execute(context: Context, raw: Record<string, any>, signal?: AbortSignal, transfer: {upload?:StagedFile;stream?:boolean} = {}) {
    const input = parseConnectorTransfer(raw.tool, raw.input);
    let resolved: Awaited<ReturnType<ConnectorFileTransfers["resolve"]>>;
    try { resolved = await this.resolve(context.botId, input.connection, raw.tool); }
    catch (error) { if ((error as any).outcome) return {outcome:(error as any).outcome}; throw error; }
    const { connection, decision } = resolved;
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
      raw.tool === "upload_file" && !transfer.upload &&
      (!raw.sha256 ||
        !Number.isSafeInteger(raw.sizeBytes) ||
        raw.sizeBytes < 0 ||
        raw.sizeBytes > CONNECTOR_TRANSFER_MAX_BYTES ||
        typeof raw.bytesBase64 !== "string" ||
        raw.bytesBase64.length > Math.ceil(CONNECTOR_TRANSFER_MAX_BYTES / 3) * 4)
    )
      throw new Error("Invalid upload staging envelope");
    const bytes = transfer.upload ? Bun.file(transfer.upload.path) : raw.tool === "upload_file" ? Buffer.from(raw.bytesBase64, "base64") : undefined;
    if (transfer.upload && (transfer.upload.sizeBytes !== raw.sizeBytes || transfer.upload.sha256 !== raw.sha256)) throw new Error("Staged file bytes changed after review");
    if (
      Buffer.isBuffer(bytes) &&
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
    let stagedDownload: StagedFile | undefined;
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
          : transfer.stream ? await api.downloadStream(connection.installation.pluginKey, input.source, signal) : await api.download(connection.installation.pluginKey, input.source, signal);
      const { bytes: downloaded, stream, ...metadata } = result as Record<string, any>;
      const file = stagedDownload = stream ? await spoolFile(stream,{signal}) : undefined;
      if (file) metadata.sizeBytes=file.sizeBytes;
      await this.db.connectorFileTransfer.update({
        where: { callId: context.callId },
        data: {
          status: "completed",
          result: toJson({ ...metadata, ...(downloaded ? { sizeBytes: downloaded.length } : {}) }),
        },
      });
      return {
        ...metadata,
        ...(file ? {file} : {}),
        ...(downloaded
          ? { bytesBase64: downloaded.toString("base64"), sizeBytes: downloaded.length }
          : {}),
      };
    } catch (error) {
      await stagedDownload?.cleanup();
      await this.db.connectorFileTransfer.update({
        where: { callId: context.callId },
        data: { status: "failed" },
      });
      signal?.throwIfAborted();
      if ((error as any).outcome) return {outcome:(error as any).outcome};
      const status = (error as any).status;
      if (status === 401) return {outcome:{kind:"needs_auth"}};
      if (status === 404) return {outcome:{kind:raw.tool === "download_file" ? "not_found" : "invalid_destination",message:"The selected file or destination was not found in this account."}};
      if (status >= 400 && status < 500) return {outcome:{kind:"rejected",message:`The provider rejected the request (HTTP ${status}). Check this account's access and the destination.`}};
      // A dropped response can follow a successful write. Never turn an uncertain
      // upload into the reference's "nothing uploaded; retry" message.
      return {outcome:{kind:raw.tool === "upload_file" ? "uncertain" : "unavailable",message:raw.tool === "upload_file"
        ? "The provider did not confirm the upload. It may have succeeded; inspect the destination before retrying. This call will not replay the write."
        : "The file provider could not complete the download."}};
    }
  }
}
