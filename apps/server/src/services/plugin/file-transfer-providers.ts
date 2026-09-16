import { CONNECTOR_TRANSFER_MAX_BYTES } from "@openteam/contracts/connector-transfers";
import { basename, extname } from "node:path";
const part = encodeURIComponent;
const transferError = (kind: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), {outcome:{kind,message,...extra}});
const drive = "https://www.googleapis.com/drive/v3";
const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
const graph = "https://graph.microsoft.com/v1.0/me/drive";
const exports: Record<string, [string, string]> = {
  "application/vnd.google-apps.document": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  "application/vnd.google-apps.spreadsheet": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  "application/vnd.google-apps.presentation": [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptx",
  ],
  "application/vnd.google-apps.drawing": ["image/png", ".png"],
};
export function appendDraftAttachment(
  raw: Buffer,
  name: string,
  mime: string,
  bytes: Buffer
): Buffer {
  if (
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ \t]*charset=[A-Za-z0-9_-]+)?$/.test(mime)
  )
    throw new Error("Invalid attachment content type");
  const text = raw.toString("utf8").replace(/\r?\n/g, "\r\n");
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("Draft has invalid MIME headers");
  const headers = text.slice(0, split).split(/\r\n(?![ \t])/);
  const body = text.slice(split + 4);
  const boundary = `openteam-${crypto.randomUUID()}`;
  const contentHeaders = headers.filter((h) => /^content-/i.test(h));
  const messageHeaders = headers.filter((h) => !/^content-|^mime-version:/i.test(h));
  const encodedName = encodeURIComponent(name).replace(/'/g, "%27");
  const attachment =
    bytes
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "";
  return Buffer.from(
    [
      ...messageHeaders,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...contentHeaders,
      "",
      body,
      `--${boundary}`,
      `Content-Type: ${mime}`,
      `Content-Disposition: attachment; filename*=UTF-8''${encodedName}`,
      "Content-Transfer-Encoding: base64",
      "",
      attachment,
      `--${boundary}--`,
      "",
    ].join("\r\n")
  );
}
const mimeFor = (name: string) =>
  ({
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".docx": exports["application/vnd.google-apps.document"]![0],
    ".xlsx": exports["application/vnd.google-apps.spreadsheet"]![0],
    ".pptx": exports["application/vnd.google-apps.presentation"]![0],
  })[extname(name).toLowerCase()] ?? "application/octet-stream";
export class FileTransferProvider {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  private async response(
    url: string,
    init: RequestInit = {},
    authenticated = true,
    allowIncomplete = false
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(120_000),
        redirect: "manual",
      });
    } catch {
      throw new Error(
        "File provider connection failed or was cancelled; no automatic write retry was attempted"
      );
    }
    if (!response.ok && !(allowIncomplete && response.status === 308))
      throw Object.assign(new Error(`File provider request failed (${response.status}); no automatic write retry was attempted`), {status:response.status});
    return response;
  }
  private async json(url: string, init: RequestInit = {}): Promise<any> {
    const bytes = await this.bytes(
      await this.response(url, init),
      Math.ceil((CONNECTOR_TRANSFER_MAX_BYTES * 4) / 3) + 1024 * 1024
    );
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("File provider returned invalid JSON");
    }
  }
  private async bytes(response: Response, limit = CONNECTOR_TRANSFER_MAX_BYTES): Promise<Buffer> {
    if (Number(response.headers.get("content-length")) > limit)
      throw new Error("Provider response exceeds transfer limit");
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error("Provider response exceeds transfer limit");
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async download(
    provider: string,
    source: { fileId?: string; path?: string },
    signal?: AbortSignal
  ): Promise<{ id: string; name: string; mimeType: string; bytes: Buffer; webUrl?: string }> {
    const result = await this.downloadStream(provider,source,signal);
    return {...result,bytes:await this.bytes(new Response(result.stream))};
  }
  async downloadStream(provider:string,source:{fileId?:string;path?:string},signal?:AbortSignal): Promise<{id:string;name:string;mimeType:string;stream:ReadableStream<Uint8Array>;webUrl?:string}> {
    if (provider === "google-drive") {
      if (!source.fileId) throw transferError("rejected", "Drive requires source.fileId");
      const id = source.fileId;
      const file = await this.json(
        `${drive}/files/${part(id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
        { signal }
      );
      const native = exports[file.mimeType];
      if (file.mimeType?.startsWith("application/vnd.google-apps.") && !native)
        throw transferError("rejected", "This Google native file type cannot be exported");
      const url = native
        ? `${drive}/files/${part(id)}/export?mimeType=${part(native[0])}`
        : `${drive}/files/${part(id)}?alt=media&supportsAllDrives=true`;
      return {
        id,
        name: file.name + (native && !file.name.endsWith(native[1]) ? native[1] : ""),
        mimeType: native?.[0] ?? file.mimeType,
        stream: (await this.response(url, {signal})).body ?? new ReadableStream({start(c){c.close();}}),
        webUrl: file.webViewLink,
      };
    }
    if (provider === "onedrive") {
      const route = source.fileId
        ? `/items/${part(source.fileId)}`
        : `/root:/${this.providerPath(source.path ?? "")}:`;
      const file = await this.json(
        `${graph}${route}?$select=id,name,size,file,webUrl,@microsoft.graph.downloadUrl`,
        { signal }
      );
      if (!file.file) throw transferError("not_found", "Source is not a file");
      const url = new URL(file["@microsoft.graph.downloadUrl"]);
      // Download URLs are short-lived bearer URLs from authenticated Graph metadata.
      if (url.protocol !== "https:" || url.username || url.password || url.port)
        throw new Error("Invalid OneDrive download URL");
      return {
        id: file.id,
        name: file.name,
        mimeType: file.file.mimeType ?? mimeFor(file.name),
        stream: (await this.response(url.href, {signal}, false)).body ?? new ReadableStream({start(c){c.close();}}),
        webUrl: file.webUrl,
      };
    }
    if (provider === "gmail") {
      const ids = source.fileId?.split("/");
      if (ids?.length !== 2 || !ids[0] || !ids[1])
        throw transferError("rejected", "Gmail fileId must be messageId/attachmentId");
      const message = await this.json(`${gmail}/messages/${part(ids[0])}?format=full`, { signal });
      const visit = (p: any): any =>
        p.body?.attachmentId === ids[1] ? p : (p.parts ?? []).map(visit).find(Boolean);
      const attachment = visit(message.payload ?? {});
      if (!attachment) throw transferError("not_found", "Attachment does not belong to this message");
      if (Number(attachment.body.size) > CONNECTOR_TRANSFER_MAX_BYTES)
        throw transferError("too_large", "Attachment exceeds 64 MiB", {maxBytes:CONNECTOR_TRANSFER_MAX_BYTES});
      const data = await this.json(
        `${gmail}/messages/${part(ids[0])}/attachments/${part(ids[1])}`,
        { signal }
      );
      const bytes = Buffer.from(data.data, "base64url");
      if (bytes.length > CONNECTOR_TRANSFER_MAX_BYTES) throw transferError("too_large", "Attachment exceeds 64 MiB", {maxBytes:CONNECTOR_TRANSFER_MAX_BYTES});
      return {
        id: source.fileId!,
        name: attachment.filename || `attachment-${ids[1]}`,
        mimeType: attachment.mimeType ?? "application/octet-stream",
        stream: new Response(new Uint8Array(bytes)).body!,
      };
    }
    throw new Error("Connection cannot transfer files");
  }
  private providerPath(path: string) {
    if (!path || path.split("/").some((p) => !p || p === "." || p === ".." || p.includes("\\")))
      throw new Error("Use a root-relative provider path without traversal");
    return path.split("/").map(part).join("/");
  }
  async upload(
    provider: string,
    sourceName: string,
    destination: Record<string, any>,
    bytes: Buffer | Blob,
    signal?: AbortSignal
  ): Promise<Record<string, any>> {
    const size = Buffer.isBuffer(bytes) ? bytes.length : bytes.size;
    const chunk = async (start:number,end:number) => Buffer.isBuffer(bytes) ? new Uint8Array(bytes.subarray(start,end)) : new Uint8Array(await bytes.slice(start,end).arrayBuffer());
    const name = destination.name ?? basename(sourceName);
    const mimeType = mimeFor(name);
    if (provider === "gmail") {
      if (size > 25 * 1024 * 1024) throw transferError("too_large", "Draft with attachments exceeds 25 MiB", {maxBytes:25 * 1024 * 1024});
      if (
        !destination.draftId ||
        destination.path ||
        destination.folderId ||
        destination.overwrite !== undefined
      )
        throw transferError("invalid_destination", "Gmail requires only draftId and optional name");
      const draft = await this.json(`${gmail}/drafts/${part(destination.draftId)}?format=raw`, {
        signal,
      });
      const raw = appendDraftAttachment(
        Buffer.from(draft.message.raw, "base64url"),
        name,
        mimeType,
        Buffer.from(await chunk(0,size))
      );
      if (raw.length > 25 * 1024 * 1024) throw transferError("too_large", "Draft with attachments exceeds 25 MiB", {maxBytes:25 * 1024 * 1024});
      const latest = await this.json(`${gmail}/drafts/${part(destination.draftId)}?format=raw`, {
        signal,
      });
      if (latest.message?.id !== draft.message?.id || latest.message?.raw !== draft.message?.raw)
        throw transferError("rejected", "Draft changed while adding the attachment; reopen it before retrying");
      const result = await this.json(`${gmail}/drafts/${part(destination.draftId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: destination.draftId,
          message: { raw: raw.toString("base64url"), threadId: draft.message.threadId },
        }),
        signal,
      });
      return { id: result.id, name, mimeType, sizeBytes: size, draftId: result.id };
    }
    if (destination.draftId) throw transferError("invalid_destination", "draftId only applies to Gmail");
    if (provider === "google-drive") {
      if (destination.overwrite !== undefined)
        throw transferError("invalid_destination", "Drive always creates a new file; overwrite is only for OneDrive");
      let parent = destination.folderId ?? "root";
      if (destination.path) {
        for (const segment of destination.path.split("/")) {
          if (!segment || [".", ".."].includes(segment))
            throw transferError("invalid_destination", "Invalid Drive folder path");
          const escape = (x: string) => x.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
          const query = `'${escape(parent)}' in parents and name = '${escape(segment)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
          const folders = await this.json(
            `${drive}/files?q=${part(query)}&fields=files(id),nextPageToken&pageSize=2&supportsAllDrives=true&includeItemsFromAllDrives=true`,
            { signal }
          );
          if (folders.files?.length !== 1 || folders.nextPageToken)
            throw transferError("invalid_destination", "Drive folder is missing or ambiguous");
          parent = folders.files[0].id;
        }
      }
      const start = await this.response(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-upload-content-type": mimeType,
            "x-upload-content-length": String(size),
          },
          body: JSON.stringify({ name, mimeType, parents: [parent] }),
          signal,
        }
      );
      const location = new URL(start.headers.get("location") ?? "");
      if (
        location.origin !== "https://www.googleapis.com" ||
        !location.pathname.startsWith("/upload/drive/")
      )
        throw new Error("Invalid Drive upload session");
      let file: any;
      const block = 8 * 1024 * 1024; // Multiple of Drive's 256 KiB fragment unit.
      for (let offset = 0; offset < Math.max(size,1); offset += block) {
        const end = Math.min(size,offset+block);
        const response = await this.response(location.href, {
          method:"PUT",headers:{"content-type":mimeType,"content-range":size ? `bytes ${offset}-${end-1}/${size}` : "bytes */0"},
          body:await chunk(offset,end),signal,
        },true,true);
        if (response.status === 308) {
          if (end === size || response.headers.get("range") !== `bytes=0-${end-1}`) throw new Error("Drive did not confirm the uploaded range; inspect the destination before retrying");
        } else { file=await response.json(); if(end!==size)throw new Error("Drive completed before receiving the full file"); }
      }
      if(!file?.id)throw new Error("Drive did not confirm completion; inspect the destination before retrying");
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType ?? mimeType,
        sizeBytes: size,
        webUrl: file.webViewLink,
      };
    }
    if (provider === "onedrive") {
      const folderRoute = destination.folderId
        ? `/items/${part(destination.folderId)}`
        : destination.path
          ? `/root:/${this.providerPath(destination.path)}:`
          : "/root";
      const folder = await this.json(`${graph}${folderRoute}?$select=id,folder`, { signal });
      if (!folder.folder || !folder.id) throw transferError("invalid_destination", "OneDrive destination is not a folder");
      const parent = `/items/${part(folder.id)}`;
      if (!size) {
        const file = await this.json(
          `${graph}${parent}:/${part(name)}:/content?@microsoft.graph.conflictBehavior=${destination.overwrite ? "replace" : "fail"}`,
          {
            method: "PUT",
            headers: {
              "content-type": mimeType,
              ...(!destination.overwrite ? { "if-none-match": "*" } : {}),
            },
            body: new Uint8Array(),
            signal,
          }
        );
        return { id: file.id, name: file.name, mimeType, sizeBytes: 0, webUrl: file.webUrl };
      }
      const session = await this.json(`${graph}${parent}:/${part(name)}:/createUploadSession`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          item: {
            name,
            "@microsoft.graph.conflictBehavior": destination.overwrite ? "replace" : "fail",
          },
        }),
        signal,
      });
      const url = new URL(session.uploadUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password)
        throw new Error("Invalid OneDrive upload URL");
      // Graph fragment sizes must be multiples of 320 KiB except the last fragment.
      const block = 10 * 320 * 1024;
      let result: any;
      for (let offset = 0; offset < size; offset += block) {
        const end = Math.min(size, offset + block);
        const response = await this.response(
          url.href,
          {
            method: "PUT",
            headers: { "content-range": `bytes ${offset}-${end - 1}/${size}` },
            body: await chunk(offset,end),
            signal,
          },
          false
        );
        result = await response.json();
      }
      if (!result?.id)
        throw new Error(
          "OneDrive did not confirm completion; inspect the destination before retrying"
        );
      return {
        id: result.id,
        name: result.name,
        mimeType: result.file?.mimeType ?? mimeType,
        sizeBytes: size,
        webUrl: result.webUrl,
      };
    }
    throw new Error("Connection cannot receive files");
  }
}
