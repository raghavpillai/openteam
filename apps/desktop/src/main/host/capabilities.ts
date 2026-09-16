import { parseReferenceArguments } from "@openteam/contracts/reference-parsers";
import { DESKTOP_MESSAGES_TOOLS } from "@openteam/contracts/desktop-capabilities";
import { MacMessages, validateMessageSend } from "./messages";
import { SavedCredentials } from "./credentials";
import { ChromeCookies } from "./chrome-cookies";
import { CapabilitySettingsStore, type NativeConsent } from "./capability-settings";
import type { NativeActionReceipts } from "./action-receipts";
export class HostCapabilities {
  private readonly credentials: SavedCredentials;
  private readonly cookies: ChromeCookies;
  constructor(
    readonly settings: CapabilitySettingsStore,
    private readonly consent: NativeConsent,
    private readonly messages = new MacMessages(),
    credentials?: SavedCredentials,
    cookies?: ChromeCookies,
    private readonly platform = process.platform,
    private readonly receipts?: NativeActionReceipts
  ) {
    this.credentials = credentials ?? new SavedCredentials(settings, consent);
    this.cookies = cookies ?? new ChromeCookies(settings, consent);
  }
  async handle(value: unknown, signal?: AbortSignal): Promise<any> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid desktop request");
    const { tool, botId, callId, arguments: rawArgs = {} } = value as Record<string, any>;
    const args = ["ListCredentials", "GetCredentialProviderStatus", "request_cookie_origin_approval", ...DESKTOP_MESSAGES_TOOLS].includes(tool) ? parseReferenceArguments(tool, rawArgs) : rawArgs;
    if (
      typeof botId !== "string" ||
      !botId ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new Error("Invalid desktop request");
    if (tool === "GetCredentialProviderStatus") return this.credentials.status(signal);
    if (tool === "ListCredentials") return this.credentials.list(args, signal);
    if (tool === "AutomaticSavedCredential") return this.credentials.automatic(args.site, signal);
    if (tool === "UseSavedCredential") return this.credentials.use(args, signal);
    if (this.platform !== "darwin")
      throw new Error("Messages, Contacts and Chrome login import require a connected Mac");
    if (tool === "request_cookie_origin_approval")
      return this.cookies.collect(botId, args.origins, signal);
    if (!(DESKTOP_MESSAGES_TOOLS as readonly string[]).includes(tool))
      throw new Error("Unknown desktop capability");
    const epoch = (await this.settings.read()).revocationEpoch ?? 0;
    if (tool === "SendIMessage") {
      validateMessageSend(args);
      if (!this.receipts) throw new Error("Durable send receipts are unavailable");
      return this.receipts.execute(botId, callId, args, async () => {
        const grant = JSON.stringify([botId, "send", args.chatId ?? args.to]);
        const all = JSON.stringify([botId, "send", "*"]);
        const sendSettings = await this.settings.read();
        const allowed = sendSettings.messagesGrants;
        const decision = sendSettings.messagesSendAll || allowed.includes(grant) || allowed.includes(all) ? "once" : await this.consent({
          title: "Send message?",
          allowAlways: true,
          detail: `To: ${args.to && args.recipientName ? args.recipientName + " — " : ""}${args.to ?? args.chatId}\nService: ${args.service ?? "auto"}\n\n${args.text}`,
        });
        if (decision === "deny") throw new Error("Message send denied. Do not retry unless asked.");
        if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
          throw new Error("Messages access changed during review");
        if (decision === "always") await this.settings.mutate(state => {
          if ((state.revocationEpoch ?? 0) !== epoch) throw new Error("Messages access changed during review");
          return { ...state, messagesGrants: [...new Set([...state.messagesGrants, grant])] };
        });
        signal?.throwIfAborted();
        return this.messages.execute(tool, args, signal);
      });
    }
    if (tool !== "CheckIMessagePermissions") {
      const key = JSON.stringify([botId, tool === "FindContacts" ? "contacts" : "messages"]);
      if (!(await this.settings.read()).messagesGrants.includes(key)) {
        const decision = await this.consent({
          title: tool === "FindContacts" ? "Allow Contacts access?" : "Allow Messages access?",
          detail: `Allow bot ${botId} to ${tool === "FindContacts" ? "search your Contacts" : "read your Messages history and attachments"}?`,
          allowAlways: true,
        });
        if (decision === "deny")
          throw new Error("Desktop access denied. Do not retry unless asked.");
        if (decision === "always")
          await this.settings.mutate((s) => {
            if ((s.revocationEpoch ?? 0) !== epoch)
              throw new Error("Messages access changed during review");
            return { ...s, messagesGrants: [...new Set([...s.messagesGrants, key])] };
          });
      }
    }
    signal?.throwIfAborted();
    if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
      throw new Error("Messages access was revoked during review");
    const result = await this.messages.execute(tool, args, signal);
    if (
      result &&
      typeof result === "object" &&
      "people" in result &&
      (await this.settings.read()).messagesGrants.includes(JSON.stringify([botId, "contacts"]))
    ) {
      const handles = [
        ...(result.chats ?? []).flatMap((chat: any) => chat.handles ?? []),
        ...(result.items ?? []).flatMap((item: any) =>
          typeof item.handle === "string" ? [item.handle] : item.handles ?? []
        ),
      ];
      try {
        result.people = await this.messages.people(handles, signal);
      } catch {
        result.people = {};
      }
    }
    if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
      throw new Error("Messages access was revoked during retrieval");
    return result;
  }
}
