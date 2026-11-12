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
