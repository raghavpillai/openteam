/** A SendIMessage request as the approval card and the Mac both see it. */
export interface MessagesSend {
  text: string;
  to?: string;
  chatId?: string;
  service?: "auto" | "iMessage" | "SMS";
  recipientName?: string;
}

// Recent macOS stores chats under a service-neutral `any;` GUID; older ones name the service.
const CHAT_GUID = /^(?:any|iMessage|SMS|RCS);([+-]);[^\r\n\0]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const SENDABLE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
const SENDABLE_CHAT_ID = /^[A-Za-z0-9._@;+-]+$/;
const RECIPIENT_NAME_MAX_CHARS = 80;
const HIDDEN_NAME_CHARS = /[\u00AD\u061C\u115F\u1160\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\u2800\u3164\uFEFF\uFFA0]/gu;

/** A display name the card can show: no hidden characters or line breaks, at most 80 characters. */
export function boundedRecipientName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const bounded = name.replace(HIDDEN_NAME_CHARS, "").replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, RECIPIENT_NAME_MAX_CHARS);
  return bounded || undefined;
}

export function validateMessageSend(args: Record<string, any>): MessagesSend {
  if (typeof args.text !== "string" || args.text.length === 0) throw new Error("text is required");
  if (args.to !== undefined && args.chatId !== undefined) throw new Error("Pass either `to` or `chatId`, not both.");
  if (!args.to && !args.chatId) throw new Error("Pass `to` (an E.164 number or email) or `chatId` (a chat guid from FindIMessageChats).");
  if (args.to && (typeof args.to !== "string" || !(E164.test(args.to) || SENDABLE_EMAIL.test(args.to))))
    throw new Error("Pass one E.164 number (+15555550100) or one email, with no spaces or hidden characters. Get a number from FindContacts.");
  if (args.chatId && (typeof args.chatId !== "string" || !SENDABLE_CHAT_ID.test(args.chatId) || !CHAT_GUID.test(args.chatId)))
    throw new Error("Pass the chat's guid exactly as FindIMessageChats returned it.");
  if (args.service !== undefined && !["auto", "iMessage", "SMS"].includes(args.service))
    throw new Error("Invalid message service");
  const recipientName = args.to ? boundedRecipientName(args.recipientName) : undefined;
  return {
    text: args.text,
    ...(args.to ? { to: args.to } : {}),
    ...(args.chatId ? { chatId: args.chatId } : {}),
    ...(args.service ? { service: args.service } : {}),
    ...(recipientName ? { recipientName } : {}),
  };
}

/**
 * Who the card names. A `to` send shows the recipient's name beside the handle; a one-to-one
 * chat shows its handle and a group shows "Group chat". Only a `to` send can be allowed.
 */
export function messagesSendRecipient(send: MessagesSend): { label: string; handle?: string; allowable: boolean } {
  if (send.to) return { label: send.recipientName ?? send.to, handle: send.to, allowable: true };
  const match = CHAT_GUID.exec(send.chatId ?? "");
  if (match?.[1] === "-") {
    const handle = send.chatId!.slice(send.chatId!.indexOf(";-;") + 3);
    return { label: handle, handle, allowable: false };
  }
  return { label: "Group chat", allowable: false };
}
