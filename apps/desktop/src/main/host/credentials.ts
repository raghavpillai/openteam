import { credentialConnections, credentialConnectionId } from "./capability-settings";
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
const credentialJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Credential provider returned invalid JSON; no values were exposed");
  }
};
/** Login metadata for the settings page. The agent reads vaults with the 1Password CLI on its box. */
export class SavedCredentials {
  constructor(
    private readonly settings: CapabilitySettingsStore,
    private readonly run: NativeCommand = async () => { throw new Error("Connect a 1Password service account. Local vault reads are disabled."); }
  ) {}

  async list(signal?: AbortSignal) {
    const configurations = credentialConnections(await this.settings.read());
    const unavailableConnections: string[] = [];
    const credentials = [];
    for (const config of configurations) {
      let raw: any;
      try {
        raw = credentialJson(
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
      } catch {
        signal?.throwIfAborted();
        unavailableConnections.push(credentialConnectionId(config));
        continue;
      }
      if (!Array.isArray(raw)) {
        unavailableConnections.push(credentialConnectionId(config));
        continue;
      }
      const connection_id = credentialConnectionId(config);
      credentials.push(
        ...raw.map((item) => ({
          credential_id: String(item.id),
          connection_id,
          title: String(item.title),
          category: String(item.category),
          sites: (Array.isArray(item.urls) ? item.urls : []).flatMap((url: any) => {
            try {
              return [credentialOrigin(url.href)];
            } catch {
              return [];
            }
          }),
        }))
      );
    }
    return {
      connected: unavailableConnections.length < configurations.length,
      credentials,
      unavailableConnections,
    };
  }
}
