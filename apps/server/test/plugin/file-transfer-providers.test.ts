import { test, expect } from "bun:test";
import {
  FileTransferProvider,
  appendDraftAttachment,
} from "../../src/services/plugin/file-transfer-providers";
import { parseConnectorTransfer } from "@openteam/contracts/connector-transfers";

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

test("OneDrive pins folder IDs, uses ordered 320-KiB fragments, and does not forward OAuth to preauthenticated endpoints", async () => {
  const bytes = Buffer.alloc(10 * 320 * 1024 + 3, 73);
  const ranges: string[] = [];
  const provider = new FileTransferProvider("fixture-token", (async (
    url: any,
    init: RequestInit = {}
  ) => {
    const u = String(url);
    const headers = new Headers(init.headers);
    if (u.startsWith("https://storage.example.test/")) {
      expect(headers.has("authorization")).toBe(false);
      ranges.push(headers.get("content-range")!);
      return Response.json(
        ranges.length === 1
          ? { nextExpectedRanges: [`${10 * 320 * 1024}-`] }
          : { id: "done", name: "file.bin" }
      );
    }
    expect(headers.get("authorization")).toBe("Bearer fixture-token");
    if (u.includes("createUploadSession")) {
      expect(u).toContain("/items/folder-id:/file.bin:/");
      expect(JSON.parse(String(init.body)).item["@microsoft.graph.conflictBehavior"]).toBe("fail");
      return Response.json({ uploadUrl: "https://storage.example.test/session" });
    }
    expect(u).toContain("/root:/Reports:");
    return Response.json({ id: "folder-id", folder: {} });
  }) as typeof fetch);
  expect(await provider.upload("onedrive", "file.bin", { path: "Reports" }, bytes)).toMatchObject({
    id: "done",
    sizeBytes: bytes.length,
  });
  expect(ranges).toEqual([
    `bytes 0-${10 * 320 * 1024 - 1}/${bytes.length}`,
    `bytes ${10 * 320 * 1024}-${bytes.length - 1}/${bytes.length}`,
  ]);
});

test("Gmail attaches to an existing draft without losing MIME parts or sending mail; attachment reads verify membership", async () => {
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
  await expect(provider.download("gmail", { fileId: "m/unknown" })).rejects.toThrow(
    "does not belong"
  );
});

test("file contracts reject destination ambiguity and unsafe filename shapes", () => {
  for (const args of [
    { connection: "x", sourcePath: "/workspace/a", destination: { path: "a", folderId: "b" } },
    { connection: "x", sourcePath: "/workspace/a", destination: { name: "../a" } },
  ])
    expect(() => parseConnectorTransfer("upload_file", args)).toThrow();
  expect(() =>
    parseConnectorTransfer("download_file", { connection: "x", source: { fileId: "a", path: "b" } })
  ).toThrow();
});
