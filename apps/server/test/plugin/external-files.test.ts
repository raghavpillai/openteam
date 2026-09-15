import { test, expect } from "bun:test";
import { deliverExternalFiles } from "../../src/services/plugin/external-files";
const file = {
  assetId: "fixture",
  name: "binary.dat",
  mimeType: "application/octet-stream",
  bytes: Buffer.from([0, 1, 255, 9]),
};
test("Slack delivers native bytes privately and completes exactly once with the channel and text", async () => {
  const calls: string[] = [];
  const result = await deliverExternalFiles(
    "slack",
    "synthetic-token",
    "C123456",
    "Reviewed caption",
    [file],
    (async (url: any, init: any) => {
      calls.push(String(url));
      if (String(url).includes("getUploadURLExternal"))
        return Response.json({
          ok: true,
          file_id: "F123",
          upload_url: "https://files.slack.com/upload/fixture",
        });
      if (String(url).includes("/upload/")) {
        expect(Buffer.from(init.body)).toEqual(file.bytes);
        expect(init.headers.authorization).toBeUndefined();
        return new Response("OK");
      }
      expect(JSON.parse(init.body)).toEqual({
        files: [{ id: "F123", title: file.name }],
        channel_id: "C123456",
        initial_comment: "Reviewed caption",
      });
      return Response.json({ ok: true, files: [{ id: "F123" }] });
    }) as typeof fetch
  );
  expect(calls).toHaveLength(3);
  expect(result).toMatchObject({ sent: true, files: [{ id: "F123" }] });
  expect(JSON.stringify(result)).not.toContain("synthetic-token");
});
test("Gmail file delivery produces MIME attachments and never puts bytes into its receipt", async () => {
  let count = 0;
  const result = await deliverExternalFiles(
    "gmail",
    "fixture-token",
    "fixture@example.test",
    "Caption",
    [file],
    (async (url: any, init: any) => {
      count++;
      expect(String(url)).toEndWith("/messages/send");
      const mime = Buffer.from(JSON.parse(init.body).raw, "base64url").toString();
      expect(mime).toContain("To: fixture@example.test");
      expect(mime).toContain(file.bytes.toString("base64"));
      expect(mime).toContain("filename*=UTF-8''binary.dat");
      return Response.json({ id: "mail", threadId: "thread" });
    }) as typeof fetch
  );
  expect(count).toBe(1);
  expect(result).toEqual({ sent: true, messageId: "mail", threadId: "thread" });
});
