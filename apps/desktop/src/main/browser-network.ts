import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { BrowserNetworkClient } from "@openteam/plugin-sdk/browser-network/client";
import type { DesktopEnrollmentConnection } from "./host/machine-enrollment";
import type { NetworkSharingStatus } from "@openteam/contracts/browser-network";
export class NetworkConsentStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<Record<string, boolean>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(([key, grant]) => key.length <= 2048 && grant === true)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
        return {};
      throw error;
    }
  }
  private key(serverUrl: string, deploymentId: string) {
    const url = new URL(serverUrl);
    url.hash = "";
    url.search = "";
    return `${url.href.replace(/\/$/, "")}#${deploymentId}`;
  }
  async allowed(serverUrl: string, deploymentId: string) {
    // A reconnect must not observe consent from before a queued local revoke.
    await this.writes;
    return (await this.read())[this.key(serverUrl, deploymentId)] === true;
  }
  set(serverUrl: string, deploymentId: string, enabled: boolean) {
    const result = this.writes.then(async () => {
      const grants = await this.read(),
        key = this.key(serverUrl, deploymentId);
      if (enabled) grants[key] = true;
      else delete grants[key];
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(grants) + "\n", { mode: 0o600 });
      await rename(temp, this.path);
    });
    this.writes = result.catch(() => {});
    return result;
  }
}

/** OS enumeration order and hardware metadata do not change the usable network. */
export function networkFingerprint(interfaces = networkInterfaces()) {
  return JSON.stringify(
    Object.entries(interfaces)
      .flatMap(([name, addresses]) =>
        (addresses ?? [])
          .filter((address) => !address.internal)
          .map((address) =>
            JSON.stringify([
              name,
              address.family,
              address.address,
              address.netmask,
              "scopeid" in address ? address.scopeid : 0,
            ])
          )
      )
      .sort()
  );
}

/** Only main-process enrollment and locally validated IPC may reach this controller. */
export class DesktopBrowserNetwork {
  private connection: DesktopEnrollmentConnection | null = null;
  private client?: BrowserNetworkClient;
  private deploymentId: string | null = null;
  private allowed = false;
  private generation = 0;
  private permissionRevision = 0;
  private suspended = false;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private identityAbort?: AbortController;
  private identityAttempt = 0;
  private fingerprint = "";
  constructor(
    private readonly machineId: string,
    private readonly grants: NetworkConsentStore,
    private readonly platform = process.platform
  ) {}
  private supported() {
    return this.platform === "darwin" || this.platform === "linux";
  }
  async configure(connection: DesktopEnrollmentConnection | null) {
    const generation = ++this.generation;
    this.client?.stop();
    this.client = undefined;
    this.connection = connection;
    this.deploymentId = null;
    this.allowed = false;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.identityAbort?.abort();
    this.identityAbort = undefined;
    this.identityAttempt = 0;
    if (!connection || !this.supported()) return;
    this.fingerprint = networkFingerprint();
    this.timer = setInterval(() => {
      if (this.suspended) return;
      const next = networkFingerprint();
      if (next !== this.fingerprint) {
        this.fingerprint = next;
        this.refreshConnection();
      }
    }, 5000);
    this.timer.unref();
    await this.identify(connection, generation);
  }
  private async identify(connection: DesktopEnrollmentConnection, generation: number) {
    if (generation !== this.generation || this.suspended || this.identityAbort || this.deploymentId)
      return;
    const controller = new AbortController();
    this.identityAbort = controller;
    try {
      const response = await fetch(
        `${connection.serverUrl}/api/v0/machines/channel/browser-network-identity`,
        {
          headers: this.headers(connection),
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        }
      );
      if (!response.ok) return;
      const value = (await response.json()) as { deploymentId: string };
      if (!/^[\da-f-]{36}$/i.test(value.deploymentId)) return;
      const allowed = await this.grants.allowed(connection.serverUrl, value.deploymentId);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.deploymentId = value.deploymentId;
      this.allowed = allowed;
      this.identityAttempt = 0;
      this.connect();
    } catch {
      /* Unavailable or invalid identity never grants sharing. Retry without re-enrollment. */
    } finally {
      if (this.identityAbort === controller) {
        this.identityAbort = undefined;
        if (generation === this.generation && !this.suspended && !this.deploymentId) {
          this.retry = setTimeout(
            () => void this.identify(connection, generation),
            Math.min(30_000, 1000 * 2 ** Math.min(this.identityAttempt++, 5)) *
              (0.8 + Math.random() * 0.4)
          );
          this.retry.unref();
        }
      }
    }
  }
  private headers(connection: DesktopEnrollmentConnection) {
    return {
      authorization: `Bearer ${connection.credential}`,
      "x-openteam-machine-id": this.machineId,
      "x-openteam-connection-id": connection.connectionId,
    };
  }
  private refreshConnection() {
    this.client?.stop();
    this.client = undefined;
    clearTimeout(this.retry);
    this.identityAbort?.abort();
    this.identityAbort = undefined;
    if (!this.connection || this.suspended || !this.supported()) return;
    if (this.deploymentId) this.connect();
    else void this.identify(this.connection, this.generation);
  }
  private connect() {
    const connection = this.connection;
    if (!connection || !this.allowed || !this.deploymentId || this.suspended || this.client) return;
    const url = new URL(`${connection.serverUrl}/api/v0/machines/channel/browser-network`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.client = new BrowserNetworkClient({
      url: url.href,
      headers: this.headers(connection),
      role: "device",
      machineId: this.machineId,
      deploymentId: this.deploymentId,
    });
    this.client.start();
  }
  async setAllowed(enabled: boolean) {
    const revision = ++this.permissionRevision;
    const connection = this.connection,
      deploymentId = this.deploymentId,
      generation = this.generation;
    if (!connection || !deploymentId || !this.supported())
      throw new Error("Connect this computer to an updated OpenTeam server first.");
    if (!enabled) {
      this.allowed = false;
      this.client?.stop();
      this.client = undefined;
    }
    await this.grants.set(connection.serverUrl, deploymentId, enabled);
    if (generation === this.generation && revision === this.permissionRevision) {
      this.allowed = enabled;
      this.connect();
    }
    return this.status();
  }
  setSuspended(suspended: boolean) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    this.fingerprint = networkFingerprint();
    this.refreshConnection();
  }
  status(): NetworkSharingStatus {
    return {
      supported: this.supported(),
      connected: !!this.connection && !!this.deploymentId,
      sharingAllowed: this.allowed,
      providing: !!this.client?.available(),
      serverUrl: this.connection?.serverUrl ?? null,
      deploymentId: this.deploymentId,
      activeConnections: this.client?.status().activeConnections ?? 0,
    };
  }
  stop() {
    void this.configure(null);
  }
}
