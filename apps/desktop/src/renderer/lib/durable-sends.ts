import { MAX_PARALLEL_UPLOADS, mapWithConcurrency } from "@openteam/client-core";
import { attachmentAssetKind } from "@openteam/product-core/attachments";
import {
  classifyDurableSendError,
  createDurableSendController,
  type DurableSendController,
  type DurableSendJournal,
  type DurableSendRecord,
  type DurableStagedAttachment,
  messageDeliveryAcceptance,
  type MessageDeliveryAcceptance,
} from "@openteam/product-core/durable-delivery";
import { getAuthSnapshot, subscribeAuthSnapshot } from "../client/auth";
import { API_BASE } from "../client/http";
import { api } from "../client/openteam-api";
import { recordPerformance } from "./performance";

export const DURABLE_SEND_ACCEPTED_EVENT = "openteam:durable-send-accepted";

const controllers = new Map<string, DurableSendController>();
const controllerCleanups = new Map<DurableSendController, () => void>();
let transportDownUntilMs = 0;
let transportDownSnapshot = navigator.onLine === false;
const transportListeners = new Set<() => void>();
const ephemeralStages = new Map<string, Blob>();
const ATTACHMENT_COMMIT_TIMEOUT_MS = 120_000;

class InactiveDeliveryScopeError extends Error {}

export const desktopSendTransportDown = (): boolean =>
  navigator.onLine === false || Date.now() < transportDownUntilMs;

const refreshTransportSnapshot = () => {
  const next = desktopSendTransportDown();
  if (next === transportDownSnapshot) return;
  transportDownSnapshot = next;
  for (const listener of transportListeners) listener();
};

export const desktopSendTransportSnapshot = (): boolean => transportDownSnapshot;

export const subscribeDesktopSendTransport = (listener: () => void): (() => void) => {
  transportListeners.add(listener);
  refreshTransportSnapshot();
  return () => transportListeners.delete(listener);
};

const accountScope = (): string => {
  const auth = getAuthSnapshot();
  return `desktop:${API_BASE}:${auth.user?.id ?? (auth.mode === "disabled" ? "local" : "signed-out")}`;
};

const storageKey = (scope: string): string => `openteam:send-journal:v1:${scope}`;

const storageFor = (scope: string) => ({
  read: async (): Promise<unknown> => {
    const host = window.openteam?.deliveryJournal;
    if (host) {
      try {
        const journal = await host.read(scope);
        if (journal) return journal;
      } catch {
        // A legacy renderer journal is still a valid crash-recovery source if
        // the host bridge is temporarily unavailable during startup.
      }
    }
    const encoded = localStorage.getItem(storageKey(scope));
    if (!encoded) return null;
    let journal: unknown;
    try {
      journal = JSON.parse(encoded) as unknown;
    } catch {
      return null;
    }
    if (host) {
      try {
        await host.write(scope, journal);
        localStorage.removeItem(storageKey(scope));
      } catch {
        // Keep the legacy copy until a later host-backed write succeeds.
      }
    }
    return journal;
  },
  write: async (journal: DurableSendJournal): Promise<void> => {
    if (window.openteam?.deliveryJournal) {
      await window.openteam.deliveryJournal.write(scope, journal);
      localStorage.removeItem(storageKey(scope));
      return;
    }
    localStorage.setItem(storageKey(scope), JSON.stringify(journal));
  },
});

export const setDesktopSendLiveTransportHealthy = (healthy: boolean): void => {
  if (healthy) {
    for (const controller of controllers.values()) void controller.flush();
  }
};

export const stageDesktopDeliveryFile = async (
  file: Blob,
  fileName = file instanceof File ? file.name : "attachment"
): Promise<DurableStagedAttachment> => {
  if (file.size < 1 || file.size > 200 * 1024 * 1024) {
    throw new Error("Attachment size is invalid.");
  }
  const normalizedName = fileName.trim();
  if (!normalizedName || normalizedName.length > 255) {
    throw new Error("Attachment name is invalid.");
  }
  const stagingId = crypto.randomUUID();
  const mimeType = file.type || "application/octet-stream";
  if (window.openteam?.files) {
    await window.openteam.files.stageDelivery({ stagingId, bytes: await file.arrayBuffer() });
  } else {
    ephemeralStages.set(stagingId, file);
  }
  const kind = attachmentAssetKind({ fileName: normalizedName, mimeType });
  return {
    stagingId,
    fileName: normalizedName,
    mimeType,
    byteSize: file.size,
    kind,
    ...(kind === "image"
      ? {
          previewUri: `openteam-staged://file/${stagingId}?mime=${encodeURIComponent(mimeType)}`,
        }
      : {}),
  };
};

export const discardDesktopDeliveryStages = async (
  attachments: readonly DurableStagedAttachment[]
): Promise<void> => {
  const ids = attachments.map(({ stagingId }) => stagingId);
  for (const id of ids) ephemeralStages.delete(id);
  if (ids.length > 0) await window.openteam?.files.discardDeliveryStages(ids);
};

const readDesktopDeliveryStage = async (attachment: DurableStagedAttachment): Promise<Blob> => {
  const ephemeral = ephemeralStages.get(attachment.stagingId);
  if (ephemeral) return ephemeral;
  let bytes: Uint8Array | undefined;
  try {
    bytes = await window.openteam?.files.readDeliveryStage(attachment.stagingId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/ENOENT|no such file|not found/i.test(message)) {
      throw Object.assign(cause instanceof Error ? cause : new Error(message), {
        code: "staged_attachment_missing",
        status: 422,
      });
    }
    throw cause;
  }
  if (!bytes) {
    throw Object.assign(new Error("The staged attachment is no longer available."), {
      code: "staged_attachment_missing",
      status: 422,
    });
  }
  return new Blob([Uint8Array.from(bytes).buffer], { type: attachment.mimeType });
};

const withAttachmentCommitDeadline = <T>(operation: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(
      () =>
        reject(
          Object.assign(new Error("Attachment upload timed out."), {
            code: "attachment_commit_timeout",
            status: 422,
          })
        ),
      ATTACHMENT_COMMIT_TIMEOUT_MS
    );
    void operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (cause) => {
        window.clearTimeout(timeout);
        reject(cause);
      }
    );
  });

const classifyError = (cause: unknown): "offline" | "ambiguous" | "fatal" => {
  if (cause instanceof InactiveDeliveryScopeError) return "offline";
  const disposition = classifyDurableSendError(cause);
  if (disposition === "offline") {
    transportDownUntilMs = Date.now() + 5_000;
    refreshTransportSnapshot();
  }
  return disposition;
};

const resolveAcceptance = async (record: DurableSendRecord): Promise<MessageDeliveryAcceptance> => {
  const status = await api.messageDeliveryStatus(record.target.channelId, record.nonce);
  transportDownUntilMs = 0;
  refreshTransportSnapshot();
  return messageDeliveryAcceptance(status);
};

const dispatch = async (record: DurableSendRecord) => {
  const { payload, target } = record;
  const options = {
    ...(payload.richText ? { richText: payload.richText } : {}),
    ...(payload.isFork !== undefined ? { isFork: payload.isFork } : {}),
    clientId: record.nonce,
  };
  const accepted = target.conversationId
    ? await api.sendMessage(
        target.conversationId,
        payload.content,
        payload.attachments,
        payload.replyToMessageId,
        options
      )
    : await api.sendChannelMessage(
        target.channelId,
        payload.content,
        payload.attachments,
        payload.replyToMessageId,
        options
      );
  transportDownUntilMs = 0;
  refreshTransportSnapshot();
  window.dispatchEvent(new Event(DURABLE_SEND_ACCEPTED_EVENT));
  return { message: accepted.message };
};

const startLifecycle = (controller: DurableSendController) => {
  if (controllerCleanups.has(controller)) return;
  void controller.restore();
  const flush = () => void controller.flush();
  const noteTransportChange = () => {
    refreshTransportSnapshot();
    if (navigator.onLine !== false) flush();
  };
  window.addEventListener("online", noteTransportChange);
  window.addEventListener("offline", noteTransportChange);
  window.addEventListener("focus", flush);
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") flush();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const interval = window.setInterval(() => {
    refreshTransportSnapshot();
    void controller.expireAcknowledgements();
    if (navigator.onLine !== false) void controller.flush();
  }, 5_000);
  controllerCleanups.set(controller, () => {
    window.removeEventListener("online", noteTransportChange);
    window.removeEventListener("offline", noteTransportChange);
    window.removeEventListener("focus", flush);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearInterval(interval);
    controller.dispose();
  });
};

const disposeInactiveControllers = (activeScope: string) => {
  for (const [scope, controller] of controllers) {
    if (scope === activeScope) continue;
    controllerCleanups.get(controller)?.();
    controllerCleanups.delete(controller);
    controllers.delete(scope);
  }
};

subscribeAuthSnapshot(() => disposeInactiveControllers(accountScope()));

export const desktopDurableSendController = (): DurableSendController => {
  const scope = accountScope();
  disposeInactiveControllers(scope);
  const existing = controllers.get(scope);
  if (existing) return existing;
  const scopeIsActive = () => accountScope() === scope;
  const controller = createDurableSendController(scope, storageFor(scope), {
    dispatch: (record) => {
      if (!scopeIsActive()) throw new InactiveDeliveryScopeError("Delivery account changed");
      return dispatch(record);
    },
    resolveAcceptance: (record) => {
      if (!scopeIsActive()) throw new InactiveDeliveryScopeError("Delivery account changed");
      return resolveAcceptance(record);
    },
    classifyError,
    commitStagedAttachments: (record) =>
      withAttachmentCommitDeadline(
        mapWithConcurrency(
          record.payload.stagedAttachments ?? [],
          MAX_PARALLEL_UPLOADS,
          async (attachment) => {
            const file = await readDesktopDeliveryStage(attachment);
            const asset = await api.uploadAsset(file, attachment.fileName, attachment.mimeType);
            return attachment.alt ? { ...asset, alt: attachment.alt } : asset;
          }
        )
      ),
    discardStagedAttachments: discardDesktopDeliveryStages,
    isTransportDown: () => !scopeIsActive() || desktopSendTransportDown(),
    createNonce: () => crypto.randomUUID(),
    onTelemetry: (event) =>
      recordPerformance(`delivery.${event.outcome}`, event.ageMs, {
        channelId: event.channelId,
        attempts: event.attemptCount,
        attachments: event.attachmentCount,
        queued: event.queued,
        uncertain: event.uncertain ?? false,
        code: event.code ?? "",
      }),
  });
  controllers.set(scope, controller);
  startLifecycle(controller);
  return controller;
};
