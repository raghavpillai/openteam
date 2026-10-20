import { test, expect } from "bun:test";
import {
  FileTransferProvider,
  appendDraftAttachment,
} from "../../src/services/plugin/file-transfer-providers";
import { CONNECTOR_TRANSFER_TOOLS, parseConnectorTransfer } from "@openteam/contracts/connector-transfers";

test("retired file providers cannot issue requests and are absent from tool guidance", async () => {
  const provider = new FileTransferProvider("fixture", (async (_url: any, _init?: RequestInit): Promise<Response> => {
    throw new Error("Unexpected provider request");
  }) as typeof fetch);
  await expect(provider.download("onedrive", { fileId: "file" })).rejects.toThrow("Connection cannot transfer files");
  await expect(provider.upload("onedrive", "file.txt", {}, Buffer.from("fixture"))).rejects.toThrow("Connection cannot receive files");
  for (const tool of CONNECTOR_TRANSFER_TOOLS) {
    expect(JSON.stringify(tool)).not.toMatch(/onedrive|sharepoint|outlook|send_draft|send_message|update_draft|read_email/i);
    expect(tool.description).toContain("The service short name (google-drive or gmail)");
  }
  // Gmail drafts only carry the file; the Gmail connection has no send tool.
  expect(CONNECTOR_TRANSFER_TOOLS.find(t => t.name === "UploadFile")!.description).toContain("the draft waits unsent in the user's Gmail Drafts");
  expect(CONNECTOR_TRANSFER_TOOLS.find(t => t.name === "DownloadFile")!.inputSchema.properties.source.required).toEqual(["fileId"]);
  expect(() => parseConnectorTransfer("DownloadFile", { connection: "drive", source: { path: "file.txt" } })).toThrow("source.fileId");
  expect(() => parseConnectorTransfer("UploadFile", { connection: "drive", sourcePath: "/workspace/file.txt", destination: { overwrite: true } })).toThrow("destination.overwrite");
});

test("Drive export preserves native document bytes and upload uses an authenticated resumable session", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: any, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-oauth");
    if (String(url).includes("/export?")) return new Response(new Uint8Array([0, 1, 254, 255]));
    if (init.method === "PUT") {
      expect([...new Uint8Array(init.body as any)]).toEqual([0, 1, 254, 255]);
      return Response.json({ id: "uploaded", name: "report.docx" });
    }
    if (String(url).includes("/upload/"))
      return new Response(null, {
        headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture" },
      });
    return Response.json({
      id: "native",
      name: "report",
      mimeType: "application/vnd.google-apps.document",
    });
  }) as typeof fetch;
  const provider = new FileTransferProvider("synthetic-oauth", fetcher);
  const download = await provider.download("google-drive", { fileId: "native" });
  expect(download.name).toBe("report.docx");
  expect([...download.bytes]).toEqual([0, 1, 254, 255]);
  expect(await provider.upload("google-drive", download.name, {}, download.bytes)).toMatchObject({
    id: "uploaded",
    sizeBytes: 4,
  });
  expect(
    calls.some((c) =>
      c.url.includes(
        encodeURIComponent(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
      )
    )
  ).toBe(true);
});

test("Gmail attaches to an existing draft without losing MIME parts or sending mail; attachment reads return the bytes", async () => {
  const old = Buffer.from(
    'To: fixture@example.test\r\nSubject: Fixture\r\nContent-Type: multipart/mixed; boundary="old"\r\n\r\n--old\r\nContent-Type: text/plain\r\n\r\nBody\r\n--old\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nb2xkLWZpbGU=\r\n--old--\r\n'
  );
  const combined = appendDraftAttachment(
    old,
    "résumé.pdf",
    "application/pdf",
    Buffer.from("new-file")
  ).toString();
  expect(combined).toContain("b2xkLWZpbGU=");
  expect(combined).toContain("bmV3LWZpbGU=");
  expect(combined).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  let writes = 0;
  const provider = new FileTransferProvider("fixture", (async (
    url: any,
    init: RequestInit = {}
  ) => {
    const u = String(url);
    expect(u).not.toContain("/send");
    if (init.method === "PUT") {
      writes++;
      expect(JSON.parse(String(init.body)).message.threadId).toBe("thread");
      return Response.json({ id: "draft" });
    }
    if (u.includes("/drafts/"))
      return Response.json({
        id: "draft",
        message: { raw: old.toString("base64url"), threadId: "thread" },
      });
    if (u.includes("/attachments/"))
      return Response.json({ data: Buffer.from("binary\0attachment").toString("base64url") });
    return Response.json({
      payload: {
        parts: [
          {
            filename: "file.bin",
            mimeType: "application/octet-stream",
            body: { attachmentId: "a", size: 17 },
          },
        ],
      },
    });
  }) as typeof fetch);
  expect(
    await provider.upload("gmail", "new.pdf", { draftId: "draft" }, Buffer.from("new-file"))
  ).toMatchObject({ id: "draft", draftId: "draft" });
  expect(writes).toBe(1);
  expect((await provider.download("gmail", { fileId: "m/a" })).bytes).toEqual(
    Buffer.from("binary\0attachment")
  );
});

test("Gmail downloads an attachment by an ID from an earlier message read", async () => {
  // Real Gmail returns new attachment IDs on every message read, keeps older
  // IDs valid, and serves an attachment whatever message is in the path.
  const files: Record<string, Buffer> = {
    "quote.pdf": Buffer.from("%PDF quote"),
    "logo.png": Buffer.from("png-1"),
    "icon.png": Buffer.from("png-2"),
    "other.txt": Buffer.from("from another message"),
  };
  const issued = new Map<string, string>();
  let reads = 0;
  const provider = new FileTransferProvider("fixture", (async (url: any) => {
    const u = String(url);
    const attachment = u.match(/\/attachments\/([^/?]+)/)?.[1];
    if (attachment) {
      const name = issued.get(decodeURIComponent(attachment));
      return name
        ? Response.json({ data: files[name]!.toString("base64url"), size: files[name]!.length })
        : Response.json({ error: { code: 400 } }, { status: 400 });
    }
    reads++;
    const part = (filename: string) => {
      const id = `${filename}#${reads}`;
      issued.set(id, filename);
      return { filename, mimeType: "application/octet-stream", body: { attachmentId: id, size: files[filename]!.length } };
    };
    return Response.json({ payload: { parts: [part("quote.pdf"), part("logo.png"), part("icon.png")] } });
  }) as typeof fetch);
  issued.set("other#0", "other.txt");
  await provider.download("gmail", { fileId: "m/x" }).catch(() => {});
  for (const name of ["quote.pdf", "icon.png"]) {
    const earlier = [...issued].find(([id, file]) => file === name && id.endsWith("#1"))![0];
    const result = await provider.download("gmail", { fileId: `m/${earlier}` });
    expect(result).toMatchObject({ name, bytes: files[name] });
  }
  await expect(provider.download("gmail", { fileId: "m/other#0" })).rejects.toThrow("does not belong");
  await expect(provider.download("gmail", { fileId: "m/never-issued" })).rejects.toThrow("does not belong");
});

test("file contracts reject destination ambiguity and unsafe filename shapes", () => {
  for (const args of [
    { connection: "x", sourcePath: "/workspace/a", destination: { path: "a", folderId: "b" } },
    { connection: "x", sourcePath: "/workspace/a", destination: { name: "../a" } },
  ])
    expect(() => parseConnectorTransfer("UploadFile", args)).toThrow();
  expect(() =>
    parseConnectorTransfer("DownloadFile", { connection: "x", source: { fileId: "a", path: "b" } })
  ).toThrow();
});

test("Drive imports an Office file as a native Google file only when the upload asks for it", async () => {
  const pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const starts: Array<{ metadata: any; contentType: string | null }> = [];
  const fetcher = (async (url: any, init: RequestInit = {}) => {
    if (String(url).includes("uploadType=resumable")) {
      starts.push({ metadata: JSON.parse(String(init.body)), contentType: new Headers(init.headers).get("x-upload-content-type") });
      return new Response(null, { headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture" } });
    }
    expect(new Headers(init.headers).get("content-type")).toBe(pptx);
    const converted = starts.at(-1)!.metadata.mimeType;
    return Response.json({ id: "deck", name: "Q3 review.pptx", mimeType: converted, webViewLink: "https://docs.google.com/presentation/d/deck" });
  }) as typeof fetch;
  const provider = new FileTransferProvider("synthetic-oauth", fetcher);
  const bytes = Buffer.from("pptx-bytes");

  expect(await provider.upload("google-drive", "Q3 review.pptx", { convertToGoogleFormat: true }, bytes)).toMatchObject({
    mimeType: "application/vnd.google-apps.presentation",
  });
  expect(await provider.upload("google-drive", "Q3 review.pptx", {}, bytes)).toMatchObject({ mimeType: pptx });
  // A destination name without an extension still converts from the source file's type.
  expect(
    await provider.upload("google-drive", "/workspace/slides/deck/q3.pptx", { name: "Q3 review", convertToGoogleFormat: true }, bytes)
  ).toMatchObject({ mimeType: "application/vnd.google-apps.presentation" });
  expect(starts.map((start) => [start.metadata.name, start.metadata.mimeType, start.contentType])).toEqual([
    ["Q3 review.pptx", "application/vnd.google-apps.presentation", pptx],
    ["Q3 review.pptx", pptx, pptx],
    ["Q3 review", "application/vnd.google-apps.presentation", pptx],
  ]);

  const contract = CONNECTOR_TRANSFER_TOOLS.find((tool) => tool.name === "UploadFile")!;
  expect(contract.inputSchema.properties.destination.properties.convertToGoogleFormat.type).toBe("boolean");
  expect(contract.description).toContain("destination.convertToGoogleFormat, when true, asks Drive to import");
  expect(
    parseConnectorTransfer("UploadFile", {
      connection: "google-drive",
      sourcePath: "/workspace/deck.pptx",
      destination: { convertToGoogleFormat: true },
    }).destination
  ).toEqual({ convertToGoogleFormat: true });
});
