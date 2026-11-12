import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const MAX_DELIVERY_STAGE_BYTES = 200 * 1024 * 1024;
const STAGING_ID = /^[a-zA-Z0-9-]{8,120}$/;

export interface DeliveryFileStageInput {
  stagingId: string;
  bytes: ArrayBuffer | Uint8Array;
}

const checkedId = (value: string): string => {
  if (!STAGING_ID.test(value)) throw new Error("Delivery staging ID is invalid");
  return value;
};

export const deliveryStagePath = (directory: string, stagingId: string): string =>
  join(directory, checkedId(stagingId));

const bytesFrom = (value: ArrayBuffer | Uint8Array): Uint8Array => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DELIVERY_STAGE_BYTES) {
    throw new Error("Delivery attachment size is invalid");
  }
  return bytes;
};

export const stageDeliveryFile = async (
  directory: string,
  input: DeliveryFileStageInput
): Promise<void> => {
  const target = deliveryStagePath(directory, input.stagingId);
  const temporary = `${target}.next`;
  const bytes = bytesFrom(input.bytes);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, target);
};

export const readDeliveryFile = async (directory: string, stagingId: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(deliveryStagePath(directory, stagingId)));

export const discardDeliveryFiles = async (
  directory: string,
  stagingIds: readonly string[]
): Promise<void> => {
  await Promise.all(
    [...new Set(stagingIds)].map((stagingId) =>
      unlink(deliveryStagePath(directory, stagingId)).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
      })
    )
  );
};

/** Half-written stages (a crash between write and rename) can never be sent: drop them. Old
 * ones only, so a write in progress in this run is left alone. */
export const sweepIncompleteDeliveryStages = async (directory: string, olderThanMs = 10 * 60_000): Promise<number> => {
  const names = await readdir(directory).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".next") || !STAGING_ID.test(name.slice(0, -5))) continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < olderThanMs) continue;
    if (await unlink(path).then(() => true, () => false)) removed += 1;
  }
  return removed;
};
