import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_TOKEN_BYTES = 16 * 1024;

export interface AuthTokenEncryption {
  backend: () => string;
  decrypt: (value: Buffer) => string;
  encrypt: (value: string) => Buffer;
  isAvailable: () => boolean;
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
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly encryption: AuthTokenEncryption
  ) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(task);
    this.operation = next;
    return next;
  }

  private result(token: string | null, encryptionAvailable: boolean): AuthTokenReadResult {
    return {
      token,
      persistence: encryptionAvailable ? "encrypted" : "memory",
      backend: this.encryption.backend(),
    };
  }

  private emptyResult(): AuthTokenReadResult {
    const backend = this.encryption.backend();
    return {
      token: null,
      persistence: backend === "unavailable" || backend === "basic_text" ? "memory" : "encrypted",
      backend,
    };
  }

  read(): Promise<AuthTokenReadResult> {
    return this.run(async () => {
      if (this.memoryToken) {
        const encryptionAvailable = this.encryption.isAvailable();
        return this.result(this.memoryToken, encryptionAvailable);
      }
      let encrypted: Buffer;
      try {
        encrypted = await readFile(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          await rm(this.path, { force: true }).catch(() => undefined);
        }
        this.memoryToken = null;
        // A fresh or signed-out profile has nothing to decrypt. Avoid touching
        // the OS keychain on the startup path; macOS may synchronously prompt
        // or wait for Keychain even though no session exists.
        return this.emptyResult();
      }
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_TOKEN_BYTES * 4) {
        await rm(this.path, { force: true }).catch(() => undefined);
        this.memoryToken = null;
        return this.emptyResult();
      }
      const encryptionAvailable = this.encryption.isAvailable();
      if (!encryptionAvailable) {
        // A locked or temporarily unavailable OS keychain must not destroy a
        // session that can be decrypted again after the backend recovers.
        return this.result(null, false);
      }
      try {
        const token = normalizedToken(this.encryption.decrypt(encrypted));
        if (!token) throw new Error("Encrypted session is invalid");
        this.memoryToken = token;
        return this.result(token, true);
      } catch {
        await rm(this.path, { force: true }).catch(() => undefined);
        this.memoryToken = null;
        return this.result(null, true);
      }
    });
  }

  write(value: string): Promise<AuthTokenReadResult> {
    const token = normalizedToken(value);
    if (!token) return Promise.reject(new Error("Authentication token is invalid"));
    return this.run(async () => {
      this.memoryToken = token;
      const encryptionAvailable = this.encryption.isAvailable();
      if (!encryptionAvailable) {
        await rm(this.path, { force: true }).catch(() => undefined);
        return this.result(token, false);
      }
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const encrypted = this.encryption.encrypt(token);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
        await rename(temporary, this.path);
        await chmod(this.path, 0o600);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rm(this.path, { force: true }).catch(() => undefined);
        throw error;
      }
      return this.result(token, true);
    });
  }

  clear(): Promise<AuthTokenReadResult> {
    return this.run(async () => {
      this.memoryToken = null;
      await rm(this.path, { force: true }).catch(() => undefined);
      return this.emptyResult();
    });
  }
}
