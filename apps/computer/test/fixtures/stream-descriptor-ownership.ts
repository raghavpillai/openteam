import { mkdtempSync, openSync, closeSync, fstatSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReadStream, agentWriteStream } from "../../src/agent-file-stream";
import { agentProcessIdentity } from "../../src/agent-process";

const mode = process.argv[2];
const early = mode?.startsWith("early-");
if (mode !== "read" && mode !== "write" && !early) throw new Error("Expected read, write, or early-exit mode");
const directory = mkdtempSync(join(tmpdir(), "stream-descriptor-ownership-"));
const identity = agentProcessIdentity();
if (identity.uid !== undefined && identity.gid !== undefined) chownSync(directory, identity.uid, identity.gid);
const path = join(directory, "payload");
const payload = Buffer.from("Only the requested bytes.\n");
writeFileSync(path, payload);
const held: number[] = [];
let transferred = 0, unexpectedlyClosed = 0;
try {
  if (early) {
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "Existing blocker");
    const readOnly = join(directory, "read-only");
    mkdirSync(readOnly);
    if (identity.uid !== undefined && identity.gid !== undefined) chownSync(readOnly, identity.uid, identity.gid);
    chmodSync(readOnly, 0o500);
    const before = new Set<number>();
    for (let fd = 3; fd < 256; fd++) try { fstatSync(fd); before.add(fd); } catch {}
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let releaseCancel!: () => void;
    const cancelled = new Promise<void>(resolve => { releaseCancel = resolve; });
    const input = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { return mode === "early-abort" ? cancelled : undefined; },
    });
    const abort = new AbortController();
    const destination = mode === "early-read-only" ? join(readOnly, "target")
      : mode === "early-abort" ? join(directory, "aborted") : join(blocker, "target");
    const pending = agentWriteStream(destination, input, abort.signal).then(
      () => ({ error: "" }), error => ({ error: String(error) })
    );
    // The transfer opens its unlinked receipt synchronously before awaiting the
    // source. Track that exact descriptor, not a guessed child-exit delay.
    let receipt: { fd: number; ino: number | bigint; dev: number | bigint } | undefined;
    for (let fd = 3; fd < 256; fd++) if (!before.has(fd)) try {
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.nlink === 0) { receipt = { fd, ino: stat.ino, dev: stat.dev }; break; }
    } catch {}
    if (!receipt) throw new Error("Receipt descriptor was not found");
    if (mode === "early-abort") abort.abort(new Error("Synthetic transfer cancellation"));
    let closed = false;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      try {
        const stat = fstatSync(receipt.fd);
        if (stat.ino !== receipt.ino || stat.dev !== receipt.dev) { closed = true; break; }
      } catch { closed = true; break; }
      await Bun.sleep(5);
    }
    if (!closed) throw new Error("Helper did not release its receipt");
    const unrelated: string[] = [];
    for (let index = 0; index < 32; index++) {
      const path = join(directory, `unrelated-early-${index}`), fd = openSync(path, "wx+", 0o600);
      writeFileSync(fd, "Unrelated file must remain unchanged.");
      unrelated.push(path);
      held.push(fd);
    }
    if (!held.includes(receipt.fd)) {
      controller.error(new Error("Receipt was not reused by a sentinel"));
      releaseCancel();
      await pending;
      throw new Error("Cannot establish descriptor-reuse control");
    }
    if (mode === "early-abort") releaseCancel();
    else {
      if (mode === "early-chunks") controller.enqueue(payload);
      controller.close();
    }
    const outcome = await pending;
    if (!outcome.error) throw new Error("Failed helper unexpectedly succeeded");
    if (mode !== "early-abort" && !/EEXIST|ENOTDIR|EACCES|EPERM/.test(outcome.error))
      throw new Error(`Original helper error was lost: ${outcome.error}`);
    const changed = unrelated.filter(path => readFileSync(path, "utf8") !== "Unrelated file must remain unchanged.").length;
    console.log(JSON.stringify({ failedAsExpected: true, reusedReceipt: true, unexpectedlyChanged: changed }));
  } else {
    for (let index = 0; index < 64; index++) {
      if (mode === "read") {
        const source = agentReadStream(path);
        const chunks: Buffer[] = [];
        for await (const chunk of source.stream) chunks.push(Buffer.from(chunk));
        await source.done;
        if (!Buffer.concat(chunks).equals(payload)) throw new Error("Read content changed");
      } else {
        const bytes = await agentWriteStream(path, new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }));
        if (bytes !== payload.length || !readFileSync(path).equals(payload)) throw new Error("Write content changed");
      }
      transferred++;
      // Hold unrelated files open after each child exits. A stale native finalizer
      // must never close a descriptor the OS has reassigned to one of these files.
      for (let slot = 0; slot < 8; slot++)
        held.push(openSync(join(directory, `unrelated-${index}-${slot}`), "wx", 0o600));
    }
    for (let cycle = 0; cycle < 8; cycle++) { Bun.gc(true); await Bun.sleep(10); }
    for (const fd of held) {
      try { fstatSync(fd); }
      catch { unexpectedlyClosed++; }
    }
  }
} finally {
  for (const fd of held) { try { closeSync(fd); } catch {} }
  rmSync(directory, { recursive: true, force: true });
}
if (!early) console.log(JSON.stringify({ transferred, unexpectedlyClosed }));
