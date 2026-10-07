import { DESKTOP_MESSAGES_TOOLS } from "@openteam/contracts/desktop-capability-names";
import type { MacMessages } from "./messages";
import { ChromeCookies } from "./chrome-cookies";
import { CapabilitySettingsStore } from "./capability-settings";
import type { NativeActionReceipts } from "./action-receipts";
export class HostCapabilities {
  private readonly cookies: ChromeCookies;
  constructor(
    readonly settings: CapabilitySettingsStore,
    private messages?: MacMessages,
    cookies?: ChromeCookies,
    private readonly platform = process.platform,
    private readonly receipts?: NativeActionReceipts
  ) {
    this.cookies = cookies ?? new ChromeCookies(settings);
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
    const args = ["import_chrome_cookies", ...DESKTOP_MESSAGES_TOOLS].includes(tool) ? parseReferenceArguments(tool, rawArgs) : rawArgs;
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
    if (tool === "import_chrome_cookies")
      return this.cookies.collect(botId, args.origins, signal);
    if (!(DESKTOP_MESSAGES_TOOLS as readonly string[]).includes(tool))
      throw new Error("Unknown desktop capability");
    const { MacMessages, validateMessageSend } = await import("./messages");
    const messages = this.messages ??= new MacMessages();
    if (tool === "SendIMessage") {
      validateMessageSend(args);
      if (!this.receipts) throw new Error("Durable send receipts are unavailable");
      signal?.throwIfAborted();
      return this.receipts.execute(botId, callId, args, () => messages.execute(tool, args, signal));
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
