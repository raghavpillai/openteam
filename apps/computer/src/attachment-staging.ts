import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { attachmentLimitForName } from "@openteam/contracts/media-input";
import { agentReadStream } from "./agent-file-stream";

const within = (root: string, file: string) => {
  const part = relative(root, file);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
};

/** Stage only ordinary box-user deliverables. Server roots and private-state
 * checks stay unchanged; the source stream uses the unprivileged agent identity. */
export async function stageAttachment(
  url: string,
  options: { workspace: string; agentData: string; home?: string; temporary?: string },
  signal?: AbortSignal
): Promise<{ url: string; cleanup(): Promise<void> }> {
  const unchanged = { url, cleanup: async () => {} };
  if (!url.startsWith("file:")) return unchanged;
  const source = await realpath(fileURLToPath(url));
  const roots = await Promise.all([options.workspace, options.agentData].map(p => realpath(p).catch(() => resolve(p))));
  // Agent-state files still go through the server's protected-state policy.
  // Workspace files may live in runner-owned 0700 directories (e.g. mktemp).
  // Export their bytes as the runner instead of widening source permissions.
  if (within(roots[1]!, source)) return unchanged;
  const inWorkspace = within(roots[0]!, source);
  const deliveryRoots = await Promise.all([options.home ?? "/home/box", options.temporary ?? "/tmp"].map(p => realpath(p).catch(() => resolve(p))));
  const root = deliveryRoots.find(root => within(root, source));
  if (!inWorkspace && (!root || relative(root, source).split(sep).some(part => part.startsWith("."))))
    throw new Error("Attachment path is outside ordinary box deliverable locations");
  const info = await stat(source);
  const maximum = attachmentLimitForName(basename(source));
  if (!info.isFile()) throw new Error("Attachment must be a regular file");
  if (info.size > maximum)
    throw new Error(`Attachment is ${info.size} bytes; the limit for this file type is ${maximum} bytes. The original file was not changed.`);
  const directory = await mkdtemp(join(options.workspace, ".openteam-delivery-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const target = join(directory, basename(source));
    const reader = agentReadStream(source, signal, inWorkspace
      ? { allowedRoots: [roots[0]!], excludedRoots: [roots[1]!] }
      : { allowedRoots: deliveryRoots, excludedRoots: roots });
    let count = 0;
    try {
      await pipeline(reader.stream, new Transform({ transform(bytes, _encoding, done) {
        count += bytes.length;
        done(count > maximum ? new Error(`Attachment exceeds the ${maximum}-byte limit while reading (${count} bytes read). The original file was not changed.`) : null, bytes);
      } }), createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
      await reader.done;
    } finally {
      reader.cancel();
      await reader.done.catch(() => {});
    }
    // Publish to the sibling server container only after the verified stream ends.
    await chmod(target, 0o644);
    await chmod(directory, 0o755);
    return { url: pathToFileURL(target).href, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
