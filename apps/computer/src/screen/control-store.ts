import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ComputerControl {
  id: string;
  generation: number;
}
interface State {
  generation: number;
  owner: string | null;
}

/** Durable human ownership. Connectivity and activity never renew or expire it. */
export class ComputerControlStore {
  private states: Record<string, State> = {};
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private path: string) {}
  async get(botId: string): Promise<ComputerControl | null> {
    await (this.loading ??= this.load());
    const state = this.states[botId];
    return state?.owner ? { id: state.owner, generation: state.generation } : null;
  }
  private async load() {
    try {
      const states: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!states || typeof states !== "object" || Array.isArray(states))
        throw new Error("Invalid computer control state");
      for (const value of Object.values(states)) {
        if (
          !value ||
          !Number.isSafeInteger(value.generation) ||
          value.generation < 0 ||
          !(
            value.owner === null ||
            (typeof value.owner === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value.owner))
          )
        )
          throw new Error("Invalid computer control state");
      }
      this.states = states as Record<string, State>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  change(
    botId: string,
    active: boolean,
    id: string | undefined,
    generation: number | undefined,
    force: boolean,
    apply: (control: ComputerControl | null, committed: boolean) => Promise<void>
  ): Promise<ComputerControl | null> {
    const operation = this.queue.then(async () => {
      const current = await this.get(botId);
      if (active && force && !id) throw new Error("A viewer ID is required to take control");
      // Legacy clients and delayed cleanup cannot release a modern viewer's control.
      if (!id && !force) return current;
      if (active && current && current.id !== id && !force)
        throw new Error("Computer is controlled on another device");
      if (!active && !force && (!current || current.id !== id || current.generation !== generation))
        return current;
      if (active && current?.id === id) {
        await apply(current, true);
        return current;
      }
      const nextGeneration = (this.states[botId]?.generation ?? 0) + 1;
      const next = active && id ? { id, generation: nextGeneration } : null;
      // Stop agent input before acknowledging a grant. Keep it blocked during disk writes.
      if (next) await apply(next, false);
      const previous = this.states[botId];
      this.states[botId] = { owner: next?.id ?? null, generation: nextGeneration };
      const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, JSON.stringify(this.states), { mode: 0o600 });
        await rename(temporary, this.path);
      } catch (error) {
        if (previous) this.states[botId] = previous;
        else delete this.states[botId];
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      await apply(next, true);
      return next;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
