import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_TOKEN_BYTES = 16 * 1024;

export interface AuthTokenReadResult {
  token: string | null;
  persistence: "disk";
  backend: "file";
}

const normalizedToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) return null;
  return token;
};

/** Main-process session storage. Tokens are unencrypted, with owner-only file permissions. */
export class DesktopAuthTokenStore {
  private memoryToken: string | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private generation = 0;

  constructor(private readonly path: string) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(task);
    this.operation = next;
    return next;
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("Sign-in storage was cancelled. Please sign in again.");
  }

  private result(token: string | null): AuthTokenReadResult {
    return { token, persistence: "disk", backend: "file" };
  }

  read(): Promise<AuthTokenReadResult> {
    const generation = this.generation;
    return this.run(async () => {
      this.checkGeneration(generation);
      if (this.memoryToken) return this.result(this.memoryToken);
      let bytes: Buffer;
      try {
        bytes = await readFile(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.result(null);
        throw new Error("Sign-in storage could not be read. Check file access and try again.");
      }
      this.checkGeneration(generation);
      // Malformed files and old encrypted bytes must never become bearer tokens.
      if (bytes.byteLength > MAX_TOKEN_BYTES * 8) return this.result(null);
      try {
        const saved = JSON.parse(bytes.toString("utf8"));
        this.memoryToken = saved?.version === 1 ? normalizedToken(saved.token) : null;
      } catch {
        this.memoryToken = null;
      }
      return this.result(this.memoryToken);
    });
  }

  write(value: string): Promise<AuthTokenReadResult> {
    const token = normalizedToken(value);
    if (!token) return Promise.reject(new Error("Authentication token is invalid"));
    const generation = this.generation;
    return this.run(async () => {
      this.checkGeneration(generation);
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ version: 1, token }), { flag: "wx", mode: 0o600 });
        this.checkGeneration(generation);
        await rename(temporary, this.path);
        this.checkGeneration(generation);
        this.memoryToken = token;
        return this.result(token);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  clear(): Promise<AuthTokenReadResult> {
    this.generation += 1;
    this.memoryToken = null;
    return this.run(async () => {
      this.memoryToken = null;
      // Surface deletion failures rather than claiming a persistent session was removed.
      await rm(this.path, { force: true });
      return this.result(null);
    });
  }
}
