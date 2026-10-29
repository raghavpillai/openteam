import { homedir } from "node:os";
import { join } from "node:path";
import { NativeContacts } from "./contacts";
import { nativeCommand, sqliteRows, sqlText, type NativeCommand } from "./native-command";

export type MessagesGrant = "fullDiskAccess" | "automation" | "contacts";
export interface MessagesPermissions {
  fullDiskAccess: boolean;
  automation: "granted" | "denied" | "notAsked" | "unknown";
  contacts: "granted" | "denied" | "notAsked" | "unknown";
}

/**
 * The macOS grants Messages needs, as this app holds them. Checks never prompt: Full Disk
 * Access is a read of chat.db, Contacts its authorization status, and Automation macOS's
 * recorded grant, or else what the last explicit request or send showed.
 */
export class MessagesAccess {
  private automation: MessagesPermissions["automation"] = "unknown";
  private cached?: { at: number; value: MessagesPermissions };
  constructor(
    private readonly run: NativeCommand = nativeCommand,
    private readonly root = join(homedir(), "Library", "Messages"),
    /** Bundle IDs macOS records this app's Automation grant under. */
    private readonly clients: string[] = [],
    private readonly tcc = join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db")
  ) {}

  /** macOS's own record of the Automation grant, readable with Full Disk Access; null when it can't be read. */
  private async recordedAutomation(): Promise<MessagesPermissions["automation"] | null> {
    if (!this.clients.length) return null;
    try {
      const rows = await sqliteRows(this.run, this.tcc, `SELECT auth_value FROM access WHERE service='kTCCServiceAppleEvents' AND indirect_object_identifier='com.apple.MobileSMS' AND client IN (${this.clients.map(sqlText).join(",")}) ORDER BY last_modified DESC LIMIT 1`);
      if (!rows.length) return "notAsked";
      return Number(rows[0]!.auth_value) === 2 ? "granted" : "denied";
    } catch {
      return null;
    }
  }

  async permissions(maxAgeMs = 60_000): Promise<MessagesPermissions> {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) return { ...this.cached.value, automation: this.automation };
    let fullDiskAccess = false;
    try {
      await sqliteRows(this.run, join(this.root, "chat.db"), "SELECT ROWID FROM message LIMIT 1");
      fullDiskAccess = true;
    } catch { /* Reported as not granted. */ }
    let contacts: MessagesPermissions["contacts"] = "unknown";
    try {
      const status = Number((await this.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('Contacts'); Number($.CNContactStore.authorizationStatusForEntityType(0))"])).trim());
      contacts = status === 3 || status === 4 ? "granted" : status === 0 ? "notAsked" : "denied";
    } catch { /* Unknown. */ }
    // The recorded grant is the truth; what a send or explicit request showed covers apps macOS files elsewhere.
    const recorded = fullDiskAccess ? await this.recordedAutomation() : null;
    if (recorded && (recorded !== "notAsked" || this.automation === "unknown")) this.automation = recorded;
    const value = { fullDiskAccess, automation: this.automation, contacts };
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** A send that reached Messages proves Automation; one refused with -1743 disproves it. */
  noteAutomation(state: "granted" | "denied") {
    this.automation = state;
  }

  /** Raises the macOS consent prompt for one grant; Full Disk Access can only be granted in System Settings. */
  async request(grant: Exclude<MessagesGrant, "fullDiskAccess">): Promise<MessagesPermissions> {
    if (grant === "automation") {
      try {
        // Reading account metadata is an Apple Event to Messages: macOS asks once, then remembers.
        await this.run("/usr/bin/osascript", ["-e", 'with timeout of 120 seconds\ntell application "Messages" to get count of accounts\nend timeout']);
        this.automation = "granted";
      } catch {
        this.automation = "denied";
      }
    } else {
      // A Contacts read asks for access when macOS hasn't been asked yet.
      await new NativeContacts(this.run).find("a").catch(() => {});
    }
    this.cached = undefined;
    return this.permissions();
  }
}
