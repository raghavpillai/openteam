import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
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
