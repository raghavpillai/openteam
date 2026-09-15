import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
interface Receipt {
  fingerprint: string;
  status: "running" | "completed" | "uncertain";
  result?: unknown;
}
export class NativeActionReceipts {
  private tail = Promise.resolve();
  constructor(private readonly path: string) {}
  private mutate<T>(work: (receipts: Record<string, Receipt>) => T) {
    const task = this.tail.then(async () => {
      let receipts: Record<string, Receipt> = {};
      try {
        receipts = JSON.parse(await readFile(this.path, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Native action receipts are unavailable");
      }
      const result = work(receipts);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(receipts), { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.tail = task.then(
      () => {},
      () => {}
    );
    return task;
  }
  async execute(botId: string, callId: string, args: unknown, action: () => Promise<unknown>) {
    if (!callId) throw new Error("A durable action call ID is required");
    const key = JSON.stringify([botId, callId]);
    const fingerprint = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const prior = await this.mutate((receipts) => {
      const previous = receipts[key];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("Native action call ID was reused with different arguments");
        if (previous.status !== "completed")
          throw new Error(
            "This native action's outcome is uncertain; do not repeat it automatically"
          );
        return previous;
      }
      receipts[key] = { fingerprint, status: "running" };
      return null;
    });
    if (prior) return prior.result;
    try {
      const result = await action();
      await this.mutate((receipts) => {
        receipts[key] = { fingerprint, status: "completed", result };
      });
      return result;
    } catch (error) {
      await this.mutate((receipts) => {
        receipts[key] = { fingerprint, status: "uncertain" };
      });
      throw error;
    }
  }
}
