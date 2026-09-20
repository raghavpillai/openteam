import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_TOKEN_BYTES = 16 * 1024;
const STORAGE_TIMEOUT_MS = 10_000;

export interface AuthTokenEncryption {
  backend: () => string;
  decrypt: (value: Buffer) => Promise<{ result: string; shouldReEncrypt?: boolean }>;
  encrypt: (value: string) => Promise<Buffer>;
  isAvailable: () => Promise<boolean>;
}

export interface AuthTokenReadResult {
  token: string | null;
  persistence: "encrypted" | "memory";
  backend: string;
}

const normalizedToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) return null;
  return token;
};

/**
 * Keeps the renderer's bearer out of web storage. The on-disk value is always
 * encrypted by Electron's OS-backed safeStorage implementation.
 */
export class DesktopAuthTokenStore {
  private memoryToken: string | null = null;
  private memoryEncrypted = false;
  private operation: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private sessionOnly: boolean | null = null;

  constructor(
    private readonly path: string,
    private readonly encryption: AuthTokenEncryption,
    private readonly timeoutMs = STORAGE_TIMEOUT_MS
  ) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(task);
    this.operation = next;
    return next;
  }

  private async native<T>(request: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            "Secure sign-in storage did not respond. Check the system permission prompt on this computer, then try again."
          )), this.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Secure sign-in storage")) throw error;
      throw new Error("Secure sign-in storage could not be accessed. Check the system permission prompt on this computer, then try again.");
    } finally {
      clearTimeout(timer);
    }
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("Secure sign-in storage was cancelled. Please sign in again.");
  }

  private async persistEncrypted(token: string, generation: number): Promise<void> {
    const encrypted = await this.native(() => this.encryption.encrypt(token));
    this.checkGeneration(generation);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
      this.checkGeneration(generation);
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private result(token: string | null, encryptionAvailable: boolean): AuthTokenReadResult {
    return {
      token,
      persistence: encryptionAvailable ? "encrypted" : "memory",
      backend: this.sessionOnly ? "session" : this.encryption.backend(),
    };
  }

  private emptyResult(): AuthTokenReadResult {
    if (this.sessionOnly) return this.result(null, false);
    const backend = this.encryption.backend();
    return {
      token: null,
      persistence: backend === "unavailable" || backend === "basic_text" ? "memory" : "encrypted",
      backend,
    };
  }

  private async isSessionOnly(): Promise<boolean> {
    if (this.sessionOnly !== null) return this.sessionOnly;
    try {
      // This empty preference marker contains no credentials. It prevents an
      // older saved session from being restored after a temporary login quits.
      await access(`${this.path}.session-only`);
      return this.sessionOnly = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.sessionOnly = false;
    }
  }

  writeSession(value: string): Promise<AuthTokenReadResult> {
    const token = normalizedToken(value);
    if (!token) return Promise.reject(new Error("Authentication token is invalid"));
    const generation = ++this.generation;
    this.sessionOnly = true;
    this.memoryToken = null;
    this.memoryEncrypted = false;
    return this.run(async () => {
      // Keep the explicit preference even if sign-out cancels this login, so
      // neither sign-out nor a restart can touch the previous saved session.
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.session-only`, "", { mode: 0o600 });
      this.sessionOnly = true;
      this.checkGeneration(generation);
      this.memoryToken = token;
      return this.result(token, false);
    });
  }

  read(): Promise<AuthTokenReadResult> {
    const generation = this.generation;
    return this.run(async () => {
      this.checkGeneration(generation);
      const sessionOnly = await this.isSessionOnly();
      this.checkGeneration(generation);
      if (sessionOnly) return this.result(this.memoryToken, false);
      if (this.memoryToken) {
        return this.result(this.memoryToken, this.memoryEncrypted);
      }
      let encrypted: Buffer;
      try {
        encrypted = await readFile(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Secure sign-in storage could not be read. Check file access and try again.");
        this.memoryToken = null;
        // A fresh or signed-out profile has nothing to decrypt. Avoid touching
        // the OS keychain on the startup path; macOS may synchronously prompt
        // or wait for Keychain even though no session exists.
        return this.emptyResult();
      }
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_TOKEN_BYTES * 4) {
        this.memoryToken = null;
        return this.emptyResult();
      }
      const encryptionAvailable = await this.native(() => this.encryption.isAvailable());
      this.checkGeneration(generation);
      if (!encryptionAvailable) {
        // A locked or temporarily unavailable OS keychain must not destroy a
        // session that can be decrypted again after the backend recovers.
        return this.result(null, false);
      }
      // Denied access and temporary OS failures must not delete an existing
      // encrypted session. A fresh successful sign-in can replace bad data.
      const decrypted = await this.native(() => this.encryption.decrypt(encrypted));
      this.checkGeneration(generation);
      const token = normalizedToken(decrypted.result);
      if (!token) throw new Error("Secure sign-in storage could not restore this session. Please sign in again.");
      if (decrypted.shouldReEncrypt) await this.persistEncrypted(token, generation);
      this.checkGeneration(generation);
      this.memoryToken = token;
      this.memoryEncrypted = true;
      return this.result(token, true);
    });
  }

  write(value: string): Promise<AuthTokenReadResult> {
    const token = normalizedToken(value);
    if (!token) return Promise.reject(new Error("Authentication token is invalid"));
    const generation = this.generation;
    return this.run(async () => {
      this.checkGeneration(generation);
      const encryptionAvailable = await this.native(() => this.encryption.isAvailable());
      this.checkGeneration(generation);
      if (!encryptionAvailable) {
        // Keep the existing unsupported-platform behavior, but do not turn
        // denial of a configured OS keychain into an in-memory sign-in.
        if (!["unavailable", "basic_text"].includes(this.encryption.backend())) {
          throw new Error("Secure sign-in storage is unavailable. Check the system permission prompt on this computer, then try again.");
        }
        await rm(this.path, { force: true }).catch(() => undefined);
        this.checkGeneration(generation);
        this.memoryToken = token;
        this.memoryEncrypted = false;
        return this.result(token, false);
      }
      await this.persistEncrypted(token, generation);
      this.checkGeneration(generation);
      await rm(`${this.path}.session-only`, { force: true });
      this.checkGeneration(generation);
      this.sessionOnly = false;
      this.memoryToken = token;
      this.memoryEncrypted = true;
      return this.result(token, true);
    });
  }

  clear(): Promise<AuthTokenReadResult> {
    // Invalidate in-flight native operations before joining the file queue.
    this.generation += 1;
    this.memoryToken = null;
    return this.run(async () => {
      this.memoryToken = null;
      if (!await this.isSessionOnly()) await rm(this.path, { force: true }).catch(() => undefined);
      return this.emptyResult();
    });
  }
}
