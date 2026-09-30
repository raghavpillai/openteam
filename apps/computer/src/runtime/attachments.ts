import { MAX_INLINE_IMAGE_BYTES, MAX_TASK_ATTACHMENTS, TASK_IMAGE_MIME_TYPES, TASK_VIDEO_EXTENSIONS } from "@openteam/contracts/media-input";
import type { RuntimeInlineImage } from "@openteam/contracts";
import { chown, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve, relative, sep } from "node:path";
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

export const IMAGE_MIME_TYPES = TASK_IMAGE_MIME_TYPES;
export const VIDEO_EXTENSIONS = TASK_VIDEO_EXTENSIONS;

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

export const attachmentRoots = (ownerBotId?: string): string[] => {
  const roots = ["/workspace"];
  if (ownerBotId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerBotId)) {
    roots.push(join(process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/home/box/agent-data", "agents", ownerBotId, "attachments"));
  }
  return roots;
};

export const attachmentPath = async (cwd: string, value: string, roots = attachmentRoots(), trustedBase?: string): Promise<string> => {
  const path = resolve(isAbsolute(value) ? value : join(cwd, value));
  const root = roots.map(root => resolve(root)).find(root => within(root, path));
  if (!root) throw new Error(`Subagent attachment must be inside the workspace or the owning agent's uploaded attachments: ${value}`);
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)]);
  const base = trustedBase ? resolve(trustedBase) : undefined;
  const expectedRoot = base && within(base, root) ? resolve(await realpath(base), relative(base, root)) : root;
  if (resolvedRoot !== expectedRoot || !within(resolvedRoot, resolvedPath)) throw new Error(`Subagent attachment resolves outside its allowed directory: ${value}`);
  return resolvedPath;
};

export async function loadAttachmentImages(
  cwd: string,
  fileAttachments: readonly string[],
  ownerBotId?: string
): Promise<{ images: RuntimeImage[]; tempDirectories: string[] }> {
  if (fileAttachments.length > MAX_TASK_ATTACHMENTS) {
    throw new Error(`Task accepts at most ${MAX_TASK_ATTACHMENTS} file_attachments. Split the media across separate tasks.`);
  }
  const images: RuntimeImage[] = [];
  const tempDirectories: string[] = [];
  try {
    for (const [attachmentIndex, value] of fileAttachments.entries()) {
      const path = await attachmentPath(cwd, value, attachmentRoots(ownerBotId), process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/home/box/agent-data");
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
      // Reserve one image for every remaining attachment. A final slice would
      // silently remove later screenshots or entire clips from the model input.
      const frameBudget = Math.min(frames.length, 16 - images.length - (fileAttachments.length - attachmentIndex - 1));
      const selectedFrames = Array.from({ length: frameBudget }, (_, index) =>
        frames[frameBudget === 1 ? 0 : Math.round(index * (frames.length - 1) / (frameBudget - 1))]!
      );
      for (const frame of selectedFrames) {
        images.push({
          type: "image",
          data: Buffer.from(await readFile(join(directory, frame))).toString("base64"),
          mimeType: "image/jpeg",
        });
      }
    }
    return { images, tempDirectories };
  } catch (error) {
    await Promise.all(
      tempDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
    );
    throw error;
  }
}
