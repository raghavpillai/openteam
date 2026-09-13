import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integer, string, tool } from "./google";

const inlineLimit = 75_000;
const lifetime = 24 * 60 * 60 * 1000;

/** Account-scoped snapshots keep large results intact across OAuth process restarts. */
export class ResultStore {
  private readonly directory: string;
  constructor(provider: string, account = process.env.OPENTEAM_PLUGIN_ACCOUNT_ID ?? process.env.GOOGLE_ACCESS_TOKEN ?? "anonymous", root = tmpdir()) {
    const scope = createHash("sha256").update(`${provider}\0${account}`).digest("hex");
    this.directory = join(root, "openteam-plugin-results", scope);
  }
  async capture(value: unknown): Promise<unknown> {
    const json = JSON.stringify(value);
    if (json.length <= inlineLimit) return value;
    if (Buffer.byteLength(json) > 128 * 1024 * 1024) throw new Error("Tool result exceeds 128 MB; narrow the request.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = (await Promise.all((await readdir(this.directory)).map(async (name) => {
      try { return { name, info: await stat(join(this.directory, name)) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    let bytes = Buffer.byteLength(json);
    for (const [index, entry] of entries.entries()) {
      bytes += entry.info.size;
      if (Date.now() - entry.info.mtimeMs > lifetime || index >= 31 || bytes > 256 * 1024 * 1024)
        await rm(join(this.directory, entry.name), { force: true });
    }
    const resultId = crypto.randomUUID();
    await writeFile(join(this.directory, `${resultId}.json`), json, { mode: 0o600, flag: "wx" });
    return this.page(resultId, 0);
  }
  async page(resultId: string, offset = 0, length = 20_000) {
    if (!/^[a-f0-9-]{36}$/.test(resultId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 20_000)
      throw new Error("Use the resultId and nextOffset from the previous result; length must be 1–20000.");
    const path = join(this.directory, `${resultId}.json`);
    let json: string;
    try {
      if (Date.now() - (await stat(path)).mtimeMs > lifetime) { await rm(path, { force: true }); throw new Error("expired"); }
      json = await readFile(path, "utf8");
    } catch { throw new Error("This result is unavailable for this account or has expired. Do not repeat a write to recover its result; inspect the created resource instead."); }
    if (offset > json.length) throw new Error("Result offset exceeds its length");
    let fragment = json.slice(offset, offset + length);
    while (JSON.stringify(fragment).length > 60_000) fragment = fragment.slice(0, Math.floor(fragment.length / 2));
    const next = offset + fragment.length;
    return {
      resultId, offset, totalCharacters: json.length, jsonFragment: fragment,
      nextOffset: next < json.length ? next : null,
      instructions: "This is a lossless JSON fragment. Use read_result with resultId and nextOffset until null, then concatenate jsonFragment values in offset order and parse JSON. The snapshot lasts up to 24 hours. Do not rerun the original write.",
    };
  }
  tool() {
    return tool("read_result", "Read the next lossless page of a large result from this same plugin account. Does not repeat the original provider operation.",
      { resultId: string("ID returned by a large result"), offset: integer("Character offset; use nextOffset", 128 * 1024 * 1024, 0), length: integer("Maximum characters", 20_000) },
      ["resultId"], (a) => this.page(a.resultId, a.offset ?? 0, a.length ?? 20_000));
  }
}
