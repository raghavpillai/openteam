import type {
  AssetKind,
  AssetRef,
  ChannelMessageView,
  MessageDeliveryStatusView,
} from "@openteam/contracts";
import { clientErrorMessage } from "./redaction";

export const DURABLE_SEND_SCHEMA_VERSION = 2;
const DURABLE_SEND_LEGACY_SCHEMA_VERSION = 1;
export const DURABLE_SEND_ACK_TIMEOUT_MS = 120_000;
export const DURABLE_SEND_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
export const DURABLE_SEND_SCOPE_MAX_LENGTH = 2_048;

/** Consecutive generations must alternate backup slots, regardless of wall-clock jumps. */
export const nextDurableSendJournalGeneration = (previous?: number, now = Date.now()): number => {
  const generation = previous === undefined ? now : previous + 1;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Durable message journal generation is invalid");
  }
  return generation;
};

/** A corruption/abuse guard, never a retention policy for live sends. */
export const DURABLE_SEND_MAX_RECORDS = 10_000;

export type DurableSendPhase =
  | "prepared"
  | "queued"
  | "dispatching"
  | "accepted-awaiting-echo"
  | "failed";

export type DurableSendFailureDisposition = "offline" | "ambiguous" | "fatal";

export interface DurableSendFailure {
  code: string;
  message: string;
  /** True when the server may have accepted the request despite the client-side failure. */
  uncertain: boolean;
}

export interface DurableSendTarget {
  channelId: string;
  conversationId: string | null;
}

export interface DurableSendPayload {
  content: string;
  attachments: AssetRef[];
  stagedAttachments?: DurableStagedAttachment[];
  consumedDraft?: { key: string; id: string };
  replyToMessageId?: string;
  richText?: string;
  isFork?: boolean;
}

/** A crash-safe local file owned by the platform delivery adapter. */
export interface DurableStagedAttachment {
  stagingId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  kind: AssetKind;
  /** Original position among already-uploaded and staged attachments. */
  position?: number;
  alt?: string;
  /** Optional local-only preview. Bytes are always resolved by stagingId. */
  previewUri?: string;
}

export interface DurableSendRecord {
  nonce: string;
  /** Stable resend family. Every replacement keeps this value and the complete nonce history. */
  lineageId: string;
  priorNonces: string[];
  /** SHA-256 over the complete currently durable payload and its destination. */
  promptDigest: string;
  target: DurableSendTarget;
  payload: DurableSendPayload;
  phase: DurableSendPhase;
  createdAtMs: number;
  updatedAtMs: number;
  attemptCount: number;
  dispatchStartedAtMs: number | null;
  queuedAtMs: number | null;
  acceptedAtMs: number | null;
  acceptedMessage: ChannelMessageView | null;
  failedAtMs: number | null;
  failure: DurableSendFailure | null;
}

export interface DurableSendJournal {
  schemaVersion: typeof DURABLE_SEND_SCHEMA_VERSION;
  scope: string;
  records: DurableSendRecord[];
}

export type MessageDeliveryAcceptance =
  | { status: "not_found" }
  | { status: "pending" }
  | { status: "rejected"; code?: string; message?: string }
  | { status: "unknown_durability" }
  | {
      status: "accepted";
      acceptedAtMs: number;
      message: ChannelMessageView;
    };

export interface DurableSendStorage {
  read: () => Promise<unknown>;
  write: (journal: DurableSendJournal) => Promise<void>;
}

export interface DurableSendRuntime {
  dispatch: (record: DurableSendRecord) => Promise<{ message: ChannelMessageView }>;
  resolveAcceptance: (record: DurableSendRecord) => Promise<MessageDeliveryAcceptance>;
  classifyError: (cause: unknown) => DurableSendFailureDisposition;
  commitStagedAttachments?: (record: DurableSendRecord) => Promise<AssetRef[]>;
  discardStagedAttachments?: (
    attachments: readonly DurableStagedAttachment[]
  ) => void | Promise<void>;
  isTransportDown?: () => boolean;
  createNonce?: () => string;
  now?: () => number;
  ackTimeoutMs?: number;
  onTelemetry?: (event: DurableSendTelemetryEvent) => void;
}

export type DurableSendTelemetryOutcome =
  | "enqueued"
  | "queued"
  | "dispatch-started"
  | "accepted"
  | "echo-reconciled"
  | "failed"
  | "resent"
  | "deleted"
  | "cancelled"
  | "restored";

export interface DurableSendTelemetryEvent {
  outcome: DurableSendTelemetryOutcome;
  nonce: string;
  lineageId: string;
  channelId: string;
  atMs: number;
  ageMs: number;
  attemptCount: number;
  attachmentCount: number;
  queued: boolean;
  uncertain?: boolean;
  code?: string;
  echoedNonce?: string;
}

export interface EnqueueDurableSendInput {
  nonce?: string;
  target: DurableSendTarget;
  payload: DurableSendPayload;
}

export interface DurableSendController {
  getSnapshot: () => readonly DurableSendRecord[];
  /** Pre-dispatch failures hidden from the timeline until their draft is restored. */
  getRecoverySnapshot: () => readonly DurableSendRecord[];
  subscribe: (listener: () => void) => () => void;
  restore: () => Promise<void>;
  enqueue: (input: EnqueueDurableSendInput) => Promise<DurableSendRecord>;
  flush: () => Promise<void>;
  reconcile: (authoritativeMessages: readonly ChannelMessageView[]) => Promise<void>;
  expireAcknowledgements: () => Promise<void>;
  resendFailed: (nonce: string) => Promise<DurableSendRecord | null>;
  deleteFailed: (nonce: string) => Promise<DurableSendPayload | null>;
  cancelQueued: (nonce: string) => Promise<DurableSendPayload | null>;
  acknowledgeRecovery: (nonce: string) => Promise<void>;
  dispose: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/** Small synchronous SHA-256 implementation so journal validation also works during restore. */
const sha256 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] as number;
      const right = words[index - 2] as number;
      const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = ((words[index - 16] as number) + s0 + (words[index - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        rotateRight(e as number, 6) ^ rotateRight(e as number, 11) ^ rotateRight(e as number, 25);
      const choice = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const temp1 = ((h as number) + sum1 + choice + constants[index]! + words[index]!) >>> 0;
      const sum0 =
        rotateRight(a as number, 2) ^ rotateRight(a as number, 13) ^ rotateRight(a as number, 22);
      const majority =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + (a as number)) >>> 0;
    hash[1] = (hash[1]! + (b as number)) >>> 0;
    hash[2] = (hash[2]! + (c as number)) >>> 0;
    hash[3] = (hash[3]! + (d as number)) >>> 0;
    hash[4] = (hash[4]! + (e as number)) >>> 0;
    hash[5] = (hash[5]! + (f as number)) >>> 0;
    hash[6] = (hash[6]! + (g as number)) >>> 0;
    hash[7] = (hash[7]! + (h as number)) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
};

/** Validate the account/server namespace used by platform journal stores. */
export const durableSendScope = (scope: unknown): string => {
  if (typeof scope !== "string" || !scope || scope.length > DURABLE_SEND_SCOPE_MAX_LENGTH) {
    throw new Error("Delivery journal scope is invalid");
  }
  return scope;
};

/** Stable, non-reversible account-scope key for platform journal filenames. */
export const durableSendScopeHash = (scope: string): string =>
  sha256(durableSendScope(scope)).slice(0, 32);

const legacyDurableSendPromptDigest = (
  payload: Pick<DurableSendPayload, "content" | "richText" | "replyToMessageId" | "isFork">
): string =>
  sha256(
    JSON.stringify({
      content: payload.content,
      richText: payload.richText ?? null,
      replyToMessageId: payload.replyToMessageId ?? null,
      isFork: payload.isFork ?? false,
    })
  );

type AuthoredAttachment = Pick<
  AssetRef | DurableStagedAttachment,
  "fileName" | "mimeType" | "byteSize" | "kind" | "alt"
> & { contentId: string };

const authoredAttachments = (
  payload: Pick<DurableSendPayload, "attachments" | "stagedAttachments">
): AuthoredAttachment[] => {
  const committed = payload.attachments.map(
    ({ assetId, fileName, mimeType, byteSize, kind, alt }) => ({
      contentId: assetId,
      fileName,
      mimeType,
      byteSize,
      kind,
      ...(alt ? { alt } : {}),
    })
  );
  const staged = (payload.stagedAttachments ?? []).map(
    ({ stagingId, fileName, mimeType, byteSize, kind, alt, position }) => ({
      attachment: {
        contentId: `staged:${stagingId}`,
        fileName,
        mimeType,
        byteSize,
        kind,
        ...(alt ? { alt } : {}),
      },
      position,
    })
  );
  if (staged.length === 0) return committed;
  const total = committed.length + staged.length;
  const positioned = staged.every(
    ({ position }) => position !== undefined && position >= 0 && position < total
  );
  if (!positioned || new Set(staged.map(({ position }) => position)).size !== staged.length) {
    return [...committed, ...staged.map(({ attachment }) => attachment)];
  }
  const result = new Array<AuthoredAttachment | undefined>(total);
  for (const { attachment, position } of staged) result[position as number] = attachment;
  let committedIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index]) result[index] = committed[committedIndex++];
  }
  return result.filter((attachment): attachment is AuthoredAttachment => Boolean(attachment));
};

/** Bind acknowledgement lineage to the complete authored send, including its destination/files. */
export const durableSendPromptDigest = (
  payload: Pick<DurableSendPayload, "content" | "richText" | "replyToMessageId" | "isFork"> &
    Partial<Pick<DurableSendPayload, "attachments" | "stagedAttachments">>,
  target?: DurableSendTarget
): string =>
  sha256(
    JSON.stringify({
      target: target
        ? { channelId: target.channelId, conversationId: target.conversationId }
        : null,
      content: payload.content,
      richText: payload.richText ?? null,
      replyToMessageId: payload.replyToMessageId ?? null,
      isFork: payload.isFork ?? false,
      attachments: authoredAttachments({
        attachments: payload.attachments ?? [],
        stagedAttachments: payload.stagedAttachments,
      }),
    })
  );

const acceptedMessagePromptDigest = (
  message: ChannelMessageView,
  target: DurableSendTarget
): string => {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const attachments = Array.isArray(metadata.attachments)
    ? metadata.attachments.filter(assetRef)
    : [];
  return durableSendPromptDigest(
    {
      content: message.content,
      attachments,
      ...(typeof metadata.richText === "string" ? { richText: metadata.richText } : {}),
      ...(typeof metadata.replyTo === "string" ? { replyToMessageId: metadata.replyTo } : {}),
      ...(metadata.branched === true ? { isFork: true } : {}),
    },
    target
  );
};

/** Classify transport failures without coupling clients to one concrete HTTP error class. */
export const classifyDurableSendError = (cause: unknown): DurableSendFailureDisposition => {
  if (!isRecord(cause)) return "ambiguous";
  const code = typeof cause.code === "string" ? cause.code : null;
  const status = typeof cause.status === "number" ? cause.status : null;
  if (code === null && status === null) return "ambiguous";
  if (code === "offline" || status === 0) return "offline";
  if (
    code === "request_in_progress" ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500)
  ) {
    return "ambiguous";
  }
  return "fatal";
};

/** Map the server delivery probe to the durable queue's platform-neutral result. */
export const messageDeliveryAcceptance = (
  status: MessageDeliveryStatusView
): MessageDeliveryAcceptance => {
  if (status.status === "accepted" && status.message) {
    return {
      status: "accepted",
      acceptedAtMs: status.acceptedAtMs ?? Date.parse(status.message.createdAt),
      message: status.message,
    };
  }
  if (status.status === "accepted") return { status: "unknown_durability" };
  if (status.status === "rejected") {
    return { status: "rejected", code: status.code, message: status.messageText };
  }
  return { status: status.status };
};

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const validNonce = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 8 && value.length <= 120;

const assetRef = (value: unknown): value is AssetRef => {
  if (!isRecord(value)) return false;
  return (
    typeof value.assetId === "string" &&
    /^[a-f0-9]{64}$/.test(value.assetId) &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    value.fileName.length <= 255 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length > 0 &&
    value.mimeType.length <= 120 &&
    finiteNumber(value.byteSize) &&
    Number.isSafeInteger(value.byteSize) &&
    value.byteSize > 0 &&
    value.byteSize <= 200 * 1024 * 1024 &&
    typeof value.kind === "string" &&
    assetKinds.has(value.kind as AssetKind) &&
    (value.width === undefined ||
      (finiteNumber(value.width) && Number.isSafeInteger(value.width) && value.width > 0)) &&
    (value.height === undefined ||
      (finiteNumber(value.height) && Number.isSafeInteger(value.height) && value.height > 0)) &&
    (value.alt === undefined || (typeof value.alt === "string" && value.alt.length <= 2_000))
  );
};

const assetKinds: ReadonlySet<AssetKind> = new Set([
  "image",
  "video",
  "audio",
  "pdf",
  "text",
  "file",
]);

const stagedAttachment = (value: unknown): value is DurableStagedAttachment => {
  if (!isRecord(value)) return false;
  return (
    typeof value.stagingId === "string" &&
    value.stagingId.length >= 8 &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    value.fileName.length <= 255 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length > 0 &&
    value.mimeType.length <= 120 &&
    finiteNumber(value.byteSize) &&
    Number.isSafeInteger(value.byteSize) &&
    value.byteSize > 0 &&
    value.byteSize <= 200 * 1024 * 1024 &&
    typeof value.kind === "string" &&
    assetKinds.has(value.kind as AssetKind) &&
    (value.position === undefined ||
      (finiteNumber(value.position) &&
        Number.isSafeInteger(value.position) &&
        value.position >= 0 &&
        value.position < 6)) &&
    (value.alt === undefined || (typeof value.alt === "string" && value.alt.length <= 2_000)) &&
    (value.previewUri === undefined ||
      (typeof value.previewUri === "string" && value.previewUri.length <= 8_192))
  );
};

const channelMessage = (value: unknown): value is ChannelMessageView => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sequence === "string" &&
    typeof value.channelId === "string" &&
    (value.sender === "user" || value.sender === "agent" || value.sender === "system") &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string"
  );
};

const phase = (value: unknown): value is DurableSendPhase =>
  value === "prepared" ||
  value === "queued" ||
  value === "dispatching" ||
  value === "accepted-awaiting-echo" ||
  value === "failed";

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const parsePayload = (value: unknown): DurableSendPayload | null => {
  if (!isRecord(value) || typeof value.content !== "string" || !Array.isArray(value.attachments)) {
    return null;
  }
  if (
    !value.attachments.every(assetRef) ||
    (value.stagedAttachments !== undefined &&
      (!Array.isArray(value.stagedAttachments) ||
        !value.stagedAttachments.every(stagedAttachment))) ||
    !optionalString(value.replyToMessageId) ||
    !optionalString(value.richText) ||
    (value.isFork !== undefined && typeof value.isFork !== "boolean") ||
    (value.consumedDraft !== undefined &&
      (!isRecord(value.consumedDraft) ||
        typeof value.consumedDraft.key !== "string" ||
        typeof value.consumedDraft.id !== "string" ||
        value.consumedDraft.key.length === 0 ||
        value.consumedDraft.id.length === 0))
  ) {
    return null;
  }
  const parsedAssets = value.attachments as AssetRef[];
  const parsedStaged = Array.isArray(value.stagedAttachments)
    ? (value.stagedAttachments as DurableStagedAttachment[])
    : [];
  const positioned = parsedStaged.flatMap(({ position }) =>
    position === undefined ? [] : [position]
  );
  if (
    parsedAssets.length + parsedStaged.length > 6 ||
    new Set(parsedStaged.map(({ stagingId }) => stagingId)).size !== parsedStaged.length ||
    new Set(positioned).size !== positioned.length ||
    positioned.some((position) => position >= parsedAssets.length + parsedStaged.length)
  ) {
    return null;
  }
  return {
    content: value.content,
    attachments: parsedAssets.slice(0, 6),
    ...(parsedStaged.length > 0 ? { stagedAttachments: parsedStaged } : {}),
    ...(isRecord(value.consumedDraft)
      ? {
          consumedDraft: {
            key: value.consumedDraft.key as string,
            id: value.consumedDraft.id as string,
          },
        }
      : {}),
    ...(typeof value.replyToMessageId === "string"
      ? { replyToMessageId: value.replyToMessageId }
      : {}),
    ...(typeof value.richText === "string" ? { richText: value.richText } : {}),
    ...(typeof value.isFork === "boolean" ? { isFork: value.isFork } : {}),
  };
};

const parseFailure = (value: unknown): DurableSendFailure | null => {
  if (!isRecord(value)) return null;
  return typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.uncertain === "boolean"
    ? { code: value.code, message: value.message, uncertain: value.uncertain }
    : null;
};

const lineageIdFor = (scope: string, nonce: string): string =>
  sha256(`${scope}\u0000${nonce}`).slice(0, 32);

const parseDurableSendRecord = (
  value: unknown,
  schemaVersion: number,
  scope: string
): DurableSendRecord | null => {
  if (!isRecord(value) || !isRecord(value.target)) return null;
  const payload = parsePayload(value.payload);
  if (
    !payload ||
    !validNonce(value.nonce) ||
    !Array.isArray(value.priorNonces) ||
    value.priorNonces.length > DURABLE_SEND_MAX_RECORDS ||
    !value.priorNonces.every(validNonce) ||
    typeof value.target.channelId !== "string" ||
    (value.target.conversationId !== null && typeof value.target.conversationId !== "string") ||
    !phase(value.phase) ||
    !finiteNumber(value.createdAtMs) ||
    !finiteNumber(value.updatedAtMs) ||
    !finiteNumber(value.attemptCount)
  ) {
    return null;
  }
  const nullableNumber = (candidate: unknown) => candidate === null || finiteNumber(candidate);
  if (
    !nullableNumber(value.dispatchStartedAtMs) ||
    !nullableNumber(value.queuedAtMs) ||
    !nullableNumber(value.acceptedAtMs) ||
    !nullableNumber(value.failedAtMs) ||
    (value.acceptedMessage !== null && !channelMessage(value.acceptedMessage)) ||
    (value.failure !== null && !parseFailure(value.failure))
  ) {
    return null;
  }
  const priorNonces = [...value.priorNonces] as string[];
  const uniquePriorNonces = new Set(priorNonces);
  const target = {
    channelId: value.target.channelId as string,
    conversationId: value.target.conversationId as string | null,
  };
  const expectedPromptDigest = durableSendPromptDigest(payload, target);
  const legacyPromptDigest = legacyDurableSendPromptDigest(payload);
  const promptDigestIsValid =
    schemaVersion === DURABLE_SEND_LEGACY_SCHEMA_VERSION
      ? value.promptDigest === undefined ||
        value.promptDigest === expectedPromptDigest ||
        value.promptDigest === legacyPromptDigest
      : value.promptDigest === expectedPromptDigest;
  const acceptedMessage = value.acceptedMessage as ChannelMessageView | null;
  const parsedFailure = value.failure === null ? null : parseFailure(value.failure);
  const acceptedMessageIsValid =
    acceptedMessage === null ||
    (acceptedMessage.channelId === target.channelId &&
      acceptedMessagePromptDigest(acceptedMessage, target) === expectedPromptDigest);
  const phaseStateIsValid =
    value.phase === "accepted-awaiting-echo"
      ? acceptedMessage !== null && value.acceptedAtMs !== null && parsedFailure === null
      : value.phase === "failed"
        ? parsedFailure !== null && value.failedAtMs !== null
        : acceptedMessage === null &&
          value.acceptedAtMs === null &&
          parsedFailure === null &&
          value.failedAtMs === null;
  const lineageId =
    typeof value.lineageId === "string" && /^[a-f0-9]{32}$/.test(value.lineageId)
      ? value.lineageId
      : schemaVersion === DURABLE_SEND_LEGACY_SCHEMA_VERSION
        ? lineageIdFor(scope, priorNonces[0] ?? (value.nonce as string))
        : null;
  if (
    lineageId === null ||
    uniquePriorNonces.size !== priorNonces.length ||
    priorNonces.some((nonce) => nonce === value.nonce) ||
    !promptDigestIsValid ||
    !acceptedMessageIsValid ||
    !phaseStateIsValid
  ) {
    return null;
  }
  return {
    nonce: value.nonce,
    lineageId,
    priorNonces,
    // Journals created before prompt digests are migrated in memory and write
    // the digest on their next state transition.
    promptDigest: expectedPromptDigest,
    target,
    payload,
    phase: value.phase,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    attemptCount: Math.max(0, Math.trunc(value.attemptCount)),
    dispatchStartedAtMs: value.dispatchStartedAtMs,
    queuedAtMs: value.queuedAtMs,
    acceptedAtMs: value.acceptedAtMs,
    acceptedMessage,
    failedAtMs: value.failedAtMs,
    failure: parsedFailure,
  };
};

export const parseDurableSendJournal = (
  value: unknown,
  expectedScope: string
): DurableSendJournal => {
  if (
    !isRecord(value) ||
    ![DURABLE_SEND_LEGACY_SCHEMA_VERSION, DURABLE_SEND_SCHEMA_VERSION].includes(
      Number(value.schemaVersion)
    ) ||
    value.scope !== expectedScope ||
    !Array.isArray(value.records) ||
    value.records.length > DURABLE_SEND_MAX_RECORDS
  ) {
    return { schemaVersion: DURABLE_SEND_SCHEMA_VERSION, scope: expectedScope, records: [] };
  }
  const byNonce = new Map<string, DurableSendRecord>();
  const claimedNonces = new Set<string>();
  const lineageIds = new Set<string>();
  for (const candidate of value.records) {
    const parsed = parseDurableSendRecord(candidate, Number(value.schemaVersion), expectedScope);
    // Grok treats a partially corrupt journal as corrupt. Keeping only the
    // parseable subset can violate ordering or resend a nonce without its owner.
    if (
      !parsed ||
      byNonce.has(parsed.nonce) ||
      lineageIds.has(parsed.lineageId) ||
      [parsed.nonce, ...parsed.priorNonces].some((nonce) => claimedNonces.has(nonce))
    ) {
      return { schemaVersion: DURABLE_SEND_SCHEMA_VERSION, scope: expectedScope, records: [] };
    }
    byNonce.set(parsed.nonce, parsed);
    lineageIds.add(parsed.lineageId);
    for (const nonce of [parsed.nonce, ...parsed.priorNonces]) claimedNonces.add(nonce);
  }
  return {
    schemaVersion: DURABLE_SEND_SCHEMA_VERSION,
    scope: expectedScope,
    records: [...byNonce.values()].sort(
      (left, right) => left.createdAtMs - right.createdAtMs || left.nonce.localeCompare(right.nonce)
    ),
  };
};

export const durableSendIsInFlight = (record: DurableSendRecord): boolean =>
  record.phase === "prepared" || record.phase === "queued" || record.phase === "dispatching";

export const durableSendRenderKey = (record: Pick<DurableSendRecord, "nonce">): string =>
  `optimistic:${record.nonce}`;

export const durableSendVisualState = (
  record: DurableSendRecord
): "pending" | "queued" | "accepted" | "failed" => {
  if (record.phase === "failed") return "failed";
  if (record.phase === "queued") return "queued";
  if (record.phase === "accepted-awaiting-echo") return "accepted";
  return "pending";
};

export const durableSendStatusLabel = (
  phase: DurableSendPhase,
  transportDown = false
): string | null => {
  if (phase === "queued") {
    return transportDown ? "Will send when reconnected" : "Waiting to send…";
  }
  if (phase === "failed") return "Failed to send";
  return null;
};

export const durableSendMessage = (record: DurableSendRecord): ChannelMessageView =>
  record.acceptedMessage ?? {
    id: durableSendRenderKey(record),
    clientId: record.nonce,
    sequence: `optimistic:${record.createdAtMs}:${record.nonce}`,
    channelId: record.target.channelId,
    sender: "user",
    senderBotId: null,
    sourceRunId: null,
    content: record.payload.content,
    metadata: {
      type: "text",
      ...(record.payload.attachments.length ? { attachments: record.payload.attachments } : {}),
      ...(record.payload.stagedAttachments?.length
        ? { clientStagedAttachments: record.payload.stagedAttachments }
        : {}),
      ...(record.payload.replyToMessageId ? { replyTo: record.payload.replyToMessageId } : {}),
      ...(record.payload.richText ? { richText: record.payload.richText } : {}),
      ...(record.payload.isFork ? { branched: true } : {}),
    },
    createdAt: new Date(record.createdAtMs).toISOString(),
  };

/** Resolve a transcript echo even when the direct send response was lost or is still pending. */
export const durableSendAuthoritativeEcho = (
  record: DurableSendRecord,
  authoritativeMessages: readonly ChannelMessageView[]
): ChannelMessageView | null => {
  const lineage = new Set([record.nonce, ...record.priorNonces]);
  const byNonce = authoritativeMessages.find(
    (message) =>
      message.channelId === record.target.channelId &&
      typeof message.clientId === "string" &&
      lineage.has(message.clientId)
  );
  const byAcceptedId = record.acceptedMessage
    ? authoritativeMessages.find((message) => message.id === record.acceptedMessage?.id)
    : undefined;
  const authoritative = byNonce ?? byAcceptedId;
  if (!authoritative) return null;
  return acceptedMessagePromptDigest(authoritative, record.target) === record.promptDigest
    ? authoritative
    : null;
};

/** Index one immutable transcript for a batch, preserving the legacy first-match semantics. */
export const createDurableSendEchoResolver = (
  messages: readonly ChannelMessageView[],
  expectedLookups: number
): ((record: DurableSendRecord) => ChannelMessageView | null) => {
  // Building an index costs more than a few short scans for the normal one-send case.
  if (expectedLookups < 5 || messages.length < 32) {
    return (record) => durableSendAuthoritativeEcho(record, messages);
  }
  type Match = { message: ChannelMessageView; order: number };
  const byChannel = new Map<string, Map<string, Match>>();
  const byId = new Map<string, ChannelMessageView>();
  for (let order = 0; order < messages.length; order += 1) {
    const message = messages[order]!;
    if (!byId.has(message.id)) byId.set(message.id, message);
    if (typeof message.clientId !== "string") continue;
    let nonces = byChannel.get(message.channelId);
    if (!nonces) {
      nonces = new Map();
      byChannel.set(message.channelId, nonces);
    }
    if (!nonces.has(message.clientId)) nonces.set(message.clientId, { message, order });
  }
  return (record) => {
    const nonces = byChannel.get(record.target.channelId);
    let first = nonces?.get(record.nonce);
    for (const nonce of record.priorNonces) {
      const match = nonces?.get(nonce);
      if (match && (!first || match.order < first.order)) first = match;
    }
    const authoritative =
      first?.message ?? (record.acceptedMessage ? byId.get(record.acceptedMessage.id) : undefined);
    return authoritative &&
      acceptedMessagePromptDigest(authoritative, record.target) === record.promptDigest
      ? authoritative
      : null;
  };
};

const fallbackNonce = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const errorMessage = (cause: unknown): string =>
  clientErrorMessage(cause, "Message delivery failed");

const failureCode = (cause: unknown): string => {
  if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  return "send_failed";
};

const mergeCommittedAttachments = (
  existing: readonly AssetRef[],
  staged: readonly DurableStagedAttachment[],
  committed: readonly AssetRef[]
): AssetRef[] => {
  const total = existing.length + committed.length;
  const positioned = staged.every(
    (attachment) =>
      attachment.position !== undefined && attachment.position >= 0 && attachment.position < total
  );
  if (!positioned || new Set(staged.map(({ position }) => position)).size !== staged.length) {
    return [...existing, ...committed];
  }
  const result = new Array<AssetRef | undefined>(total);
  staged.forEach((attachment, index) => {
    result[attachment.position as number] = committed[index];
  });
  let existingIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index]) result[index] = existing[existingIndex++];
  }
  return result.filter((attachment): attachment is AssetRef => Boolean(attachment));
};

export const createDurableSendController = (
  scope: string,
  storage: DurableSendStorage,
  runtime: DurableSendRuntime
): DurableSendController => {
  const now = runtime.now ?? Date.now;
  const createNonce = runtime.createNonce ?? fallbackNonce;
  const ackTimeoutMs = runtime.ackTimeoutMs ?? DURABLE_SEND_ACK_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  const records = new Map<string, DurableSendRecord>();
  const inFlight = new Map<string, Promise<void>>();
  let snapshot: readonly DurableSendRecord[] = [];
  let visibleSnapshot: readonly DurableSendRecord[] = [];
  let recoverySnapshot: readonly DurableSendRecord[] = [];
  let restored = false;
  let restoreRequest: Promise<void> | null = null;
  let writeTail: Promise<void> = Promise.resolve();
  let persistenceRetry: ReturnType<typeof setTimeout> | null = null;
  let flushRequest: Promise<void> | null = null;
  let flushAgain = false;
  let disposed = false;

  const emit = (
    record: DurableSendRecord,
    outcome: DurableSendTelemetryOutcome,
    detail: Pick<DurableSendTelemetryEvent, "uncertain" | "code" | "echoedNonce"> = {}
  ) => {
    if (!runtime.onTelemetry) return;
    const atMs = now();
    try {
      runtime.onTelemetry({
        outcome,
        nonce: record.nonce,
        lineageId: record.lineageId,
        channelId: record.target.channelId,
        atMs,
        ageMs: Math.max(0, atMs - record.createdAtMs),
        attemptCount: record.attemptCount,
        attachmentCount:
          record.payload.attachments.length + (record.payload.stagedAttachments?.length ?? 0),
        queued: record.phase === "queued" || record.queuedAtMs !== null,
        ...detail,
      });
    } catch {
      // Diagnostics must never alter delivery state.
    }
  };

  const publish = () => {
    snapshot = [...records.values()].sort(
      (left, right) => left.createdAtMs - right.createdAtMs || left.nonce.localeCompare(right.nonce)
    );
    recoverySnapshot = snapshot.filter(
      (record) =>
        record.phase === "failed" &&
        record.failure?.uncertain === false &&
        record.attemptCount === 0
    );
    const recoveryNonces = new Set(recoverySnapshot.map((record) => record.nonce));
    visibleSnapshot = snapshot.filter((record) => !recoveryNonces.has(record.nonce));
    for (const listener of listeners) listener();
  };

  const journal = (): DurableSendJournal => ({
    schemaVersion: DURABLE_SEND_SCHEMA_VERSION,
    scope,
    records: snapshot.map((record) => ({ ...record })),
  });

  const persist = (): Promise<void> => {
    const value = journal();
    const next = writeTail.catch(() => undefined).then(() => storage.write(value));
    writeTail = next;
    return next;
  };

  const persistEventually = (): void => {
    if (disposed || persistenceRetry !== null) return;
    persistenceRetry = setTimeout(() => {
      persistenceRetry = null;
      if (!disposed) void persist().catch(() => persistEventually());
    }, 1_000);
  };

  const replace = (record: DurableSendRecord) => {
    records.set(record.nonce, record);
    publish();
    return record;
  };

  const remove = (nonce: string) => {
    if (!records.delete(nonce)) return false;
    publish();
    return true;
  };

  const accepted = async (
    record: DurableSendRecord,
    message: ChannelMessageView,
    acceptedAtMs = now()
  ) => {
    const current = records.get(record.nonce);
    if (!current) return;
    if (acceptedMessagePromptDigest(message, current.target) !== current.promptDigest) {
      await fail(current, {
        code: "delivery_digest_mismatch",
        message: "The server acknowledgement did not match this message.",
        uncertain: false,
      });
      return;
    }
    const next = replace({
      ...current,
      phase: "accepted-awaiting-echo",
      updatedAtMs: now(),
      acceptedAtMs,
      acceptedMessage: message,
      failedAtMs: null,
      failure: null,
    });
    emit(next, "accepted");
    await persist().catch(() => persistEventually());
  };

  const fail = async (record: DurableSendRecord, failure: DurableSendFailure): Promise<void> => {
    const current = records.get(record.nonce);
    if (!current) return;
    const failedAtMs = now();
    const next = replace({
      ...current,
      phase: "failed",
      updatedAtMs: failedAtMs,
      failedAtMs,
      failure,
    });
    emit(next, "failed", { uncertain: failure.uncertain, code: failure.code });
    await persist().catch(() => persistEventually());
  };

  const queue = async (record: DurableSendRecord, markComposedOffline = false): Promise<void> => {
    const current = records.get(record.nonce);
    if (!current) return;
    // queuedAtMs is specifically the offline-composition marker used by
    // “Sent while offline”, not a generic time spent behind another send.
    const next = replace({
      ...current,
      phase: "queued",
      updatedAtMs: now(),
      queuedAtMs:
        current.queuedAtMs ??
        (markComposedOffline && current.attemptCount === 0 ? current.createdAtMs : null),
      failedAtMs: null,
      failure: null,
    });
    if (current.phase !== "queued") emit(next, "queued");
    await persist().catch(() => persistEventually());
  };

  const resolve = async (record: DurableSendRecord): Promise<MessageDeliveryAcceptance | null> => {
    try {
      return await runtime.resolveAcceptance(record);
    } catch {
      return null;
    }
  };

  const resolveLineage = async (
    record: DurableSendRecord
  ): Promise<MessageDeliveryAcceptance | null> => {
    let priorIsUncertain = false;
    for (const nonce of [...record.priorNonces].reverse()) {
      const resolution = await resolve({ ...record, nonce });
      if (!resolution) {
        priorIsUncertain = true;
        continue;
      }
      if (resolution.status === "accepted") return resolution;
      if (resolution.status === "pending" || resolution.status === "unknown_durability") {
        priorIsUncertain = true;
      }
    }
    const current = await resolve(record);
    if (!current) return null;
    if (priorIsUncertain && (current.status === "not_found" || current.status === "rejected")) {
      return { status: "unknown_durability" };
    }
    return current;
  };

  const applyResolution = async (
    record: DurableSendRecord,
    resolution: MessageDeliveryAcceptance
  ): Promise<"accepted" | "failed" | "wait" | "not_found"> => {
    if (resolution.status === "accepted") {
      await accepted(record, resolution.message, resolution.acceptedAtMs);
      return "accepted";
    }
    if (resolution.status === "rejected") {
      await fail(record, {
        code: resolution.code ?? "server_rejected",
        message: resolution.message ?? "The server rejected this message.",
        uncertain: false,
      });
      return "failed";
    }
    if (resolution.status === "not_found") return "not_found";
    return "wait";
  };

  const dispatchRecord = (record: DurableSendRecord): Promise<void> => {
    const existing = inFlight.get(record.nonce);
    if (existing) return existing;
    const task = (async () => {
      let current = records.get(record.nonce);
      if (!current || current.phase === "accepted-awaiting-echo" || current.phase === "failed") {
        return;
      }
      const staged = current.payload.stagedAttachments ?? [];
      if (staged.length > 0) {
        if (!runtime.commitStagedAttachments) {
          await fail(current, {
            code: "attachment_staging_unavailable",
            message: "This device cannot finish uploading the staged attachments.",
            uncertain: false,
          });
          return;
        }
        let committed: AssetRef[];
        try {
          committed = await runtime.commitStagedAttachments(current);
          if (committed.length !== staged.length || !committed.every(assetRef)) {
            throw Object.assign(new Error("The attachment commit returned an invalid result."), {
              code: "attachment_commit_invalid",
              status: 422,
            });
          }
        } catch (cause) {
          const disposition = runtime.classifyError(cause);
          if (disposition === "fatal") {
            await fail(current, {
              code: failureCode(cause),
              message: errorMessage(cause),
              uncertain: false,
            });
          } else {
            // Grok marks an initially-online composition as offline when the
            // first attachment commit is where transport loss is discovered.
            await queue(current, disposition === "offline");
          }
          return;
        }
        const beforeCommit = current;
        const committedPayload: DurableSendPayload = {
          ...current.payload,
          attachments: mergeCommittedAttachments(current.payload.attachments, staged, committed),
          stagedAttachments: [],
        };
        const prepared = replace({
          ...current,
          promptDigest: durableSendPromptDigest(committedPayload, current.target),
          payload: committedPayload,
          phase: "prepared",
          updatedAtMs: now(),
        });
        try {
          await persist();
        } catch {
          replace(beforeCommit);
          persistEventually();
          return;
        }
        current = prepared;
        try {
          await runtime.discardStagedAttachments?.(staged);
        } catch {
          // The server now owns the bytes and the journal no longer references
          // them. Platform garbage collection can safely retry this cleanup.
        }
      }
      const startedAtMs = now();
      const dispatching = replace({
        ...current,
        phase: "dispatching",
        updatedAtMs: startedAtMs,
        dispatchStartedAtMs: startedAtMs,
        attemptCount: current.attemptCount + 1,
      });
      emit(dispatching, "dispatch-started");
      try {
        await persist();
      } catch (cause) {
        const latest = records.get(dispatching.nonce);
        if (latest === dispatching) replace(current);
        persistEventually();
        return;
      }
      try {
        const result = await runtime.dispatch(dispatching);
        await accepted(dispatching, result.message);
      } catch (cause) {
        const latest = records.get(dispatching.nonce);
        if (!latest) return;
        const disposition = runtime.classifyError(cause);
        if (disposition === "fatal") {
          await fail(latest, {
            code: failureCode(cause),
            message: errorMessage(cause),
            uncertain: false,
          });
          return;
        }
        const resolution = await resolveLineage(latest);
        if (resolution) {
          const outcome = await applyResolution(latest, resolution);
          if (outcome !== "not_found" && outcome !== "wait") return;
        }
        await queue(latest);
      }
    })().finally(() => {
      inFlight.delete(record.nonce);
      const latest = records.get(record.nonce);
      if (!latest || latest.phase === "accepted-awaiting-echo" || latest.phase === "failed") {
        void controller.flush();
      }
    });
    inFlight.set(record.nonce, task);
    return task;
  };

  const restore = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (restored) return Promise.resolve();
    if (restoreRequest) return restoreRequest;
    restoreRequest = (async () => {
      const parsed = parseDurableSendJournal(await storage.read().catch(() => null), scope);
      records.clear();
      for (const record of parsed.records) records.set(record.nonce, record);
      restored = true;
      publish();
      for (const record of parsed.records) emit(record, "restored");
      // Painting restored optimistic rows must not wait for a slow network
      // request, and one stalled conversation must not block composing another.
      void controller.flush();
    })().finally(() => {
      restoreRequest = null;
    });
    return restoreRequest;
  };

  const controller: DurableSendController = {
    getSnapshot: () => visibleSnapshot,
    getRecoverySnapshot: () => recoverySnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restore,
    async enqueue(input) {
      if (disposed) throw new Error("Durable delivery controller is disposed");
      await restore();
      const createdAtMs = now();
      const nonce = input.nonce ?? createNonce();
      if (
        !validNonce(nonce) ||
        snapshot.some(
          (candidate) => candidate.nonce === nonce || candidate.priorNonces.includes(nonce)
        )
      ) {
        throw new Error("Durable delivery nonce is invalid or already in use");
      }
      const heldForEarlierSend = snapshot.some(
        (candidate) =>
          candidate.target.channelId === input.target.channelId &&
          candidate.phase !== "accepted-awaiting-echo" &&
          candidate.phase !== "failed"
      );
      const startsQueued = runtime.isTransportDown?.() === true || heldForEarlierSend;
      const startsOffline = runtime.isTransportDown?.() === true;
      const record: DurableSendRecord = {
        nonce,
        lineageId: lineageIdFor(scope, nonce),
        priorNonces: [],
        promptDigest: durableSendPromptDigest(input.payload, input.target),
        target: input.target,
        payload: {
          ...input.payload,
          attachments: [...input.payload.attachments],
          ...(input.payload.stagedAttachments
            ? { stagedAttachments: [...input.payload.stagedAttachments] }
            : {}),
        },
        phase: startsQueued ? "queued" : "prepared",
        createdAtMs,
        updatedAtMs: createdAtMs,
        attemptCount: 0,
        dispatchStartedAtMs: null,
        queuedAtMs: startsOffline ? createdAtMs : null,
        acceptedAtMs: null,
        acceptedMessage: null,
        failedAtMs: null,
        failure: null,
      };
      replace(record);
      emit(record, "enqueued");
      try {
        await persist();
      } catch (cause) {
        remove(nonce);
        throw cause;
      }
      if (!startsQueued) void dispatchRecord(record);
      return record;
    },
    flush() {
      if (disposed) return Promise.resolve();
      if (flushRequest) {
        flushAgain = true;
        return flushRequest;
      }
      flushRequest = (async () => {
        if (!restored) {
          await restore();
        }
        do {
          flushAgain = false;
          const channelIds = [
            ...new Set(
              snapshot
                .filter(
                  (record) => record.phase !== "failed" && record.phase !== "accepted-awaiting-echo"
                )
                .map((record) => record.target.channelId)
            ),
          ];
          await Promise.all(
            channelIds.map(async (channelId) => {
              const channelRecords = [...snapshot].filter(
                (record) => record.target.channelId === channelId
              );
              for (const candidate of channelRecords) {
                const record = records.get(candidate.nonce);
                if (
                  !record ||
                  record.phase === "failed" ||
                  record.phase === "accepted-awaiting-echo"
                ) {
                  continue;
                }
                const transportDown = runtime.isTransportDown?.() === true;
                if (transportDown) {
                  if (record.phase !== "queued") await queue(record);
                  break;
                }
                const resolution = await resolveLineage(record);
                if (resolution) {
                  const outcome = await applyResolution(record, resolution);
                  if (outcome === "accepted" || outcome === "failed") continue;
                  if (outcome === "wait") break;
                }
                await dispatchRecord(record);
                const latest = records.get(record.nonce);
                if (latest?.phase === "queued" || latest?.phase === "dispatching") break;
              }
            })
          );
        } while (flushAgain);
      })().finally(() => {
        flushRequest = null;
      });
      return flushRequest;
    },
    async reconcile(authoritativeMessages) {
      if (disposed || authoritativeMessages.length === 0) return;
      const authoritativeById = new Map(
        authoritativeMessages.map((message) => [message.id, message] as const)
      );
      const authoritativeByNonce = new Map(
        authoritativeMessages.flatMap((message) =>
          typeof message.clientId === "string" ? [[message.clientId, message] as const] : []
        )
      );
      let changed = false;
      for (const record of snapshot) {
        const echoed = [record.nonce, ...record.priorNonces]
          .map((nonce) => authoritativeByNonce.get(nonce))
          .find((message) => message?.channelId === record.target.channelId);
        const acceptedEcho =
          record.phase === "accepted-awaiting-echo" &&
          record.acceptedMessage &&
          authoritativeById.has(record.acceptedMessage.id)
            ? authoritativeById.get(record.acceptedMessage.id)
            : undefined;
        const authoritative = echoed ?? acceptedEcho;
        if (!authoritative) continue;
        if (acceptedMessagePromptDigest(authoritative, record.target) !== record.promptDigest) {
          await fail(record, {
            code: "delivery_digest_mismatch",
            message: "The transcript acknowledgement did not match this message.",
            uncertain: false,
          });
          continue;
        }
        records.delete(record.nonce);
        emit(record, "echo-reconciled", {
          ...(echoed?.clientId ? { echoedNonce: echoed.clientId } : {}),
        });
        changed = true;
      }
      if (!changed) return;
      publish();
      // The transcript is authoritative. Never repaint a duplicate merely
      // because local cleanup persistence needs to retry.
      await persist().catch(() => persistEventually());
      void controller.flush();
    },
    async expireAcknowledgements() {
      if (disposed) return;
      const currentTime = now();
      for (const record of [...snapshot]) {
        if (
          record.phase === "queued" ||
          record.phase === "failed" ||
          record.dispatchStartedAtMs === null ||
          currentTime - record.dispatchStartedAtMs < ackTimeoutMs
        ) {
          continue;
        }
        if (runtime.isTransportDown?.() === true) {
          replace({ ...record, updatedAtMs: currentTime, dispatchStartedAtMs: currentTime });
          await persist().catch(() => persistEventually());
          continue;
        }
        const resolution = await resolveLineage(record);
        if (resolution) {
          const outcome = await applyResolution(record, resolution);
          if (outcome === "accepted" || outcome === "failed" || outcome === "wait") continue;
        }
        await fail(record, {
          code: "ack_expired",
          message: "The server did not confirm this message in time.",
          uncertain: true,
        });
      }
    },
    async resendFailed(nonce) {
      if (disposed) return null;
      await restore();
      const failedRecord = records.get(nonce);
      if (!failedRecord || failedRecord.phase !== "failed") return null;
      if (failedRecord.failure?.uncertain) {
        const resolution = await resolveLineage(failedRecord);
        if (
          !resolution ||
          resolution.status === "pending" ||
          resolution.status === "unknown_durability"
        ) {
          return null;
        }
        const outcome = await applyResolution(failedRecord, resolution);
        if (outcome === "accepted") return records.get(nonce) ?? null;
      }
      const currentFailed = records.get(nonce);
      if (!currentFailed || currentFailed.phase !== "failed") return null;
      const createdAtMs = now();
      const freshNonce = createNonce();
      if (
        !validNonce(freshNonce) ||
        freshNonce === currentFailed.nonce ||
        currentFailed.priorNonces.includes(freshNonce) ||
        snapshot.some(
          (candidate) =>
            candidate.nonce === freshNonce || candidate.priorNonces.includes(freshNonce)
        )
      ) {
        throw new Error("Durable delivery nonce is invalid or already in use");
      }
      const fresh: DurableSendRecord = {
        ...currentFailed,
        nonce: freshNonce,
        priorNonces: [...currentFailed.priorNonces, currentFailed.nonce],
        phase: runtime.isTransportDown?.() === true ? "queued" : "prepared",
        createdAtMs,
        updatedAtMs: createdAtMs,
        attemptCount: 0,
        dispatchStartedAtMs: null,
        queuedAtMs: runtime.isTransportDown?.() === true ? createdAtMs : currentFailed.queuedAtMs,
        acceptedAtMs: null,
        acceptedMessage: null,
        failedAtMs: null,
        failure: null,
      };
      records.delete(currentFailed.nonce);
      records.set(fresh.nonce, fresh);
      publish();
      emit(fresh, "resent");
      try {
        await persist();
      } catch (cause) {
        records.delete(fresh.nonce);
        records.set(currentFailed.nonce, currentFailed);
        publish();
        throw cause;
      }
      if (fresh.phase !== "queued") void dispatchRecord(fresh);
      return fresh;
    },
    async deleteFailed(nonce) {
      if (disposed) return null;
      await restore();
      const record = records.get(nonce);
      if (!record || record.phase !== "failed") return null;
      remove(nonce);
      try {
        await persist();
      } catch (cause) {
        replace(record);
        throw cause;
      }
      try {
        await runtime.discardStagedAttachments?.(record.payload.stagedAttachments ?? []);
      } catch {
        // The failed send is already durably deleted. Platform cleanup may retry.
      }
      emit(record, "deleted");
      return record.payload;
    },
    async cancelQueued(nonce) {
      if (disposed) return null;
      await restore();
      const record = records.get(nonce);
      if (!record || record.phase !== "queued") return null;
      if (record.attemptCount > 0) {
        const resolution = await resolveLineage(record);
        if (!resolution) return null;
        const outcome = await applyResolution(record, resolution);
        if (outcome !== "not_found" && outcome !== "failed") return null;
      }
      const current = records.get(nonce);
      if (!current || current.phase !== "queued") return null;
      remove(nonce);
      try {
        await persist();
      } catch (cause) {
        replace(current);
        throw cause;
      }
      void controller.flush();
      emit(current, "cancelled");
      return current.payload;
    },
    async acknowledgeRecovery(nonce) {
      if (disposed) return;
      await restore();
      const record = records.get(nonce);
      if (!record || record.phase !== "failed" || record.failure?.uncertain !== false) {
        return;
      }
      const recoveredStages = record.payload.stagedAttachments ?? [];
      remove(nonce);
      // The composer calls this only after a replacement send has itself been
      // journaled. Keep the acknowledged recovery removed in memory and retry
      // its storage mutation instead of surfacing a duplicate draft.
      await persist().catch(() => persistEventually());
      const retainedStageIds = new Set(
        snapshot.flatMap((candidate) =>
          (candidate.payload.stagedAttachments ?? []).map(({ stagingId }) => stagingId)
        )
      );
      const orphanedStages = recoveredStages.filter(
        ({ stagingId }) => !retainedStageIds.has(stagingId)
      );
      if (orphanedStages.length > 0) {
        try {
          await runtime.discardStagedAttachments?.(orphanedStages);
        } catch {
          // The recovery no longer owns these bytes; platform cleanup may retry.
        }
      }
      void controller.flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      flushAgain = false;
      if (persistenceRetry !== null) {
        clearTimeout(persistenceRetry);
        persistenceRetry = null;
      }
      listeners.clear();
    },
  };

  return controller;
};
