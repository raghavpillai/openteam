import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DURABLE_SEND_JOURNAL_MAX_BYTES,
  durableSendScope,
  durableSendScopeHash,
} from "@openbot/product-core/durable-delivery";

interface StoredJournal {
  generation: number;
  scope: string;
  journal: unknown;
}

const storedJournal = (value: unknown, scope: string): StoredJournal | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredJournal>;
  if (
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 0 ||
    candidate.scope !== scope ||
    !candidate.journal ||
    typeof candidate.journal !== "object" ||
    Array.isArray(candidate.journal)
  ) {
    return null;
  }
  return candidate as StoredJournal;
};

const readCandidate = async (path: string, scope: string): Promise<StoredJournal | null> => {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > DURABLE_SEND_JOURNAL_MAX_BYTES) return null;
    return storedJournal(JSON.parse(bytes.toString("utf8")), scope);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
};

const writeAtomically = async (path: string, payload: string): Promise<void> => {
  const temporary = `${path}.next`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(payload, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rm(path, { force: true });
  await rename(temporary, path);
  try {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some platforms cannot fsync a directory; the two generations still keep
    // one complete journal if the rename is interrupted.
  }
};

/** Main-process, two-slot journal storage. One valid generation survives any interrupted write. */
export class DurableSendJournalStore {
  private readonly generations = new Map<string, number>();
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  private paths(scope: string): [string, string] {
    const base = join(this.directory, durableSendScopeHash(scope));
    return [`${base}.a.json`, `${base}.b.json`];
  }

  async read(scopeInput: string): Promise<unknown> {
    const scope = durableSendScope(scopeInput);
    const paths = this.paths(scope);
    const candidates = (
      await Promise.all(
        paths.flatMap((path) => [path, `${path}.next`]).map((path) => readCandidate(path, scope))
      )
    )
      .filter((candidate): candidate is StoredJournal => candidate !== null)
      .sort((left, right) => right.generation - left.generation);
    const latest = candidates[0];
    if (!latest) return null;
    this.generations.set(scope, Math.max(this.generations.get(scope) ?? 0, latest.generation));
    return latest.journal;
  }

  write(scopeInput: string, journal: unknown): Promise<void> {
    const scope = durableSendScope(scopeInput);
    if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
      return Promise.reject(new Error("Delivery journal is invalid"));
    }
    const previous = this.writeTails.get(scope) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.generations.has(scope)) await this.read(scope);
        const generation = Math.max(Date.now(), (this.generations.get(scope) ?? 0) + 1);
        const payload = JSON.stringify({ generation, scope, journal } satisfies StoredJournal);
        if (Buffer.byteLength(payload, "utf8") > DURABLE_SEND_JOURNAL_MAX_BYTES) {
          throw new Error("Delivery journal exceeds its storage limit");
        }
        this.generations.set(scope, generation);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = this.paths(scope)[generation % 2]!;
        await writeAtomically(target, payload);
      });
    this.writeTails.set(scope, next);
    return next.finally(() => {
      if (this.writeTails.get(scope) === next) this.writeTails.delete(scope);
    });
  }
}
