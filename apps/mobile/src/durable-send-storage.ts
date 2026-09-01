import type {
  DurableSendJournal,
  DurableSendStorage,
} from "@openbot/product-core/durable-delivery";
import {
  DURABLE_SEND_JOURNAL_MAX_BYTES,
  durableSendScope,
  durableSendScopeHash,
} from "@openbot/product-core/durable-delivery";
import * as FileSystem from "expo-file-system/legacy";

interface StoredJournal {
  generation: number;
  scope: string;
  journal: DurableSendJournal;
}

const directory = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}durable-send-journal`
  : null;
const generations = new Map<string, number>();
const writeTails = new Map<string, Promise<void>>();

const pathsFor = (scope: string): string[] =>
  directory
    ? [
        `${directory}/${durableSendScopeHash(scope)}.a.json`,
        `${directory}/${durableSendScopeHash(scope)}.b.json`,
      ]
    : [];

const readStored = async (path: string): Promise<StoredJournal | null> => {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    if (
      "size" in info &&
      typeof info.size === "number" &&
      info.size > DURABLE_SEND_JOURNAL_MAX_BYTES
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<StoredJournal>;
    if (
      !Number.isSafeInteger(candidate.generation) ||
      (candidate.generation as number) < 0 ||
      typeof candidate.scope !== "string" ||
      !candidate.journal
    ) {
      return null;
    }
    return candidate as StoredJournal;
  } catch {
    return null;
  }
};

const replace = async (path: string, payload: string): Promise<void> => {
  const nextPath = `${path}.next`;
  await FileSystem.writeAsStringAsync(nextPath, payload);
  const current = await FileSystem.getInfoAsync(path);
  if (current.exists) await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: nextPath, to: path });
};

export const createMobileDurableSendStorage = (scopeInput: string): DurableSendStorage => {
  const scope = durableSendScope(scopeInput);
  return {
    read: async () => {
      const slots = pathsFor(scope);
      // A complete `.next` file is the recoverable side of an interrupted rename,
      // including the very first journal write when no older slot exists yet.
      const readablePaths = slots.flatMap((path) => [path, `${path}.next`]);
      const candidates = (await Promise.all(readablePaths.map(readStored)))
        .filter((candidate): candidate is StoredJournal => candidate?.scope === scope)
        .sort((left, right) => right.generation - left.generation);
      const latest = candidates[0];
      if (!latest) return null;
      generations.set(scope, Math.max(generations.get(scope) ?? 0, latest.generation));
      return latest.journal;
    },
    write: (journal) => {
      const previous = writeTails.get(scope) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const paths = pathsFor(scope);
          if (!directory || paths.length === 0) {
            throw new Error("Durable message storage is unavailable on this device.");
          }
          const generation = Math.max(Date.now(), (generations.get(scope) ?? 0) + 1);
          const payload = JSON.stringify({ generation, scope, journal } satisfies StoredJournal);
          if (new TextEncoder().encode(payload).byteLength > DURABLE_SEND_JOURNAL_MAX_BYTES) {
            throw new Error("Durable message journal exceeds its storage limit.");
          }
          generations.set(scope, generation);
          await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
          const targetPath = paths[generation % paths.length];
          if (!targetPath) throw new Error("Durable message storage has no writable journal slot.");
          await replace(targetPath, payload);
        });
      writeTails.set(scope, next);
      return next.finally(() => {
        if (writeTails.get(scope) === next) writeTails.delete(scope);
      });
    },
  };
};
