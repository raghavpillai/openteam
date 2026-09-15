import { createHash } from "node:crypto";
import { credentialRules, matchCredentialRules } from "./credential-domain";
import { nativeCommand, type NativeCommand } from "./native-command";
import type { CapabilitySettingsStore, NativeConsent } from "./capability-settings";
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
const itemRevision = (item: Record<string, any>, kind?: string) =>
  kind?.startsWith("updated_at:") || item.version === undefined
    ? `updated_at:${item.updated_at ?? ""}`
    : `version:${item.version}`;
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
    private readonly consent: NativeConsent,
    private readonly run: NativeCommand = nativeCommand
  ) {}
  async status(signal?: AbortSignal) {
    const { credentialProvider } = await this.settings.read();
    if (!credentialProvider)
      return {
        kind: "not-connected",
        connected: false,
        provider: "1password",
        setup:
          "In Computer settings, configure the 1Password account and vault IDs. Install the 1Password CLI and enable its desktop app integration.",
      };
    try {
      await this.run(
        "op",
        ["whoami", "--account", credentialProvider.account, "--format=json"],
        signal
      );
      const items = credentialJson(await this.run("op", ["item", "list", "--account", credentialProvider.account, "--vault", credentialProvider.vault, "--format=json"], signal));
      if (!Array.isArray(items)) throw new Error("Invalid item metadata");
      return {
        kind: "connected", connectionCount: 1, itemCount: items.length, connectionsNeedingAttention: 0,
        connected: true,
        provider: "1password",
        connection_id: `1password:${credentialProvider.account}:${credentialProvider.vault}`,
      };
    } catch {
      return {
        kind: "unavailable",
        connected: false,
        provider: "1password",
        setup:
          "Unlock 1Password, enable CLI desktop integration, and verify the configured account.",
      };
    }
  }
  async list(args: { site?: string; query?: string }, signal?: AbortSignal) {
    const settings = await this.settings.read();
    const config = settings.credentialProvider;
    if (!config) return { credentials: [], ...(await this.status(signal)) };
    const origin = args.site ? credentialOrigin(args.site) : null;
    const raw = credentialJson(
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
    );
    if (!Array.isArray(raw)) throw new Error("The credential provider returned invalid metadata");
    const connection_id = `1password:${config.account}:${config.vault}`;
    const credentials = raw.flatMap((item) => {
      const sites = (Array.isArray(item.urls) ? item.urls : []).flatMap((url: any) => {
        try {
          return [credentialOrigin(url.href)];
        } catch {
          return [];
        }
      });
      const targetRules = credentialRules(sites);
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
        autoFill: settings.autoFill.includes(`${connection_id}:${item.id}`),
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
    return { connected: true, credentials };
  }
  async automatic(site: string, signal?: AbortSignal) {
    const settings = await this.settings.read();
    if (!settings.credentialProvider || !settings.autoFill.length) return { skipped: true };
    const list = await this.list({ site }, signal);
    if (
      list.credentials.length !== 1 ||
      !list.credentials[0]!.autoFill ||
      !matchCredentialRules(list.credentials[0]!.targetRules, site, true)
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
    const automaticAllowed =
      item.autoFill && matches.length === 1 && matchCredentialRules(item.targetRules, origin, true);
    if (args.automatic === true && !automaticAllowed) return { skipped: true };
    if (args.automatic !== true && !automaticAllowed) {
      const decision = await this.consent({
        title: "Use saved login?",
        detail: `${item.title}\n${origin}\n${String(args.purpose ?? "Sign in to continue the task")}\n\nOpenTeam will fill this browser page. The bot never receives the username or password.`,
      });
      if (decision === "deny")
        throw new Error("Saved login use denied. Do not retry unless asked.");
    }
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
    const config = reviewedSettings.credentialProvider;
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
    if (itemRevision(raw, item.provider_revision) !== item.provider_revision)
      throw new Error("The login changed during retrieval; list credentials again");
    const sites = (raw.urls ?? []).flatMap((url: any) => {
      try {
        return [credentialOrigin(url.href)];
      } catch {
        return [];
      }
    });
    if (!matchCredentialRules(credentialRules(sites), origin))
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
