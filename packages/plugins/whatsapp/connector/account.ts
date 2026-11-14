import { randomUUID } from "node:crypto";
import { pairingPng } from "./png";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { Event, Execute, Running, Settings } from "./process";

type Process = { execute: Execute; follow: (args: string[], onEvent: (event: Event) => void) => Running; close?: () => Promise<void>; resetRevokedSession?: () => Promise<void> };
type Pairing = { kind: "qr" | "phone"; code: string; expiresAt: number; generatedAt: number; generation: number; rescanRequired: boolean };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One owner for pairing, sync, and writes. Reads do not queue behind writes. */
export class WhatsAppAccount {
  private running?: Running;
  private mode?: "auth" | "sync";
  private pairing?: Pairing;
  private link?: { sessionId: string; expiresAt: number; completed?: boolean; cancelled?: boolean; expired?: boolean };
  private startingLink?: Promise<ReturnType<WhatsAppAccount["challenge"]> & { sessionId: string; sessionExpiresAt: number; challengeGeneration: number }>;
  private invalidateChallenge() {
    if (this.pairing) { this.pairing = undefined; ++this.generation; }
  }
  private challenge() {
    return { qrCodeDataUrl: this.pairing && this.pairing.expiresAt > Date.now()
      ? `data:image/png;base64,${pairingPng(this.pairing.code).toString("base64")}` : null,
      expiresAt: Math.min(this.pairing?.expiresAt ?? Date.now(), this.link?.expiresAt ?? Date.now()) };
  }
  private pairingDeadline?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private revoked = false;
  private connection = "not_started";
  private lastEventAt?: string;
  private lastWarning?: string;
  private lastError?: string;
  private terminalError = false;
  private generation = 0;
  private qrCodes = 0;
  private attempt = 0;
  private lastExitCode: number | null = null;
  private diagnostics: Array<{ event: string; at: string; code?: string }> = [];
  private record(event: string, code?: string) {
    this.diagnostics.push({ event, at: new Date().toISOString(), ...(code ? { code } : {}) });
    if (this.diagnostics.length > 40) this.diagnostics.shift();
  }
  constructor(readonly process: Process, readonly settings: Settings) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.closed) throw new Error("WhatsApp connector is shutting down.");
      return run();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private event = (event: Event) => {
    this.lastEventAt = new Date().toISOString();
    // Never retain raw event payloads: they can contain QR secrets and chat data.
    if (["auth_starting", "qr_code", "pair_code", "connected", "disconnected", "reconnecting", "stream_replaced", "stale", "logged_out", "error"].includes(event.event)) this.record(event.event);
    if (event.event === "qr_code" || event.event === "pair_code") {
      const code = event.data?.code;
      if (typeof code === "string" && code.length <= 8192) {
        // A companion registration refresh rotates the ADV secret (field 4),
        // invalidating the scanned QR without failing the live auth process.
        const previousFields = this.pairing?.code.split(",") ?? [];
        const fields = code.split(",");
        const secretRotated = event.event === "qr_code" && this.pairing?.kind === "qr"
          && previousFields.length === 5 && fields.length === 5 && previousFields[3] !== fields[3];
        const rescanRequired = event.event === "qr_code" && (secretRotated || this.pairing?.rescanRequired === true);
        if (secretRotated) this.record("qr_secret_rotated");
        this.pairing = { kind: event.event === "qr_code" ? "qr" : "phone", code,
          generatedAt: Date.now(), generation: ++this.generation, rescanRequired,
          // The pinned whatsmeow QR channel gives the first code 60 seconds,
          // then rotates every 20 seconds. wacli does not forward that TTL.
          expiresAt: Date.now() + (event.event === "qr_code" ? (this.qrCodes++ === 0 ? 60000 : 20000) : 150000) };
        this.connection = "awaiting_pairing";
      }
    } else if (event.event === "connected") {
      this.connection = this.mode === "auth" ? "bootstrapping" : "connected";
      this.invalidateChallenge();
      this.revoked = false;
      this.retries = 0;
      this.lastError = undefined;
      this.terminalError = false;
    } else if (["disconnected", "reconnecting", "stream_replaced", "stale"].includes(event.event)) {
      this.connection = event.event;
    } else if (event.event === "logged_out") {
      this.connection = "logged_out";
      this.revoked = true;
      this.invalidateChallenge();
    } else if (event.event === "warning") {
      // Keep only machine codes; warning messages can contain message text, JIDs, or URLs.
      const code = event.data?.code;
      this.lastWarning = typeof code === "string" && ["auth_connect_retry", "storage_limit", "sync_storage_uncapped", "refresh_contacts_failed", "refresh_groups_failed", "refresh_channels_failed"].includes(code) ? code : "sync_warning";
      this.record("warning", this.lastWarning);
      if (this.lastWarning === "auth_connect_retry") {
        // The old socket's challenge is no longer valid while wacli reconnects.
        this.invalidateChallenge();
        this.connection = "pairing_starting";
      }
    } else if (event.event === "error") {
      // Interpret known failures without relaying arbitrary upstream strings,
      // which can include contact details, filesystem paths, or message text.
      const message = typeof event.data?.message === "string" ? event.data.message : "";
      if (/passkey|verification.*required|confirmation.*required/i.test(message)) {
        this.lastError = "WhatsApp requires passkey verification or additional phone confirmation. This pairing flow is not supported by the bundled client.";
        this.terminalError = true;
      } else if (/outdated|client.*405/i.test(message)) {
        this.lastError = "WhatsApp rejected this client version. Update the WhatsApp plugin before reconnecting.";
        this.terminalError = true;
      } else if (/storage limit|max(?:imum)? messages|max.*(?:db|database)|database.*size.*limit|no space left/i.test(message)) {
        this.lastError = "WhatsApp sync reached a storage limit or the bot computer is out of disk space. Retained messages were not removed.";
        this.terminalError = true;
      } else if (/temporar(?:y|ily).*ban/i.test(message)) {
        this.lastError = "WhatsApp reported a temporary account restriction. Inspect WhatsApp on your phone before trying again.";
        this.terminalError = true;
      } else if (/lock|another process/i.test(message)) {
        this.lastError = "Another process owns this WhatsApp account store. Stop the duplicate connector before restarting sync.";
        this.terminalError = true;
      } else if (/qr.*(?:timed? out|timeout|channel closed)/i.test(message)) {
        this.lastError = "The WhatsApp pairing challenge expired or its channel closed. Request a new pairing attempt.";
      } else if (/websocket|connection reset|broken pipe|i\/o timeout|eof|dns|no such host|tls handshake/i.test(message)) {
        this.lastError = "The WhatsApp connection failed during transport setup or communication. Check the bot computer's network and request a new pairing attempt.";
      } else this.lastError = "WhatsApp reported an error. Check connection_status and reconnect if needed.";
    }
  };

  private start(mode: "auth" | "sync", phone?: string) {
    if (this.running || this.closed) return;
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    this.mode = mode;
    if (mode === "auth") {
      this.attempt++;
      this.generation = 0;
      this.qrCodes = 0;
      this.link = { sessionId: randomUUID(), expiresAt: Date.now() + 600000 };
      this.diagnostics = [];
      this.lastWarning = undefined;
    }
    this.lastExitCode = null;
    this.record(`${mode}_process_started`);
    this.connection = mode === "auth" ? "pairing_starting" : "connecting";
    // auth --follow has no send delegate in wacli 0.26.0. Finish bootstrap,
    // then launch sync --follow so sends share its WhatsApp connection.
    const args = mode === "auth"
      ? ["auth", "--idle-exit", "3s", ...(phone ? ["--phone", phone] : [])]
      : ["sync", "--follow", "--max-reconnect", "0", "--presence-mode", "quiet", "--stale-threshold", "90s"];
    const running = this.process.follow(args, (event) => {
      // Shutdown can emit a final error or connection event after stop() has
      // detached this process. It must not overwrite a newer pairing attempt.
      if (this.running === running) this.event(event);
    });
    this.running = running;
    if (mode === "auth") {
      const session = this.link!;
      this.pairingDeadline = setTimeout(() => {
        void this.exclusive(async () => {
          if (this.link !== session || session.completed || session.cancelled) return;
          session.expired = true;
          await this.stop();
          this.connection = "pairing_expired";
        }).catch(() => {});
      }, Math.max(0, session.expiresAt - Date.now()));
    }
    void running.done.then((code) => {
      if (this.running !== running) return;
      this.lastExitCode = code;
      this.record(`${mode}_process_exited`);
      this.running = undefined;
      this.mode = undefined;
      this.invalidateChallenge();
      if (this.closed || this.revoked) return;
      if (mode === "auth" && code === 0) {
        void this.initialize().catch(() => { this.lastError = "Pairing finished, but sync could not restart. Use restart_sync."; });
      } else {
        this.connection = "stopped";
        this.lastError ??= code === 0 ? "Sync stopped. Check storage limits and restart_sync." : "Sync exited unexpectedly. Check connection_status; writes are never automatically retried.";
        if (mode === "sync" && code !== 0 && !this.terminalError && this.retries++ < 3)
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.initialize().catch(() => { this.lastError = "WhatsApp recovery failed. Check connection status and reconnect."; });
          }, 5000 * this.retries);
      }
    });
  }
  private async stop() {
    clearTimeout(this.pairingDeadline);
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    const running = this.running;
    this.running = undefined;
    this.mode = undefined;
    this.invalidateChallenge();
    if (running) await running.stop();
  }
  async initialize() {
    return this.exclusive(async () => {
      if (this.running || this.revoked || this.link?.cancelled || this.link?.expired) return;
      const auth = await this.process.execute(["auth", "status"], true);
      if (auth.data?.authenticated) this.start("sync");
      else this.connection = "needs_pairing";
    });
  }
  async status() {
    const auth = await this.process.execute(["auth", "status"], true);
    const authenticated = auth.data?.authenticated === true && !this.revoked;
    let doctor: unknown;
    // A new store has no message DB until auth initializes it.
    if (authenticated) doctor = (await this.process.execute(["doctor"], true)).data;
    return { account_id: this.settings.accountId, authenticated, linked_jid: auth.data?.linked_jid ?? null,
      connection_state: this.connection, sync_running: !!this.running && this.mode === "sync",
      pairing_running: !!this.running && this.mode === "auth",
      pairing_available: !!this.pairing && this.pairing.expiresAt > Date.now(),
      pairing: this.pairing ? { kind: this.pairing.kind, generation: this.pairing.generation, requires_rescan: this.pairing.rescanRequired,
        generated_at: new Date(this.pairing.generatedAt).toISOString(), expires_at: new Date(this.pairing.expiresAt).toISOString() } : null,
      pairing_attempt: this.attempt, last_exit_code: this.lastExitCode, diagnostics: this.diagnostics.map((item) => ({ ...item })),
      read_only: this.settings.readOnly, last_event_at: this.lastEventAt ?? null,
      last_warning: this.lastWarning ?? null, last_error: this.lastError ?? null, local_health: doctor ?? null,
      history_scope: "retained_local_archive", instructions: authenticated
        ? "Read results describe retained local history. A running process or local doctor result does not certify freshness or complete history."
        : "Open this account in OpenTeam settings to link WhatsApp. Connector availability does not mean WhatsApp is paired." };
  }
  startLink() {
    if (this.startingLink) return this.startingLink;
    const pending = (async () => {
      try { await this.pair(); }
      catch (error) {
        // Reconnecting a persisted account may need a moment to open its sync
        // delegate. The host's failed-start fallback rechecks linked readiness.
        const auth = await this.process.execute(["auth", "status"], true);
        if (auth.data?.authenticated && !this.revoked) {
          const deadline = Date.now() + 10000;
          while (this.running && Date.now() < deadline) {
            if ((await this.linkStatus()).linked) break;
            await pause(100);
          }
        }
        throw error;
      }
      const session = this.link;
      if (!session || session.cancelled || session.expired || session.expiresAt <= Date.now())
        throw new Error("Device approval was interrupted. Connect again for a new code.");
      if (!this.running) throw new Error(this.lastError ?? "Device approval stopped. Connect again for a new code.");
      return { sessionId: session.sessionId, ...this.challenge(),
        sessionExpiresAt: session.expiresAt, challengeGeneration: this.generation };
    })();
    this.startingLink = pending;
    void pending.finally(() => { if (this.startingLink === pending) this.startingLink = undefined; }).catch(() => {});
    return pending;
  }
  finishLink(sessionId: string) {
    return this.exclusive(async () => {
      const session = this.link;
      if (!session || session.sessionId !== sessionId || session.cancelled || session.expired || session.expiresAt <= Date.now())
        throw new Error("This device approval is no longer active.");
      // Native auth already waits in the background; do not block the host poller.
      return { sessionId, pending: !session.completed };
    });
  }
  linkStatus() {
    return this.exclusive(async () => {
      const session = this.link;
      const identity = session ? { sessionId: session.sessionId } : {};
      if (session && !session.completed && session.expiresAt <= Date.now()) {
        session.expired = true;
        await this.stop(); this.connection = "pairing_expired";
      }
      if (session?.cancelled || session?.expired)
        return { ...identity, linked: false, linking: false };
      const auth = await this.process.execute(["auth", "status"], true);
      const authenticated = auth.data?.authenticated === true && !this.revoked;
      const ready = authenticated && await this.syncReady();
      // The deadline includes initial history and the transition to send-capable sync.
      if (session && !session.completed && session.expiresAt <= Date.now()) {
        session.expired = true; await this.stop(); this.connection = "pairing_expired";
        return { ...identity, linked: false, linking: false };
      }
      if (ready) {
        if (session) session.completed = true;
        clearTimeout(this.pairingDeadline);
        return { ...identity, linked: true, linking: false };
      }
      if (this.pairing && this.pairing.expiresAt <= Date.now()) this.invalidateChallenge();
      const linking = !!session && !session.completed && !!this.running && !this.revoked && !this.terminalError;
      return { ...identity, linked: false, linking,
        ...(linking ? { challenge: { generation: this.generation, ...this.challenge() } } : {}),
        ...(authenticated && !linking && !this.terminalError && !this.revoked && (this.running || this.retryTimer)
          ? { recovering: true } : {}),
        ...(this.lastError && !linking ? { authorizationError: this.lastError } : {}) };
    });
  }
  cancelLink(sessionId: string) {
    return this.exclusive(async () => {
      if (!this.link || this.link.sessionId !== sessionId) return { cancelled: false };
      this.link.cancelled = true;
      await this.stop(); this.connection = "needs_pairing";
      return { cancelled: true };
    });
  }
  async removeAccount() {
    // Host deletion follows confirmed shutdown, including read-only accounts.
    await this.close();
    return { removed: true };
  }
  async pair(phone?: string) {
    await this.exclusive(async () => {
      if (this.mode === "auth") return;
      const auth = await this.process.execute(["auth", "status"], true);
      if (auth.data?.authenticated && !this.revoked) throw new Error("This account is already linked. Use connection_status or restart_sync.");
      await this.stop();
      await this.process.resetRevokedSession?.();
      this.revoked = false;
      this.lastError = undefined;
      this.terminalError = false;
      this.start("auth", phone);
    });
    // Keep this short enough for normal MCP tool timeouts; the process continues.
    const deadline = Date.now() + 20000;
    while (this.running && (!this.pairing || this.pairing.expiresAt <= Date.now()) && Date.now() < deadline && this.connection !== "bootstrapping") await pause(100);
    if (this.pairing && this.pairing.expiresAt > Date.now()) return { ...this.pairing };
    if (!this.running && this.lastError) throw new Error(this.lastError);
    return undefined;
  }
  async cancelPairing() {
    return this.exclusive(async () => {
      if (this.mode !== "auth") return { cancelled: false, reason: "No pairing is in progress." };
      const auth = await this.process.execute(["auth", "status"], true);
      if (auth.data?.authenticated) throw new Error("Pairing already succeeded. Manage this account in OpenTeam settings.");
      if (this.link) this.link.cancelled = true;
      await this.stop(); this.connection = "needs_pairing";
      return { cancelled: true };
    });
  }
  async restart() {
    return this.exclusive(async () => {
      const auth = await this.process.execute(["auth", "status"], true);
      if (!auth.data?.authenticated || this.revoked) throw new Error("This account needs pairing. Link this account in OpenTeam settings.");
      await this.stop(); this.retries = 0; this.lastError = undefined; this.terminalError = false; this.start("sync");
      return { restarting: true };
    });
  }
  read(args: string[]) { return this.process.execute(args, true); }
  private async syncReady() {
    const running = this.running;
    if (!running || this.mode !== "sync" || this.connection !== "connected") return false;
    const path = join(this.settings.store, ".send.sock");
    if (!(await lstat(path).catch(() => null))?.isSocket()) return false;
    // A crashed native process can leave a socket inode. Verify a live local
    // listener without submitting any command or sending a WhatsApp message.
    return new Promise<boolean>((resolve) => {
      const probe = createConnection({ path });
      const finish = (ready: boolean) => { probe.destroy(); resolve(ready); };
      probe.setTimeout(500, () => finish(false));
      probe.once("error", () => finish(false));
      probe.once("connect", () => finish(this.running === running && this.connection === "connected"));
    });
  }
  private async readyToWrite() {
    if (this.settings.readOnly) throw new Error("This WhatsApp account is configured for read-only access.");
    if (this.revoked) throw new Error("The linked device was logged out. Link this account in OpenTeam settings.");
    if (this.mode === "auth") throw new Error("Pairing or initial sync is still running. Check connection_status before sending.");
    const auth = await this.process.execute(["auth", "status"], true);
    if (!auth.data?.authenticated) throw new Error("Link this account in OpenTeam settings first.");
    if (!this.running) this.start("sync");
    const deadline = Date.now() + 10000;
    while (this.running && Date.now() < deadline) {
      if (await this.syncReady()) return;
      await pause(100);
    }
    throw new Error("WhatsApp sync is not ready to send yet. No send was attempted. Check connection_status and try after startup finishes.");
  }
  write(args: string[], timeoutMs = 45000) {
    return this.exclusive(async () => { await this.readyToWrite(); return this.process.execute(args, false, timeoutMs); });
  }
  backfill(args: string[]) {
    return this.exclusive(async () => {
      await this.readyToWrite();
      await this.stop();
      try { return await this.process.execute(args, false, 90000); }
      finally { if (!this.closed && !this.revoked) this.start("sync"); }
    });
  }
  logout() {
    return this.exclusive(async () => {
      if (this.settings.readOnly) throw new Error("This WhatsApp account is configured for read-only access.");
      await this.stop();
      try {
        const auth = await this.process.execute(["auth", "status"], true);
        if (!auth.data?.authenticated || this.revoked) {
          this.revoked = true; this.connection = "logged_out";
          return { success: true, data: { logged_out: true, already_unlinked: true }, error: null };
        }
        const result = await this.process.execute(["auth", "logout"]);
        this.revoked = true; this.connection = "logged_out";
        return result;
      } catch (error) { this.connection = "stopped"; throw error; }
    });
  }
  async close() { this.closed = true; await this.stop(); await this.process.close?.(); }
}
