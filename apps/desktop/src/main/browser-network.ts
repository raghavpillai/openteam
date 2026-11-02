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
    if (!connection || !this.supported()) return;
    try {
      const response = await fetch(
        `${connection.serverUrl}/api/v0/machines/channel/browser-network-identity`,
        {
          headers: this.headers(connection),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!response.ok) return;
      const value = (await response.json()) as { deploymentId: string };
      if (!/^[\da-f-]{36}$/i.test(value.deploymentId)) return;
      const allowed = await this.grants.allowed(connection.serverUrl, value.deploymentId);
      if (generation !== this.generation) return;
      this.deploymentId = value.deploymentId;
      this.allowed = allowed;
      this.connect();
      this.fingerprint = this.networkFingerprint();
      this.timer = setInterval(() => {
        const next = this.networkFingerprint();
        if (next !== this.fingerprint) {
          this.fingerprint = next;
          this.client?.stop();
          this.client = undefined;
          this.connect();
        }
      }, 5000);
      this.timer.unref();
    } catch {
      /* Old servers and unavailable identity never grant sharing. */
    }
  }
  private headers(connection: DesktopEnrollmentConnection) {
    return {
      authorization: `Bearer ${connection.credential}`,
      "x-openteam-machine-id": this.machineId,
      "x-openteam-connection-id": connection.connectionId,
    };
  }
  private networkFingerprint() {
    return JSON.stringify(networkInterfaces());
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
    this.suspended = suspended;
    this.client?.stop();
    this.client = undefined;
    if (!suspended) this.connect();
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
