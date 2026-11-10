import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SignalRpc } from "./rpc";
import { MessageStore, type SignalAccount } from "./store";

type Rpc = Pick<SignalRpc, "request" | "close" | "connected" | "exited">;
type RpcFactory = (receive: (params: any) => void) => Rpc;

export function accountDirectory(
  accountId: string,
  root = join(homedir(), ".local/share/openteam/signal")
) {
  if (!accountId.trim())
    throw new Error(
      "OPENTEAM_PLUGIN_ACCOUNT_ID is required. Use a distinct ID for each test account."
    );
  return join(root, createHash("sha256").update(accountId).digest("hex"));
}

export class SignalService {
  private rpc?: Rpc;
  private connecting?: Promise<void>;
  private stopped = false;
  private restart?: ReturnType<typeof setTimeout>;
  private reconnectDelay: number;
  private account?: SignalAccount;
  private version?: string;
  private link?: { id: string; uri: string; expires: number };
  private startingLink?: Promise<{ sessionId: string; deviceLinkUri: string; expiresAt: number }>;
  private finishingLink?: Promise<unknown>;
  private linkError?: string;
  private closing?: Promise<void>;

  constructor(
    readonly store: MessageStore,
    private readonly factory: RpcFactory,
    private readonly reconnectMs = 1000
  ) {
    this.reconnectDelay = reconnectMs;
  }

  async connect() {
    if (this.stopped) throw new Error("Signal connector is stopped.");
    if (this.connecting) return this.connecting;
    if (this.rpc?.connected) return;
    clearTimeout(this.restart);
    this.restart = undefined;
    this.connecting = this.initialize()
      .then(() => {
        this.reconnectDelay = this.reconnectMs;
      })
      .catch((error) => {
        this.scheduleReconnect();
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private scheduleReconnect() {
    if (this.stopped || this.restart) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    this.restart = setTimeout(() => {
      this.restart = undefined;
      void this.connect().catch(() => {});
    }, delay);
  }

  private async initialize() {
    this.account = undefined;
    const rpc = this.factory((params) => this.store.capture(params));
    this.rpc = rpc;
    void rpc.exited.then(() => {
      if (!this.stopped && this.rpc === rpc) {
        this.account = undefined;
        this.link = undefined;
        this.scheduleReconnect();
      }
    });
    try {
      this.version = (await rpc.request("version")).version;
      await this.loadAccount(rpc);
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  private async loadAccount(rpc: Rpc) {
    this.account = undefined;
    const accounts = await rpc.request("listAccounts");
    if (!Array.isArray(accounts) || accounts.length > 1)
      throw new Error("Use a private signal-cli data directory containing at most one account.");
    const candidate: SignalAccount | undefined = accounts[0];
    if (candidate) {
      if (typeof candidate.aci !== "string" || !candidate.aci)
        throw new Error("Signal returned an account without an ACI.");
      this.store.bind(candidate);
      await rpc.request("subscribeReceive", { account: candidate.number ?? candidate.aci });
      if (!rpc.connected || this.rpc !== rpc)
        throw new Error("Signal disconnected during account initialization.");
      this.account = candidate;
    }
  }

  async status() {
    await this.connect();
    return {
      connected: this.rpc!.connected,
      linked: !!this.account,
      runtimeVersion: this.version,
      recommendedVersion: "0.14.10",
      account: this.account ?? null,
      linking: !!this.finishingLink,
      authorizationError: this.linkError ?? null,
    };
  }

  async startLink() {
    await this.connect();
    if (this.account) throw new Error("This account directory is already linked.");
    if (this.finishingLink)
      throw new Error(
        "Device approval is still pending. Wait for it to finish before starting another linking session."
      );
    if (this.link && this.link.expires > Date.now())
      return {
        sessionId: this.link.id,
        deviceLinkUri: this.link.uri,
        expiresAt: this.link.expires,
      };
    this.startingLink ??= (async () => {
      this.linkError = undefined;
      const result = await this.rpc!.request("startLink");
      if (
        typeof result.deviceLinkUri !== "string" ||
        !result.deviceLinkUri.startsWith("sgnl://linkdevice?")
      )
        throw new Error("Signal returned an invalid device-link URI.");
      this.link = {
        id: crypto.randomUUID(),
        uri: result.deviceLinkUri,
        expires: Date.now() + 60_000,
      };
      return {
        sessionId: this.link.id,
        deviceLinkUri: this.link.uri,
        expiresAt: this.link.expires,
      };
    })().finally(() => {
      this.startingLink = undefined;
    });
    return this.startingLink;
  }

  async finishLink(sessionId: string) {
    await this.connect();
    if (!this.link || this.link.id !== sessionId || this.link.expires <= Date.now())
      throw new Error(
        "This linking session expired or belongs to another connection. Start linking again."
      );
    if (this.finishingLink) return this.finishingLink;
    const uri = this.link.uri;
    const rpc = this.rpc!;
    this.finishingLink = (async () => {
      try {
        await rpc.request(
          "finishLink",
          { deviceLinkUri: uri, deviceName: "OpenTeam Signal" },
          90_000
        );
        await this.loadAccount(rpc);
        if (!this.account)
          throw new Error("Signal linking completed without an account. Start linking again.");
        return { linked: true, account: this.account };
      } catch (error) {
        this.account = undefined;
        await rpc.close();
        throw error;
      } finally {
        this.link = undefined;
        this.finishingLink = undefined;
      }
    })();
    return this.finishingLink;
  }

  async beginFinishLink(sessionId: string) {
    await this.connect();
    if (!this.link || this.link.id !== sessionId || this.link.expires <= Date.now())
      throw new Error("This linking session expired. Start linking again.");
    void this.finishLink(sessionId).catch((error) => {
      this.linkError = error instanceof Error ? error.message : "Device linking failed";
    });
    return { pending: true };
  }

  async cancelLink(sessionId: string) {
    if (this.link && this.link.id !== sessionId)
      throw new Error("A newer linking session replaced this code.");
    this.link = undefined;
    this.linkError = undefined;
    await this.rpc?.close();
    await this.finishingLink?.catch(() => {});
    return { cancelled: true };
  }

  async removeAccount() {
    let remoteStopped = false;
    try {
      await this.connect();
      if (this.account) {
        await this.rpc!.request("unregister", { account: this.account.number ?? this.account.aci });
        remoteStopped = true;
      }
    } catch {
      /* Local removal must still work when Signal is unavailable. */
    }
    await this.close();
    return {
      removed: true,
      remoteStopped,
      instructions:
        "Remove this linked device in Signal's Linked Devices settings to revoke it on Signal.",
    };
  }

  async accountRequest(
    method: "listContacts" | "listGroups" | "getAttachment",
    params: Record<string, unknown> = {}
  ) {
    await this.connect();
    if (!this.account) throw new Error("Link a Signal account first.");
    const account = this.account;
    return this.rpc!.request(method, {
      ...params,
      account: account.number ?? account.aci,
    });
  }

  async send(
    requestId: string,
    destination: { recipient?: string; groupId?: string; noteToSelf?: boolean },
    message: string
  ) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))
      throw new Error("Use a request ID of 8 to 128 letters, digits, underscores, or hyphens.");
    if (
      Object.values(destination).filter(Boolean).length !== 1 ||
      Object.values(destination).some((v) => typeof v === "string" && (!v.trim() || v.length > 256))
    )
      throw new Error("Choose exactly one recipient, groupId, or noteToSelf.");
    if (typeof message !== "string" || !message.trim() || message.length > 16_000)
      throw new Error("Use a message between 1 and 16000 characters.");
    const payload = { ...destination, message };
    const recorded = this.store.previousSend(requestId, payload);
    if (recorded) return recorded;
    await this.connect();
    if (!this.account) throw new Error("Link a Signal account first.");
    const previous = this.store.beginSend(requestId, payload);
    if (previous.existing) return previous;
    // Persist unknown before writing to the child. Neither timeout nor restart triggers a resend.
    const result = await this.rpc!.request("send", {
      ...payload,
      ...(destination.noteToSelf ? { notifySelf: true } : {}),
      account: this.account.number ?? this.account.aci,
    });
    this.store.finishSend(requestId, result);
    return { existing: false, state: "sent", result };
  }

  async attachment(messageId: string, attachmentId: string) {
    const known = this.store.attachment(messageId, attachmentId);
    const params = known.chat.startsWith("group:")
      ? { id: attachmentId, groupId: known.chat.slice(6) }
      : { id: attachmentId, recipient: known.sender };
    const result = await this.accountRequest("getAttachment", params);
    this.store.attachment(messageId, attachmentId);
    return result;
  }

  async close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.restart);
    this.closing = (async () => {
      await this.rpc?.close();
      await this.connecting?.catch(() => {});
      await this.finishingLink?.catch(() => {});
      this.store.close();
    })();
    return this.closing;
  }
}

export function configuredService(environment = process.env) {
  const directory =
    environment.OPENTEAM_PLUGIN_STATE_DIR ??
    accountDirectory(environment.OPENTEAM_PLUGIN_ACCOUNT_ID ?? "", environment.SIGNAL_STATE_ROOT);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const executable = environment.SIGNAL_CLI_PATH ?? environment.OPENTEAM_RUNTIME_SIGNAL_CLI;
  if (!executable)
    throw new Error(
      "Signal's managed runtime is not installed. Connect this account from plugin settings."
    );
  if (!isAbsolute(executable))
    throw new Error("SIGNAL_CLI_PATH must be an absolute executable path.");
  const store = new MessageStore(join(directory, "messages.sqlite"));
  chmodSync(join(directory, "messages.sqlite"), 0o600);
  return new SignalService(
    store,
    (receive) =>
      new SignalRpc(
        [
          executable,
          "--data-dir",
          join(directory, "account"),
          "jsonRpc",
          "--receive-mode=manual",
          "--ignore-stories",
          "--ignore-avatars",
          "--ignore-stickers",
        ],
        receive,
        {
          environment: {
            ...(environment.JAVA_HOME
              ? { JAVA_HOME: environment.JAVA_HOME }
              : environment.OPENTEAM_RUNTIME_JAVA
                ? { JAVA_HOME: dirname(dirname(environment.OPENTEAM_RUNTIME_JAVA)) }
                : {}),
            ...(environment.OPENTEAM_RUNTIME_LIBSIGNAL
              ? {
                  JAVA_OPTS: `-Djava.library.path=${dirname(environment.OPENTEAM_RUNTIME_LIBSIGNAL)}`,
                }
              : {}),
            XDG_CONFIG_HOME: join(directory, "config"),
          },
        }
      )
  );
}
