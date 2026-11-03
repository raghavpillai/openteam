import { DESKTOP_MESSAGES_TOOLS } from "@openteam/contracts/desktop-capability-names";
import type { MacMessages } from "./messages";
import { ChromeCookies } from "./chrome-cookies";
import type { NativeActionReceipts } from "./action-receipts";
import type { MessagesAccess } from "./messages-access";
import { NativeCommandError } from "./native-command";

const missingGrant = (grant: string) =>
  `The user's Mac has not granted OpenTeam ${grant}, so this cannot run. Ask the user to grant it to OpenTeam in System Settings under Privacy & Security, then try again.`;
export class HostCapabilities {
  private readonly cookies: ChromeCookies;
  constructor(
    private messages?: MacMessages,
    cookies?: ChromeCookies,
    private readonly platform = process.platform,
    private readonly receipts?: NativeActionReceipts,
    /** Messages requests run only while this Mac's own setting allows them. */
    private readonly messagesGate?: { enabled: () => Promise<boolean>; access?: MessagesAccess; onGrantMissing?: () => void }
  ) {
    this.cookies = cookies ?? new ChromeCookies();
  }
  /** Reads need Full Disk Access and FindContacts needs Contacts; a send stops only on a known Automation denial. */
  private async requireGrant(tool: string) {
    try { await this.checkGrant(tool); }
    catch (error) {
      // The user sees the permissions dialog on that Mac while the bot is told what's missing.
      this.messagesGate?.onGrantMissing?.();
      throw error;
    }
  }

  private async checkGrant(tool: string) {
    const access = this.messagesGate?.access;
    if (!access) return;
    const permissions = await access.permissions();
    if (tool === "FindContacts") {
      if (permissions.contacts === "denied") throw new Error(missingGrant("Contacts"));
      if (permissions.contacts === "notAsked")
        throw new Error("The user's Mac hasn't been asked for Contacts access yet, so this cannot run. A window asking for it is now open on that Mac; ask the user to choose Allow next to Contacts there (or in OpenTeam Settings → Computer → Messages → macOS permissions), then try again. Handles still work without names.");
    } else if (tool === "SendIMessage") {
      if (permissions.automation === "denied") throw new Error(missingGrant("Automation for Messages"));
    } else if (tool !== "CheckIMessagePermissions" && !permissions.fullDiskAccess) throw new Error(missingGrant("Full Disk Access"));
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
      throw new Error("Messages is turned off in the user's settings on this Mac, so their Messages cannot be read or sent from here. Do not retry while it stays off. If the user wants this, ask them to turn it back on in OpenTeam Settings → Computer → Messages on that Mac.");
    await this.requireGrant(tool);
    const { MacMessages } = await import("./messages");
    const { validateMessageSend } = await import("@openteam/contracts/messages-send");
    const messages = this.messages ??= new MacMessages();
    if (tool === "SendIMessage") {
      const send = validateMessageSend(args);
      if (!this.receipts) throw new Error("Durable send receipts are unavailable");
      signal?.throwIfAborted();
      try {
        const result = await this.receipts.execute(botId, callId, send, () => messages.execute(tool, send, signal));
        this.messagesGate?.access?.noteAutomation("granted");
        return result;
      } catch (error) {
        if (!(error instanceof NativeCommandError && error.reason === "automation_denied")) throw error;
        this.messagesGate?.access?.noteAutomation("denied");
        throw new Error(missingGrant("Automation for Messages"));
      }
    }
    signal?.throwIfAborted();
    // The same prompt-free state the Settings page shows.
    if (tool === "CheckIMessagePermissions" && this.messagesGate?.access) {
      const permissions = await this.messagesGate.access.permissions(0);
      return {
        kind: "check-permissions",
        fullDiskAccess: permissions.fullDiskAccess,
        automation: permissions.automation === "unknown" ? "notAsked" : permissions.automation,
        contacts: permissions.contacts === "granted" ? "granted" : "denied",
      };
    }
    const result = await messages.execute(tool, args, signal);
    if (
      result &&
      typeof result === "object" &&
      "people" in result
    ) {
      // Names cover senders, chat members, tapback senders and @-mentioned people.
      const handles = [
        ...(result.chats ?? []).flatMap((chat: any) => chat.handles ?? []),
        ...(result.items ?? []).flatMap((item: any) => [
          ...(typeof item.handle === "string" ? [item.handle] : item.handles ?? []),
          ...(item.tapbacks ?? []).flatMap((tapback: any) => typeof tapback.handle === "string" ? [tapback.handle] : []),
          ...(item.body?.runs ?? []).flatMap((run: any) => typeof run.mention === "string" ? [run.mention] : []),
        ]),
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
