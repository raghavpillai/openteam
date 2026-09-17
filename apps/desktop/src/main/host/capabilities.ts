import { DESKTOP_MESSAGES_TOOLS } from "@openteam/contracts/desktop-capability-names";
import type { MacMessages } from "./messages";
import type { SavedCredentials } from "./credentials";
import { ChromeCookies } from "./chrome-cookies";
import { CapabilitySettingsStore, type NativeConsent } from "./capability-settings";
import type { NativeActionReceipts } from "./action-receipts";
import { CapabilityApprovals } from "./capability-approval";
import type { NativeCommand } from "./native-command";
export class HostCapabilities {
  private credentials?: SavedCredentials;
  private readonly cookies: ChromeCookies;
  private readonly approvals: CapabilityApprovals;
  private readonly consent: NativeConsent;
  constructor(
    readonly settings: CapabilitySettingsStore,
    consent: NativeConsent,
    private messages?: MacMessages,
    credentials?: SavedCredentials,
    cookies?: ChromeCookies,
    private readonly platform = process.platform,
    private readonly receipts?: NativeActionReceipts,
    private readonly credentialCommand?: NativeCommand
  ) {
    this.approvals = new CapabilityApprovals(consent);
    this.consent = this.approvals.consent;
    this.credentials = credentials;
    this.cookies = cookies ?? new ChromeCookies(settings, this.consent);
  }
  async handle(value: unknown, signal?: AbortSignal): Promise<any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop request");
    return this.approvals.run(value as Record<string, any>, (await this.settings.read()).revocationEpoch ?? 0,
      () => this.execute(value, signal));
  }
  private async execute(value: unknown, signal?: AbortSignal): Promise<any> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid desktop request");
    const { tool, botId, callId, arguments: rawArgs = {} } = value as Record<string, any>;
    const { parseReferenceArguments } = await import("@openteam/contracts/reference-parsers");
    const args = ["ListCredentials", "GetCredentialProviderStatus", "request_cookie_origin_approval", ...DESKTOP_MESSAGES_TOOLS].includes(tool) ? parseReferenceArguments(tool, rawArgs) : rawArgs;
    if (
      typeof botId !== "string" ||
      !botId ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new Error("Invalid desktop request");
    if (["GetCredentialProviderStatus", "ListCredentials", "AutomaticSavedCredential", "UseSavedCredential"].includes(tool)) {
      const { SavedCredentials } = await import("./credentials");
      const credentials = this.credentials ??= new SavedCredentials(this.settings, this.consent, this.credentialCommand);
      if (tool === "GetCredentialProviderStatus") return credentials.status(signal);
      if (tool === "ListCredentials") return credentials.list(args, signal);
      if (tool === "AutomaticSavedCredential") return credentials.automatic(args.site, signal);
      return credentials.use(args, signal);
    }
    if (this.platform !== "darwin")
      throw new Error("Messages, Contacts and Chrome login import require a connected Mac");
    if (tool === "request_cookie_origin_approval")
      return this.cookies.collect(botId, args.origins, signal);
    if (!(DESKTOP_MESSAGES_TOOLS as readonly string[]).includes(tool))
      throw new Error("Unknown desktop capability");
    const { MacMessages, validateMessageSend } = await import("./messages");
    const messages = this.messages ??= new MacMessages();
    const epoch = (await this.settings.read()).revocationEpoch ?? 0;
    if (tool === "SendIMessage") {
      validateMessageSend(args);
      if (!this.receipts) throw new Error("Durable send receipts are unavailable");
      // Review must finish before claiming the durable send receipt. A pending
      // approval has not attempted a send and must remain safely retryable.
      return this.receipts.execute(botId, callId, args, () => messages.execute(tool, args, signal), async () => {
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
    const result = await messages.execute(tool, args, signal);
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
        result.people = await messages.people(handles, signal);
      } catch {
        result.people = {};
      }
    }
    if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
      throw new Error("Messages access was revoked during retrieval");
    return result;
  }
}
