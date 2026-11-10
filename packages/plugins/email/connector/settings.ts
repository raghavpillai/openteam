import { resolveMx } from "node:dns/promises";

/** One mail server: implicit TLS (`secure`), STARTTLS, or plaintext for a local bridge. */
export interface Endpoint {
  host: string;
  port: number;
  secure: boolean;
  starttls: boolean;
}
export interface MailSettings {
  address: string;
  username: string;
  password: string;
  imap: Endpoint;
  smtp: Endpoint;
  /** How the endpoints were chosen, for get_mailbox and error messages. */
  detectedBy: string;
  /** The user's own addresses: their verified mail is marked as from the owner. */
  owners: string[];
}
type Pair = { imap: string; smtp: string };

const ADDRESS = /^[^\s@<>,;"]+@([^\s@<>,;"]+\.[^\s@<>,;"]+)$/;

/** Providers whose address domain or MX host identifies the servers. */
const PROVIDERS: Array<{ name: string; domains: string[]; mx?: RegExp; servers: Pair }> = [
  {
    name: "Gmail / Google Workspace",
    domains: ["gmail.com", "googlemail.com"],
    mx: /(^|\.)(google|googlemail)\.com$/,
    servers: { imap: "imap.gmail.com:993", smtp: "smtp.gmail.com:465" },
  },
  {
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    mx: /(^|\.)icloud\.com$/,
    servers: { imap: "imap.mail.me.com:993", smtp: "smtp.mail.me.com:587" },
  },
  {
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    mx: /(^|\.)messagingengine\.com$/,
    servers: { imap: "imap.fastmail.com:993", smtp: "smtp.fastmail.com:465" },
  },
  {
    name: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    mx: /(^|\.)yahoodns\.net$/,
    servers: { imap: "imap.mail.yahoo.com:993", smtp: "smtp.mail.yahoo.com:465" },
  },
  {
    name: "AOL Mail",
    domains: ["aol.com"],
    servers: { imap: "imap.aol.com:993", smtp: "smtp.aol.com:465" },
  },
  {
    name: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    mx: /(^|\.)zoho\.(com|eu|in)$/,
    servers: { imap: "imap.zoho.com:993", smtp: "smtp.zoho.com:465" },
  },
  {
    name: "Purelymail",
    domains: ["purelymail.com"],
    mx: /(^|\.)purelymail\.com$/,
    servers: { imap: "imap.purelymail.com:993", smtp: "smtp.purelymail.com:465" },
  },
];

/** Providers that cannot work with an address and app password. */
const UNSUPPORTED: Array<{ domains: string[]; mx: RegExp; reason: string }> = [
  {
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    mx: /(^|\.)(outlook\.com|protection\.outlook\.com)$/,
    reason:
      "Microsoft (Outlook.com and Microsoft 365) only allows OAuth sign-in for mail apps, so an app password cannot connect. Use another mailbox for the Bot.",
  },
  {
    domains: ["proton.me", "protonmail.com", "pm.me", "protonmail.ch"],
    mx: /(^|\.)protonmail\.ch$/,
    reason:
      "Proton Mail needs Proton Mail Bridge (paid plans). Run Bridge where the Bot computer can reach it, then enter its IMAP and SMTP addresses (for example imap://bridge-host:1143 and smtp://bridge-host:1025) and the Bridge password.",
  },
];

/** `host`, `host:port`, or `imap://` / `smtp://` (plaintext or STARTTLS) and `imaps://` / `smtps://`. */
export function parseEndpoint(value: string, kind: "imap" | "smtp"): Endpoint {
  const trimmed = value.trim();
  const scheme = /^([a-z]+):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && ![kind, `${kind}s`].includes(scheme))
    throw new Error(`${kind.toUpperCase()} server must use ${kind}:// or ${kind}s://`);
  const rest = scheme ? trimmed.slice(scheme.length + 3) : trimmed;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(rest);
  if (!match) throw new Error(`Invalid ${kind.toUpperCase()} server: ${value}`);
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const implicit = kind === "imap" ? 993 : 465;
  const port = match[2]
    ? Number(match[2])
    : scheme === kind
      ? kind === "imap"
        ? 143
        : 587
      : implicit;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Invalid ${kind.toUpperCase()} port: ${value}`);
  if (scheme === `${kind}s`) return { host, port, secure: true, starttls: false };
  // A bare host follows the port's convention; an explicit imap:// or smtp:// URL upgrades
  // with STARTTLS when the server offers it (a local Proton Bridge or test server may not).
  if (scheme === kind) return { host, port, secure: false, starttls: false };
  return port === implicit || port === 993 || port === 465
    ? { host, port, secure: true, starttls: false }
    : { host, port, secure: false, starttls: true };
}

type Lookup = {
  mx: (domain: string) => Promise<string[]>;
  ispdb: (domain: string) => Promise<Pair | null>;
};

const defaultLookup: Lookup = {
  mx: async (domain) =>
    (await resolveMx(domain))
      .sort((a, b) => a.priority - b.priority)
      .map((record) => record.exchange.toLowerCase()),
  ispdb: async (domain) => {
    const response = await fetch(
      `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
      {
        signal: AbortSignal.timeout(8_000),
      }
    );
    return response.ok ? parseIspdb(await response.text()) : null;
  },
};

/** Thunderbird's provider database: the first IMAP and SMTP servers with TLS. */
export function parseIspdb(xml: string): Pair | null {
  const servers = (tag: string, type: string) =>
    [...xml.matchAll(new RegExp(`<${tag}\\s+type="${type}">([\\s\\S]*?)</${tag}>`, "g"))].map(
      (match) => ({
        host: /<hostname>([^<]+)<\/hostname>/.exec(match[1]!)?.[1]?.trim(),
        port: /<port>(\d+)<\/port>/.exec(match[1]!)?.[1],
        socket: /<socketType>([^<]+)<\/socketType>/.exec(match[1]!)?.[1]?.trim(),
      })
    );
  const pick = (list: ReturnType<typeof servers>) =>
    list.find((server) => server.host && server.port && /SSL|STARTTLS/i.test(server.socket ?? ""));
  const imap = pick(servers("incomingServer", "imap"));
  const smtp = pick(servers("outgoingServer", "smtp"));
  if (!imap || !smtp || imap.host!.includes("%") || smtp.host!.includes("%")) return null;
  return { imap: `${imap.host}:${imap.port}`, smtp: `${smtp.host}:${smtp.port}` };
}

const unsupported = (domain: string, mxHosts: string[]) =>
  UNSUPPORTED.find(
    (entry) => entry.domains.includes(domain) || mxHosts.some((host) => entry.mx.test(host))
  );

/** Finds the servers for an address: known providers, then MX hosts, then Thunderbird's database. */
export async function detectServers(
  address: string,
  lookup: Lookup = defaultLookup
): Promise<{ servers: Pair; detectedBy: string }> {
  const domain = ADDRESS.exec(address)?.[1]?.toLowerCase();
  if (!domain) throw new Error("Enter the mailbox's full email address");
  const known = PROVIDERS.find((provider) => provider.domains.includes(domain));
  if (known) return { servers: known.servers, detectedBy: known.name };
  const blocked = unsupported(domain, []);
  if (blocked) throw new Error(blocked.reason);
  const mxHosts = await lookup.mx(domain).catch(() => []);
  const hosted = unsupported(domain, mxHosts);
  if (hosted) throw new Error(hosted.reason);
  const byMx = PROVIDERS.find((provider) => mxHosts.some((host) => provider.mx?.test(host)));
  if (byMx) return { servers: byMx.servers, detectedBy: `${byMx.name} (mail for ${domain})` };
  const listed = await lookup.ispdb(domain).catch(() => null);
  if (listed) return { servers: listed, detectedBy: "Thunderbird provider database" };
  throw new Error(
    `Could not find the mail servers for ${domain}. Enter the IMAP and SMTP servers from your provider's mail-app settings.`
  );
}

const automatic = (value: string | undefined) =>
  !value?.trim() || value.trim().toLowerCase() === "auto";

/** `none`, or addresses separated by commas or spaces. */
export function parseOwnerAddresses(value: string | undefined): string[] {
  const text = value?.trim() ?? "";
  if (!text || text.toLowerCase() === "none") return [];
  const owners = [...new Set(text.split(/[\s,;]+/).filter(Boolean).map((entry) => entry.toLowerCase()))];
  const invalid = owners.filter((entry) => !ADDRESS.test(entry));
  if (invalid.length)
    throw new Error(`Your own addresses must be plain email addresses separated by commas: ${invalid.join(", ")}`);
  return owners;
}

/** Reads the account fields OpenTeam passes as environment variables. */
export async function loadSettings(
  env: Record<string, string | undefined> = process.env,
  lookup?: Lookup
): Promise<MailSettings> {
  const address = env.EMAIL_ADDRESS?.trim().toLowerCase() ?? "";
  if (!ADDRESS.test(address)) throw new Error("Enter the mailbox's full email address");
  const password = env.EMAIL_PASSWORD ?? "";
  if (!password) throw new Error("Enter the mailbox password or app password");
  let detectedBy = "account settings";
  let servers: Pair | undefined;
  if (automatic(env.IMAP_SERVER) || automatic(env.SMTP_SERVER)) {
    const detected = await detectServers(address, lookup);
    servers = detected.servers;
    detectedBy = detected.detectedBy;
  }
  return {
    address,
    username: automatic(env.EMAIL_USERNAME) ? address : env.EMAIL_USERNAME!.trim(),
    password,
    imap: parseEndpoint(automatic(env.IMAP_SERVER) ? servers!.imap : env.IMAP_SERVER!, "imap"),
    smtp: parseEndpoint(automatic(env.SMTP_SERVER) ? servers!.smtp : env.SMTP_SERVER!, "smtp"),
    detectedBy,
    owners: parseOwnerAddresses(env.OWNER_ADDRESSES),
  };
}
