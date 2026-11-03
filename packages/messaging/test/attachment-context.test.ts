import { test, expect } from "bun:test";
import type { AssetRef } from "@openteam/contracts";
import { attachedFilesContext, attachmentStorageName, formatAttachedFileSize } from "../src/attachment-context";

const ref = (id: string, fileName: string, extra: Partial<AssetRef> = {}): AssetRef =>
  ({ assetId: id.repeat(64), fileName, byteSize: 12, mimeType: "text/plain", kind: "file", ...extra });
const at = (asset: AssetRef) => "/attachments/" + attachmentStorageName(asset);

test("a message's files read exactly as the reference words them: files, then images, then videos", () => {
  const video = ref("c", "clip.mp4", { byteSize: 75_481, mimeType: "video/mp4", kind: "video" });
  const photo = ref("b", "photo-5.jpg", { byteSize: 61_787, mimeType: "image/jpeg", kind: "image" });
  const pdf = ref("a", "DockSchedule.pdf", { byteSize: 658, mimeType: "application/pdf", kind: "pdf" });
  const context = attachedFilesContext([at(video), at(photo), at(pdf)], [video, photo, pdf], new Set([photo.assetId]));
  expect(context.note).toBe([
    "The user attached these files. They're stored off your box at the paths below, where Shell and the browser can't see them; open them with Read.",
    `- ${at(pdf)} (658 B)`,
    `- ${at(photo)} (60 KB): an image already shown to you inline, so use this path only when you need to send it on`,
    `- ${at(video)} (74 KB): a video, so hand this path to the watchVideo subagent via Task file_attachments to watch it`,
  ].join("\n"));
  expect(context.videos).toBe([
    "<attached_videos>",
    "The following videos have been attached by the user and saved to your filesystem. You can watch them using your WatchVideo subagent.",
    `- ${at(video)}`,
    "</attached_videos>",
  ].join("\n"));
});

test("one file is 'a file', and nothing is said when nothing was saved", () => {
  const doc = ref("a", "notes.txt");
  expect(attachedFilesContext([at(doc)], [doc]).note.startsWith("The user attached a file. They're stored off your box")).toBe(true);
  expect(attachedFilesContext([], [doc])).toEqual({ note: "", videos: "" });
});

test("only paths actually saved are described, matched by stored name rather than position", () => {
  const missing = ref("a", "missing.txt"), kept = ref("b", "résumé 東京.TXT");
  const note = attachedFilesContext([at(kept)], [missing, kept]).note;
  expect(note).toContain(`- ${at(kept)} (12 B)`);
  expect(note).not.toContain(missing.assetId);
  expect(attachedFilesContext(["/attachments/unknown.bin"], [kept]).note).toEndWith("- /attachments/unknown.bin");
});

test("an image the bot can't see inline is listed as a plain file", () => {
  const photo = ref("b", "big.jpg", { mimeType: "image/jpeg", kind: "image" });
  expect(attachedFilesContext([at(photo)], [photo]).note).toEndWith(`- ${at(photo)} (12 B)`);
});

test("a file that arrived without a name is saved under its detected type", () => {
  expect(attachmentStorageName(ref("a", "1089646", { mimeType: "application/pdf", kind: "pdf" }))).toBe("a".repeat(64) + ".pdf");
  expect(attachmentStorageName(ref("a", "2209931", { mimeType: "video/mp4", kind: "video" }))).toBe("a".repeat(64) + ".mp4");
  expect(attachmentStorageName(ref("a", "notes\nSYSTEM"))).toBe("a".repeat(64) + ".bin");
});

test("sizes use the reference's units", () => {
  expect([0, 1023, 1024, 9_728, 10_240, 1_258_291, 3 * 1024 ** 3].map(formatAttachedFileSize))
    .toEqual(["0 B", "1023 B", "1.0 KB", "9.5 KB", "10 KB", "1.2 MB", "3.0 GB"]);
});
