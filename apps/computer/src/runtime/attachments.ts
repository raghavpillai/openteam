import { MAX_INLINE_IMAGE_BYTES } from "@openteam/contracts/media-input";
import type { RuntimeInlineImage } from "@openteam/contracts";
import { chown, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "../agent-process";
import type { RuntimeImage } from "./types";

export const MAX_IMAGE_BYTES = MAX_INLINE_IMAGE_BYTES;

export const INLINE_IMAGE_PREFIX = /^data:(image\/(?:gif|jpeg|png|webp));base64,/i;

export const decodeInlineImages = (inputs: readonly RuntimeInlineImage[]): RuntimeImage[] =>
  inputs.map((input, index) => {
    const prefix = INLINE_IMAGE_PREFIX.exec(input.url);
    if (!prefix?.[1]) throw new Error(`Uploaded image ${index + 1} is not a supported data URL`);
    const encoded = input.url.slice(prefix[0].length);
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      throw new Error(`Uploaded image ${index + 1} has invalid base64 data`);
    }
    const data = Buffer.from(encoded, "base64");
    if (data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Uploaded image ${index + 1} exceeds 25 MB`);
    }
    return {
      type: "image",
      data: data.toString("base64"),
      mimeType: prefix[1].toLowerCase(),
    };
  });

export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const VIDEO_EXTENSIONS = new Set([".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

export const attachmentPath = (cwd: string, value: string): string => {
  const path = resolve(isAbsolute(value) ? value : join(cwd, value));
  if (path !== "/workspace" && !path.startsWith("/workspace/")) {
    throw new Error(`Subagent attachment must be inside /workspace: ${value}`);
  }
  return path;
};

export async function loadAttachmentImages(
  cwd: string,
  fileAttachments: readonly string[]
): Promise<{ images: RuntimeImage[]; tempDirectories: string[] }> {
  const images: RuntimeImage[] = [];
  const tempDirectories: string[] = [];
  try {
    for (const value of fileAttachments.slice(0, 8)) {
      const path = attachmentPath(cwd, value);
      const details = await stat(path);
      if (!details.isFile()) throw new Error(`Subagent attachment is not a file: ${value}`);
      const extension = extname(path).toLowerCase();
      const imageMimeType = IMAGE_MIME_TYPES[extension];
      if (imageMimeType) {
        if (details.size > 20 * 1024 * 1024) {
          throw new Error(`Subagent image attachment exceeds 20 MB: ${value}`);
        }
        images.push({
          type: "image",
          data: Buffer.from(await readFile(path)).toString("base64"),
          mimeType: imageMimeType,
        });
        continue;
      }
      if (!VIDEO_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported subagent attachment type: ${value}`);
      }
      if (details.size > 500 * 1024 * 1024) {
        throw new Error(`Subagent video attachment exceeds 500 MB: ${value}`);
      }
      const directory = await mkdtemp(join(tmpdir(), "openteam-video-frames-"));
      tempDirectories.push(directory);
      const identity = agentProcessIdentity();
      if (identity.uid !== undefined && identity.gid !== undefined) {
        await chown(directory, identity.uid, identity.gid);
      }
      const child = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          path,
          "-vf",
          "select='eq(n,0)+gte(t-prev_selected_t,10)',scale='min(1280,iw)':-2",
          "-fps_mode",
          "vfr",
          "-frames:v",
          "12",
          "-pix_fmt",
          "yuvj420p",
          "-q:v",
          "3",
          join(directory, "%03d.jpg"),
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
          env: sanitizedAgentEnvironment(process.env),
          ...identity,
        }
      );
      const stderr = await new Response(child.stderr).text();
      if ((await child.exited) !== 0) {
        throw new Error(`Could not read subagent video attachment: ${stderr.slice(0, 500)}`);
      }
      const frames = (await readdir(directory))
        .filter((name) => name.endsWith(".jpg"))
        .sort()
        .slice(0, 12);
      if (frames.length === 0) throw new Error(`Video attachment produced no frames: ${value}`);
      for (const frame of frames) {
        images.push({
          type: "image",
          data: Buffer.from(await readFile(join(directory, frame))).toString("base64"),
          mimeType: "image/jpeg",
        });
      }
    }
    return { images: images.slice(0, 16), tempDirectories };
  } catch (error) {
    await Promise.all(
      tempDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
    );
    throw error;
  }
}
