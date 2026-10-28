import { DESKTOP_MESSAGES_TOOLS } from "@openteam/contracts/desktop-capability-names";
import type { MacMessages } from "./messages";
import { ChromeCookies } from "./chrome-cookies";
import type { NativeActionReceipts } from "./action-receipts";
import type { MessagesAccess } from "./messages-access";
export class HostCapabilities {
  private readonly cookies: ChromeCookies;
  constructor(
    private messages?: MacMessages,
    cookies?: ChromeCookies,
    private readonly platform = process.platform,
    private readonly receipts?: NativeActionReceipts,
    /** Messages requests run only while this Mac's own setting allows them. */
    private readonly messagesGate?: { enabled: () => Promise<boolean>; access?: MessagesAccess }
  ) {
    this.cookies = cookies ?? new ChromeCookies();
  }
  async handle(value: unknown, signal?: AbortSignal): Promise<any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop request");
    return this.execute(value, signal);
  }
  private async execute(value: unknown, signal?: AbortSignal): Promise<any> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid desktop request");
    const { tool, botId, callId, arguments: rawArgs = {} } = value as Record<string, any>;
    const { parseReferenceArguments } = await import("@openteam/contracts/reference-parsers");
    const args = ["RequestCookieOriginApproval", ...DESKTOP_MESSAGES_TOOLS].includes(tool) ? parseReferenceArguments(tool, rawArgs) : rawArgs;
    if (
      typeof botId !== "string" ||
      !botId ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new Error("Invalid desktop request");
    if (this.platform !== "darwin")
      throw new Error("Messages, Contacts and Chrome login import require a connected Mac");
    if (tool === "RequestCookieOriginApproval")
      return this.cookies.collect(botId, args.origins, signal);
    if (!(DESKTOP_MESSAGES_TOOLS as readonly string[]).includes(tool))
      throw new Error("Unknown desktop capability");
    if (this.messagesGate && !await this.messagesGate.enabled())
      throw new Error("Messages is turned off in the user's settings on this Mac (OpenTeam Settings → Computer → Messages), so nothing was read or sent. Do not retry while it stays off.");
    const { MacMessages } = await import("./messages");
    const { validateMessageSend } = await import("@openteam/contracts/messages-send");
    const messages = this.messages ??= new MacMessages();
    if (tool === "SendIMessage") {
      const send = validateMessageSend(args);
      if (!this.receipts) throw new Error("Durable send receipts are unavailable");
      signal?.throwIfAborted();
      const result = await this.receipts.execute(botId, callId, send, () => messages.execute(tool, send, signal));
      this.messagesGate?.access?.noteAutomation("granted");
      return result;
    }
    signal?.throwIfAborted();
    const result = await messages.execute(tool, args, signal);
    if (
      result &&
      typeof result === "object" &&
      "people" in result
    ) {
      const handles = [
        ...(result.chats ?? []).flatMap((chat: any) => chat.handles ?? []),
        ...(result.items ?? []).flatMap((item: any) =>
          typeof item.handle === "string" ? [item.handle] : item.handles ?? []
        ),
      ];
      try {
        result.people = await messages.people(handles, signal);
      } catch {
        result.people = {};
      }
    }
    return result;
  }
}
