import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { ReusableProvider } from "./detected-logins";
import type { RuntimeInferenceSettings } from "./runtime-settings";
import type { SetupStage } from "./ui";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_RUNTIME_INFERENCE: RuntimeInferenceSettings = {
  providerId: "openai-codex",
  modelId: "gpt-5.5",
  reasoning: "high",
};
export const ACCESS_MODES = ["private", "local", "https", "proxy", "http"] as const;
export const CUSTOM_PROVIDER_APIS = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const BUILTIN_PROVIDER_CHOICES = [
  {
    label: "OpenAI with ChatGPT Plus/Pro",
    description: "Authenticate Pi through the OpenAI Codex OAuth provider.",
    value: "openai-codex",
  },
  {
    label: "Anthropic with Claude Pro/Max or an API key",
    description: "Use Claude Pro/Max OAuth or an Anthropic API key.",
    value: "anthropic",
  },
  {
    label: "OpenAI with an API key",
    description: "Use an OpenAI API key with a directly billed model.",
    value: "openai",
  },
] as const;
export const CUSTOM_PROVIDER_CHOICE = {
  label: "Custom or generic provider",
  description: "Configure an OpenAI-, Anthropic-, or Google-compatible endpoint and password.",
  value: "custom",
} as const;
export const DEFAULT_PROVIDER_MODELS: Readonly<Record<string, string>> = {
  "openai-codex": "gpt-5.5",
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.5",
};
export const ACCESS_CHOICES = [
  {
    title: "Private network",
    description: "A Tailscale, WireGuard, or LAN address that only your devices can reach.",
    value: "private",
  },
  {
    title: "This machine only",
    description: "Loopback for the desktop app on this computer or an SSH tunnel.",
    value: "local",
  },
  {
    title: "Public HTTPS",
    description: "A public domain plus automatic TLS from the bundled Caddy proxy.",
    value: "https",
  },
  {
    title: "Existing HTTPS proxy",
    description: "Use nginx, Caddy, Traefik, or a cloud load balancer you already manage.",
    value: "proxy",
  },
  {
    title: "Public HTTP",
    description: "An IP or hostname without encryption; desktop/testing only, not iOS.",
    value: "http",
  },
] as const;
export const SETUP_STAGES: readonly SetupStage[] = [
  { label: "Access", description: "Choose how desktop and mobile apps reach this server." },
  { label: "Owner", description: "Create the single username and password for this OpenTeam." },
  { label: "Runtime", description: "Choose the Pi inference provider and model." },
  {
    label: "Review",
    description: "Check the configuration, then apply and verify the deployment.",
  },
] as const;
export const HTTP_WARNINGS = [
  "Public HTTP exposes the owner password and every session token to network observers.",
  "The iOS app rejects public cleartext connections. Use this only for temporary desktop testing.",
] as const;

export type AccessMode = (typeof ACCESS_MODES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export interface SetupConfiguration {
  accessMode: AccessMode;
  timeZone: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  workerConcurrency: string;
  apiPort: string;
  bindHost: "127.0.0.1" | "0.0.0.0";
  viewerBindHost: "127.0.0.1" | "0.0.0.0";
  publicHost: string;
  publicUrl: string;
  composeProfiles: "https" | "direct";
  ownerUsername: string;
  ownerPassword?: string;
  authenticate: boolean;
  authType: "oauth" | "api_key";
  apiKey?: string;
  customProvider?: SetupCustomProvider;
  /** Copy an existing vendor CLI sign-in into Pi instead of opening a browser. */
  reuseLogin?: { provider: ReusableProvider; source: string };
}

export interface SetupCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  model: string;
  reasoning: boolean;
}

export const validateOwnerUsername = (value: string): string => {
  const username = value.trim().toLowerCase();
  if (username.length < 3 || username.length > 30 || !/^[a-z0-9_.]+$/.test(username)) {
    throw new Error(
      "Username must be 3-30 characters and use only letters, numbers, underscores, or dots."
    );
  }
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

export const validateModel = (value: string): string => {
  const normalized = singleLine("Model", value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error("Model names may contain letters, numbers, dots, colons, slashes, or hyphens.");
  }
  return normalized;
};

export const validateProviderId = (value: string): string => {
  const normalized = singleLine("Inference provider", value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(
      "Provider ids may contain lowercase letters, numbers, dots, underscores, or hyphens."
    );
  }
  return normalized;
};

export const validateProviderName = (value: string): string => {
  const normalized = singleLine("Provider name", value).trim();
  if (normalized.length > 100) throw new Error("Provider name must be 100 characters or fewer.");
  return normalized;
};

export const validateProviderBaseUrl = (value: string): string => {
  const normalized = singleLine("Provider base URL", value);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Enter a valid provider base URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider base URL must use HTTP or HTTPS.");
  }
  return parsed.toString().replace(/\/$/, "");
};

export const validateCustomProviderApi = (value: string): CustomProviderApi => {
  const normalized = value.trim().toLowerCase();
  if (!CUSTOM_PROVIDER_APIS.includes(normalized as CustomProviderApi)) {
    throw new Error(`Choose one of: ${CUSTOM_PROVIDER_APIS.join(", ")}.`);
  }
  return normalized as CustomProviderApi;
};

export const validateProviderSelection = (value: string, currentProvider: string): string => {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "custom" ||
    normalized === currentProvider ||
    BUILTIN_PROVIDER_CHOICES.some((choice) => choice.value === normalized)
  ) {
    return normalized;
  }
  throw new Error("Choose openai-codex, anthropic, openai, or custom.");
};

export const defaultProviderAuthType = (providerId: string): "oauth" | "api_key" =>
  providerId === "openai-codex" || providerId === "anthropic" ? "oauth" : "api_key";

export const validateThinking = (value: string): ThinkingLevel => {
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new Error(`Choose one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return value as ThinkingLevel;
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
  };
  const selected = aliases[normalized];
  if (selected) return selected;
  throw new Error("Choose 1, 2, 3, 4, or 5.");
};

export const accessLabel = (value: AccessMode): string =>
  ({
    https: "Public HTTPS",
    proxy: "Existing HTTPS proxy",
    http: "Public HTTP",
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

/**
 * Like OpenClaw, keep the server private by default: the detected tailnet or LAN
 * address when there is one, otherwise loopback. Public modes are explicit choices.
 */
export const recommendedAccessMode = (detectedPrivateHost: string | null): AccessMode =>
  detectedPrivateHost ? "private" : "local";

export const configuredAccessMode = (
  current: ReadonlyMap<string, string>,
  fresh: boolean,
  detectedPrivateHost: string | null = null
): AccessMode => {
  const stored = current.get("OPENTEAM_ACCESS_MODE");
  if (stored && ACCESS_MODES.includes(stored as AccessMode)) {
    if (!fresh) return stored as AccessMode;
  }
  if (fresh) return recommendedAccessMode(detectedPrivateHost);
  const publicUrl = current.get("OPENTEAM_PUBLIC_URL") || "";
  if (publicUrl.startsWith("https://")) return "https";
  if (current.get("OPENTEAM_BIND_HOST") === "127.0.0.1") return "local";
  return "private";
};

const hostFromPublicUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
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
  if (mode === "https" || mode === "proxy") return `https://${host}`;
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
  if (mode === "https") {
    notes.push({
      text: "OpenTeam will publish ports 80/443; Caddy will obtain and renew the certificate.",
      tone: "info",
    });
  } else if (mode === "proxy") {
    notes.push({
      text: "OpenTeam will listen on loopback only. Point your HTTPS proxy at the local API port shown in the summary.",
      tone: "info",
    });
  } else if (mode === "private") {
    notes.push({
      text: "Private mode has no TLS. Keep it behind a trusted LAN or VPN.",
      tone: "warning",
    });
  }
  if (mode === "https" || mode === "proxy" || mode === "http") {
    notes.push({
      text: "Raw screen-viewer ports will remain loopback-only in this Internet-facing mode.",
      tone: "success",
    });
  }
  return notes;
};
