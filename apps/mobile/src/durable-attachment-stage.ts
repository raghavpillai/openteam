import type { DurableStagedAttachment } from "@openbot/product-core/durable-delivery";
import { attachmentAssetKind } from "@openbot/product-core/attachments";
import * as FileSystem from "expo-file-system/legacy";

const directory = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}durable-send-files`
  : null;
const STAGING_ID = /^[a-zA-Z0-9-]{8,120}$/;

const stagingId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const pathFor = (id: string): string => {
  if (!directory || !STAGING_ID.test(id)) {
    throw new Error("Durable attachment staging is unavailable.");
  }
  return `${directory}/${id}`;
};

export interface MobileDeliveryAttachmentSource {
  uri: string;
  fileName: string;
  mimeType?: string;
  byteSize?: number | null;
  alt?: string;
}

export const stageMobileDeliveryAttachment = async (
  source: MobileDeliveryAttachmentSource
): Promise<DurableStagedAttachment> => {
  const id = stagingId();
  const target = pathFor(id);
  const temporary = `${target}.next`;
  if (!directory) throw new Error("Durable attachment staging is unavailable.");
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  try {
    await FileSystem.copyAsync({ from: source.uri, to: temporary });
    const info = await FileSystem.getInfoAsync(temporary);
    const byteSize =
      typeof source.byteSize === "number" && source.byteSize > 0
        ? source.byteSize
        : info.exists && "size" in info && typeof info.size === "number"
          ? info.size
          : 0;
    if (byteSize < 1 || byteSize > 200 * 1024 * 1024) {
      throw new Error("Attachment size is invalid.");
    }
    await FileSystem.moveAsync({ from: temporary, to: target });
    const mimeType = source.mimeType?.trim() || "application/octet-stream";
    return {
      stagingId: id,
      fileName: source.fileName,
      mimeType,
      byteSize,
      kind: attachmentAssetKind({ fileName: source.fileName, mimeType }),
      ...(source.alt ? { alt: source.alt } : {}),
      previewUri: target,
    };
  } catch (cause) {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
    throw cause;
  }
};

export const mobileDeliveryAttachmentUri = (stagingId: string): string => pathFor(stagingId);

export const discardMobileDeliveryAttachments = async (
  attachments: readonly DurableStagedAttachment[]
): Promise<void> => {
  await Promise.all(
    attachments.map((attachment) =>
      FileSystem.deleteAsync(pathFor(attachment.stagingId), { idempotent: true }).catch(
        () => undefined
      )
    )
  );
};
