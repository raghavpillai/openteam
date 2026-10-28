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
const HANDLE = /^(?:\+[1-9]\d{6,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

export function validateMessageSend(args: Record<string, any>): MessagesSend {
  if (typeof args.text !== "string" || args.text.length === 0) throw new Error("text is required");
  if (args.text.length > 16_000) throw new Error("text must be at most 16000 characters");
  if (Boolean(args.to) === Boolean(args.chatId)) throw new Error("Provide exactly one of to or chatId");
  if (args.to && (typeof args.to !== "string" || !HANDLE.test(args.to)))
    throw new Error("Recipient must be an E.164 number or email from Contacts");
  if (args.chatId && (typeof args.chatId !== "string" || !CHAT_GUID.test(args.chatId)))
    throw new Error("Use a chat GUID from FindIMessageChats");
  if (args.service !== undefined && !["auto", "iMessage", "SMS"].includes(args.service))
    throw new Error("Invalid message service");
  if (args.recipientName !== undefined && typeof args.recipientName !== "string")
    throw new Error("recipientName must be a string");
  return {
    text: args.text,
    ...(args.to ? { to: args.to } : {}),
    ...(args.chatId ? { chatId: args.chatId } : {}),
    ...(args.service ? { service: args.service } : {}),
    ...(args.to && args.recipientName?.trim() ? { recipientName: args.recipientName.trim().slice(0, 200) } : {}),
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
