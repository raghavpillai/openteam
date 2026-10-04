import {credentialConnections, credentialConnectionId} from "./capability-settings";
import { createHash } from "node:crypto";
import { credentialRules, matchCredentialRules } from "./credential-domain";
import { type NativeCommand } from "./native-command";
import type { CapabilitySettingsStore } from "./capability-settings";
export function credentialOrigin(site: string): string {
  const url = new URL(site.includes("://") ? site : `https://${site}`);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("Saved logins require HTTPS or a loopback origin");
  return url.origin;
}
const itemRevision = (item: Record<string, any>) => `updated_at:${item.updated_at ?? ""}`;
const credentialJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Credential provider returned invalid JSON; no values were exposed");
  }
};
export class SavedCredentials {
  constructor(
    private readonly settings: CapabilitySettingsStore,
    private readonly run: NativeCommand = async () => { throw new Error("Connect a 1Password service account. Local vault reads are disabled."); }
  ) {}
  async status(signal?: AbortSignal) {
    const connections = credentialConnections(await this.settings.read());
    if (!connections.length) return {kind:"not-connected",connected:false,provider:"1password",setup:"Connect 1Password with a service account token in Marketplace → 1Password."};
    const statuses = await Promise.all(connections.map(async config => {
      const connection_id = credentialConnectionId(config);
      try {
        const items=credentialJson(await this.run("op",["item","list","--account",config.account,"--vault",config.vault,"--format=json"],signal));
        if(!Array.isArray(items))throw new Error("Invalid item metadata");
        return {connection_id,kind:"connected",itemCount:items.length,needsAttention:false};
      } catch (error) {
        signal?.throwIfAborted();
        return {connection_id,kind:"unavailable",itemCount:0,needsAttention:true,setup:"Renew the service account token in Marketplace → 1Password."};
      }
    }));
    return {kind:"connected",connected:statuses.some(item=>!item.needsAttention),provider:"1password",connectionCount:statuses.length,itemCount:statuses.reduce((sum,item)=>sum+item.itemCount,0),connectionsNeedingAttention:statuses.filter(item=>item.needsAttention).length,connections:statuses};
  }

  async list(args: { site?: string; query?: string }, signal?: AbortSignal) {
    const settings = await this.settings.read();
    const configurations = credentialConnections(settings);
    if (!configurations.length) return { credentials: [], ...(await this.status(signal)) };
    const unavailableConnections: string[] = [];
    const allCredentials = [];
    const origin = args.site ? credentialOrigin(args.site) : null;
    for (const config of configurations) {
    let raw: any;
    try { raw = credentialJson(
      await this.run(
        "op",
        [
          "item",
          "list",
          "--categories=Login,Password",
          "--account",
          config.account,
          "--vault",
          config.vault,
          "--format=json",
        ],
        signal
      )
    ); } catch { signal?.throwIfAborted(); unavailableConnections.push(credentialConnectionId(config)); continue; }
    if (!Array.isArray(raw)) { unavailableConnections.push(credentialConnectionId(config)); continue; }
    const connection_id = `1password:${config.account}:${config.vault}`;
    const credentials = raw.flatMap((item) => {
      const sites = (Array.isArray(item.urls) ? item.urls : []).flatMap((url: any) => {
        try {
          return [credentialOrigin(url.href)];
        } catch {
          return [];
        }
      });
      const targetRules = credentialRules(item.urls ?? []);
      if (origin && !matchCredentialRules(targetRules, origin)) return [];
      if (args.query && !String(item.title).toLowerCase().includes(args.query.toLowerCase()))
        return [];
      const view = {
        credential_id: String(item.id),
        connection_id,
        title: String(item.title),
        category: String(item.category),
        provider_revision: itemRevision(item),
        sites,
        targetRules,
        autoFill: true,
      };
      return [
        {
          ...view,
          catalog_revision: createHash("sha256")
            .update(JSON.stringify({ ...view, updated_at: item.updated_at }))
            .digest("hex"),
        },
      ];
    });
    allCredentials.push(...credentials);
    }
    return { connected: unavailableConnections.length < configurations.length, credentials:allCredentials, unavailableConnections };
  }
  async automatic(site: string, signal?: AbortSignal) {
    const settings = await this.settings.read();
    if (!credentialConnections(settings).length) return { skipped: true };
    const list = await this.list({ site }, signal);
    if (
      list.credentials.length !== 1 ||
      !list.credentials[0]!.autoFill
    )
      return { skipped: true };
    return this.use({ ...list.credentials[0], site, automatic: true }, signal);
  }
  async use(args: Record<string, any>, signal?: AbortSignal) {
    const epoch = (await this.settings.read()).revocationEpoch ?? 0;
    const origin = credentialOrigin(args.site);
    const list = await this.list({ site: origin }, signal);
    const matches = list.credentials;
    const item = matches.find(
      (x) =>
        x.credential_id === args.credential_id &&
        x.connection_id === args.connection_id &&
        x.catalog_revision === args.catalog_revision
    );
    if (!item)
      throw new Error(
        "The saved login changed, was revoked, or does not match this live origin. List credentials again."
      );
    if (args.automatic === true && matches.length !== 1) return { skipped: true };
    const fresh = await this.list({ site: origin }, signal);
    if (
      !fresh.credentials.some(
        (x) =>
          x.credential_id === item.credential_id && x.catalog_revision === item.catalog_revision
      )
    )
      throw new Error("The login or its permission changed during review");
    const reviewedSettings = await this.settings.read();
    if ((reviewedSettings.revocationEpoch ?? 0) !== epoch)
      throw new Error("Credential access changed during review; list credentials again");
    const config = credentialConnections(reviewedSettings).find(provider => credentialConnectionId(provider) === item.connection_id);
    if (!config) throw new Error("Credential provider was disconnected");
    const raw = credentialJson(
      await this.run(
        "op",
        [
          "item",
          "get",
          item.credential_id,
          "--account",
          config.account,
          "--vault",
          config.vault,
          "--format=json",
        ],
        signal
      )
    );
    if (itemRevision(raw) !== item.provider_revision)
      throw new Error("The login changed during retrieval; list credentials again");
    const sites = (raw.urls ?? []).flatMap((url: any) => {
      try {
        return [credentialOrigin(url.href)];
      } catch {
        return [];
      }
    });
    if (!matchCredentialRules(credentialRules(raw.urls ?? []), origin))
      throw new Error("The login target changed during retrieval");
    const username = raw.fields?.find((f: any) => f.purpose === "USERNAME")?.value;
    const password = raw.fields?.find((f: any) => f.purpose === "PASSWORD")?.value;
    if (typeof password !== "string" || !password)
      throw new Error("The saved item has no usable password");
    if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
      throw new Error("Credential access was revoked during retrieval");
    // Private bridge payload, consumed only by browser filling code, never a tool result.
    return { origin, username: typeof username === "string" ? username : undefined, password };
  }
}
