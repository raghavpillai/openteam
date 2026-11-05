import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** messagesEnabled: bots may read and send texts on this Mac. Only this Mac's app can turn it on. */
export interface ComputerSettings { version: 1; machineLabel: string | null; messagesEnabled: boolean; }
export const DEFAULT_COMPUTER_SETTINGS: ComputerSettings = { version: 1, machineLabel: null, messagesEnabled: false };
export const normalizeComputerSettings = (value: unknown): ComputerSettings => {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    version: 1,
    machineLabel: typeof record.machineLabel === "string" && record.machineLabel.trim() ? record.machineLabel.trim().slice(0, 80) : null,
    messagesEnabled: record.messagesEnabled === true,
  };
};
export interface ComputerSettingsStore {
  read(): Promise<ComputerSettings>;
  update(input: { machineLabel?: string; messagesEnabled?: boolean }): Promise<ComputerSettings>;
}

export const createComputerSettingsStore = (path: string): ComputerSettingsStore => {
  let writeSequence = Promise.resolve();

  const read = async (): Promise<ComputerSettings> => {
    try {
      return normalizeComputerSettings(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return structuredClone(DEFAULT_COMPUTER_SETTINGS);
      }
      throw error;
    }
  };

  const write = async (settings: ComputerSettings): Promise<ComputerSettings> => {
    const normalized = normalizeComputerSettings(settings);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
    return normalized;
  };

  const mutate = (operation: (settings: ComputerSettings) => ComputerSettings) => {
    const result = writeSequence.then(async () => write(operation(await read())));
    writeSequence = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    read,
    update: (input) =>
      mutate((settings) => ({
        ...settings,
        machineLabel: input.machineLabel?.trim().slice(0, 80) || settings.machineLabel,
        messagesEnabled: input.messagesEnabled ?? settings.messagesEnabled,
      })),
  };
};
