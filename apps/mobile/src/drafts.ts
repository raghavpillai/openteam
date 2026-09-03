import type { AssetRef } from "@openteam/contracts";
import type { DurableStagedAttachment } from "@openteam/product-core/durable-delivery";
import * as FileSystem from "expo-file-system/legacy";

export interface ConversationDraft {
  id: string;
  text: string;
  attachments: AssetRef[];
  stagedAttachments: DurableStagedAttachment[];
  replyTarget: { id: string; content: string } | null;
  recoveryNonce?: string;
}

const draftsDirectory = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}conversation-drafts`
  : null;

const draftPath = (draftKey: string) =>
  draftsDirectory ? `${draftsDirectory}/${encodeURIComponent(draftKey)}.json` : null;

export const newConversationDraftId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const scopeHash = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

export const conversationDraftKey = (
  serverUrl: string,
  channelId: string,
  accountIdentity = "local"
): string => {
  const configured = serverUrl.trim();
  if (!configured) return channelId;
  try {
    return `v3:${new URL(configured).origin}:${scopeHash(accountIdentity)}:${channelId}`;
  } catch {
    return `v3:${configured.replace(/\/+$/, "")}:${scopeHash(accountIdentity)}:${channelId}`;
  }
};

const writeTails = new Map<string, Promise<void>>();

const assetRef = (value: unknown): value is AssetRef => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AssetRef>;
  return (
    typeof candidate.assetId === "string" &&
    typeof candidate.fileName === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.byteSize === "number"
  );
};

const stagedAttachment = (value: unknown): value is DurableStagedAttachment => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DurableStagedAttachment>;
  return (
    typeof candidate.stagingId === "string" &&
    typeof candidate.fileName === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.byteSize === "number" &&
    typeof candidate.kind === "string"
  );
};

export const loadConversationDraft = async (
  draftKey: string
): Promise<ConversationDraft | null> => {
  const path = draftPath(draftKey);
  if (!path) return null;
  const backupPath = `${path}.previous`;
  const currentInfo = await FileSystem.getInfoAsync(path);
  const backupInfo = currentInfo.exists ? null : await FileSystem.getInfoAsync(backupPath);
  const readablePath = currentInfo.exists ? path : backupInfo?.exists ? backupPath : null;
  if (!readablePath) return null;
  const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(readablePath));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<ConversationDraft>;
  const reply = candidate.replyTarget;
  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : newConversationDraftId(),
    text: typeof candidate.text === "string" ? candidate.text : "",
    attachments: Array.isArray(candidate.attachments)
      ? candidate.attachments.filter(assetRef).slice(0, 6)
      : [],
    stagedAttachments: Array.isArray(candidate.stagedAttachments)
      ? candidate.stagedAttachments.filter(stagedAttachment).slice(0, 6)
      : [],
    replyTarget:
      reply && typeof reply.id === "string" && typeof reply.content === "string"
        ? { id: reply.id, content: reply.content }
        : null,
    ...(typeof candidate.recoveryNonce === "string" && candidate.recoveryNonce.length >= 8
      ? { recoveryNonce: candidate.recoveryNonce }
      : {}),
  };
};

const serializedWrite = (path: string, operation: () => Promise<void>): Promise<void> => {
  const prior = writeTails.get(path) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(operation);
  let tracked: Promise<void>;
  tracked = next.finally(() => {
    if (writeTails.get(path) === tracked) writeTails.delete(path);
  });
  writeTails.set(path, tracked);
  return tracked;
};

const atomicWriteDraft = async (path: string, value: string): Promise<void> => {
  const nextPath = `${path}.next`;
  const backupPath = `${path}.previous`;
  await FileSystem.writeAsStringAsync(nextPath, value);
  const backup = await FileSystem.getInfoAsync(backupPath);
  if (backup.exists) await FileSystem.deleteAsync(backupPath, { idempotent: true });
  const current = await FileSystem.getInfoAsync(path);
  if (current.exists) await FileSystem.moveAsync({ from: path, to: backupPath });
  try {
    await FileSystem.moveAsync({ from: nextPath, to: path });
    await FileSystem.deleteAsync(backupPath, { idempotent: true }).catch(() => undefined);
  } catch (cause) {
    const recoverable = await FileSystem.getInfoAsync(backupPath);
    if (recoverable.exists) await FileSystem.moveAsync({ from: backupPath, to: path });
    throw cause;
  }
};

export const saveConversationDraft = async (
  draftKey: string,
  draft: ConversationDraft
): Promise<void> => {
  const path = draftPath(draftKey);
  if (!path || !draftsDirectory) return;
  await serializedWrite(path, async () => {
    const empty =
      !draft.text &&
      draft.attachments.length === 0 &&
      draft.stagedAttachments.length === 0 &&
      !draft.replyTarget &&
      !draft.recoveryNonce;
    if (empty) {
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
      await FileSystem.deleteAsync(`${path}.previous`, { idempotent: true }).catch(() => undefined);
      return;
    }
    await FileSystem.makeDirectoryAsync(draftsDirectory, { intermediates: true });
    await atomicWriteDraft(path, JSON.stringify(draft));
  });
};

export const clearConversationDraftIfCurrent = async (
  draftKey: string,
  expectedId: string
): Promise<boolean> => {
  const path = draftPath(draftKey);
  if (!path) return false;
  let cleared = false;
  await serializedWrite(path, async () => {
    const current = await loadConversationDraft(draftKey).catch(() => null);
    if (current?.id !== expectedId) return;
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(`${path}.previous`, { idempotent: true }).catch(() => undefined);
    cleared = true;
  });
  return cleared;
};

export const flushConversationDraftWrites = async (): Promise<void> => {
  while (writeTails.size > 0) await Promise.all([...writeTails.values()]);
};
