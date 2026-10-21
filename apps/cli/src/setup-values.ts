import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { SetupStage } from "./ui";

export const ACCESS_MODES = ["private", "local", "https", "proxy", "http", "tailscale"] as const;
export const ACCESS_CHOICES = [
  {
    title: "Private network",
    description: "A Tailscale, WireGuard, or LAN address that only your devices can reach.",
    recommended: true,
    value: "private",
  },
  {
    title: "This machine only",
    description: "For this computer, local development, or an SSH tunnel.",
    value: "local",
  },
  {
    title: "Public domain with automatic HTTPS",
    description: "Best for access from anywhere. Requires a domain pointed at this server.",
    value: "https",
  },
  {
    title: "Use my existing HTTPS setup",
    description: "For an existing nginx, Caddy, Traefik, or cloud proxy.",
    value: "proxy",
  },
  {
    title: "Public address without HTTPS",
    description: "For temporary testing only. Passwords are not encrypted in transit.",
    value: "http",
  },
  {
    title: "Tailscale HTTPS",
    description: "Create a private HTTPS address with Tailscale Serve on this server.",
    value: "tailscale",
  },
] as const;
export const SETUP_STAGES: readonly SetupStage[] = [
  { label: "Connection", description: "Choose where you want to use OpenTeam from." },
  { label: "Account", description: "Create the username and password you will sign in with." },
  { label: "Review", description: "Check your choices, then start OpenTeam." },
  { label: "Checks", description: "Make sure everything is ready." },
] as const;
export const HTTP_WARNINGS = [
  "Without HTTPS, other people on the network may be able to see your password and session.",
  "Use it only for temporary testing, then switch to a private network or HTTPS.",
] as const;

export type AccessMode = (typeof ACCESS_MODES)[number];

/** Networking and account choices. Models are connected later in the apps. */
export interface SetupConfiguration {
  accessMode: AccessMode;
  timeZone: string;
  workerConcurrency: string;
  apiPort: string;
  bindHost: "127.0.0.1" | "0.0.0.0";
  viewerBindHost: "127.0.0.1" | "0.0.0.0";
  publicHost: string;
  publicUrl: string;
  composeProfiles: "https" | "direct";
  ownerUsername: string;
  ownerPassword?: string;
}

const USERNAME_SEPARATORS = "-_.";

/**
 * Usernames: 3–30 letters, numbers, dashes, underscores or dots, starting and ending with a letter
 * or number. The case you type is kept for display; signing in works in any case. The server
 * applies the same rules (apps/server/src/username.ts).
 */
export const validateOwnerUsername = (value: string): string => {
  const username = value.trim();
  if (!username) throw new Error("Enter a username.");
  if (/\s/.test(username)) throw new Error("Usernames can't contain spaces.");
  const invalid = [...username].find(
    (character) => !/[A-Za-z0-9]/.test(character) && !USERNAME_SEPARATORS.includes(character)
  );
  if (invalid) {
    throw new Error(
      `"${invalid}" isn't allowed. Use letters, numbers, dashes, underscores, or dots.`
    );
  }
  if (username.length < 3 || username.length > 30) throw new Error("Use 3 to 30 characters.");
  if (
    USERNAME_SEPARATORS.includes(username[0]!) ||
    USERNAME_SEPARATORS.includes(username.at(-1)!)
  ) {
    throw new Error("Start and end with a letter or number.");
  }
  if (/[-_.]{2}/.test(username)) throw new Error("Use one dash, underscore, or dot at a time.");
  return username;
};

export const validateOwnerPassword = (value: string): string => {
  if (value.length < 8 || value.length > 128) {
    throw new Error("Password must be between 8 and 128 characters.");
  }
  return value;
};

const singleLine = (label: string, value: string): string => {
  if (!value || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line value.`);
  }
  return value;
};

export const validateTimeZone = (value: string): string => {
  const normalized = singleLine("Time zone", value);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format();
    return normalized;
  } catch {
    throw new Error("Enter a valid IANA time zone, such as America/New_York.");
  }
};

export const validateIntegerInRange =
  (label: string, minimum: number, maximum: number) =>
  (value: string): string => {
    if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
    const parsed = Number(value);
    if (parsed < minimum || parsed > maximum) {
      throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
    }
    return String(parsed);
  };

export const validateAccessMode = (value: string): AccessMode => {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, AccessMode> = {
    "1": "private",
    private: "private",
    vpn: "private",
    tailnet: "private",
    "2": "local",
    local: "local",
    loopback: "local",
    "3": "https",
    https: "https",
    public: "https",
    "public-https": "https",
    "4": "proxy",
    proxy: "proxy",
    "external-proxy": "proxy",
    "5": "http",
    http: "http",
    "public-http": "http",
    "6": "tailscale",
    tailscale: "tailscale",
  };
  const selected = aliases[normalized];
  if (selected) return selected;
  throw new Error("Choose 1, 2, 3, 4, 5, or 6.");
};

export const accessLabel = (value: AccessMode): string =>
  ({
    tailscale: "Tailscale HTTPS",
    https: "Public domain with HTTPS",
    proxy: "Existing HTTPS setup",
    http: "Public address without HTTPS",
    private: "Private network",
    local: "This machine only",
  })[value];

const privateAddressRank = (address: string): number | null => {
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 0;
  if (/^192\.168\./.test(address)) return 1;
  if (/^10\./.test(address)) return 2;
  const match = address.match(/^172\.(\d+)\./);
  if (match?.[1] && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 3;
  return null;
};

export const detectPrivateNetworkHost = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string | null => {
  const candidates: Array<{ address: string; rank: number }> = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(?:docker|br-|veth|virbr|podman|cni|flannel)/i.test(name)) continue;
    for (const address of addresses || []) {
      if (address.internal || address.family !== "IPv4") continue;
      const rank = privateAddressRank(address.address);
      if (rank !== null) candidates.push({ address: address.address, rank });
    }
  }
  candidates.sort((left, right) => left.rank - right.rank);
  return candidates[0]?.address || null;
};

export const validatePublicHost = (value: string): string => {
  const normalized = singleLine("Hostname or IPv4 address", value).toLowerCase();
  if (/^\d+(?:\.\d+){3}$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) return normalized;
    throw new Error("Enter a valid IPv4 address.");
  }
  if (
    normalized.length > 253 ||
    !normalized
      .split(".")
      .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  ) {
    throw new Error("Enter a hostname or IPv4 address clients can reach.");
  }
  return normalized;
};

export const validatePublicDomain = (value: string): string => {
  const normalized = validatePublicHost(value);
  if (
    isIP(normalized) !== 0 ||
    !normalized.includes(".") ||
    /\.(?:local|internal|localhost|home\.arpa)$/i.test(normalized)
  ) {
    throw new Error("Enter a public domain name, such as bot.example.com.");
  }
  return normalized;
};

export const validateProxyHost = (value: string): string => {
  const parts = value.split(":");
  const host = validatePublicDomain(parts[0] ?? "");
  if (parts.length === 1) return host;
  const port = parts[1] ?? "";
  if (parts.length !== 2 || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Enter a hostname with an optional HTTPS port from 1 to 65535.");
  }
  return Number(port) === 443 ? host : `${host}:${Number(port)}`;
};

export const configuredAccessMode = (
  current: ReadonlyMap<string, string>,
  fresh: boolean
): AccessMode => {
  const stored = current.get("OPENTEAM_ACCESS_MODE") as AccessMode | undefined;
  return !fresh && stored && ACCESS_MODES.includes(stored) ? stored : "private";
};

const hostFromPublicUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" ? url.host : url.hostname) || null;
  } catch {
    return null;
  }
};

export const existingReachableHost = (current: ReadonlyMap<string, string>): string | null => {
  const existingPublicHost = current.get("OPENTEAM_PUBLIC_HOST");
  const existingUrlHost = hostFromPublicUrl(current.get("OPENTEAM_PUBLIC_URL"));
  return existingUrlHost && existingUrlHost !== "127.0.0.1"
    ? existingUrlHost
    : existingPublicHost && existingPublicHost !== "127.0.0.1"
      ? existingPublicHost
      : null;
};

export const publicUrlFor = (mode: AccessMode, host: string, apiPort: string): string => {
  if (mode === "https" || mode === "proxy" || mode === "tailscale") return `https://${host}`;
  const port = apiPort === "80" ? "" : `:${apiPort}`;
  return `http://${host}${port}`;
};

export const bindHostsFor = (
  mode: AccessMode,
  reachableHost: string
): Pick<SetupConfiguration, "bindHost" | "viewerBindHost" | "publicHost" | "composeProfiles"> => ({
  bindHost: mode === "http" || mode === "private" ? "0.0.0.0" : "127.0.0.1",
  viewerBindHost: mode === "private" ? "0.0.0.0" : "127.0.0.1",
  publicHost: mode === "private" ? reachableHost : "127.0.0.1",
  composeProfiles: mode === "https" ? "https" : "direct",
});

export const accessModeNotes = (
  mode: AccessMode
): ReadonlyArray<{ text: string; tone: "info" | "success" | "warning" }> => {
  const notes: Array<{ text: string; tone: "info" | "success" | "warning" }> = [];
  if (mode === "tailscale") {
    notes.push({
      text: "OpenTeam will configure Tailscale Serve. Keep Tailscale connected on all your devices. Backend ports stay on this machine only.",
      tone: "info",
    });
  } else if (mode === "https") {
    notes.push({
      text: "OpenTeam will use ports 80 and 443 and keep the HTTPS certificate renewed.",
      tone: "info",
    });
  } else if (mode === "proxy") {
    notes.push({
      text: "Point your HTTPS proxy to the local address shown on the review step.",
      tone: "info",
    });
  } else if (mode === "private") {
    notes.push({
      text: "Traffic is not encrypted. Only use this on a private network you trust.",
      tone: "warning",
    });
  }
  return notes;
};
