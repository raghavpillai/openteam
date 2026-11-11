import { mkdtempSync, openSync, closeSync, fstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReadStream, agentWriteStream } from "../../src/agent-file-stream";

const mode = process.argv[2];
if (mode !== "read" && mode !== "write") throw new Error("Expected read or write");
const directory = mkdtempSync(join(tmpdir(), "stream-descriptor-ownership-"));
const path = join(directory, "payload");
const payload = Buffer.from("Only the requested bytes.\n");
writeFileSync(path, payload);
const held: number[] = [];
let transferred = 0, unexpectedlyClosed = 0;
try {
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
} finally {
  for (const fd of held) { try { closeSync(fd); } catch {} }
  rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ transferred, unexpectedlyClosed }));
