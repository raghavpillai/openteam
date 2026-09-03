export interface ServerConnectionConfig {
  serverUrl: string;
}

export const normalizeServerConnection = (
  input: ServerConnectionConfig
): ServerConnectionConfig => {
  const rawUrl = input.serverUrl.trim();
  if (!rawUrl) return { serverUrl: "" };
  return { serverUrl: normalizeBaseUrl(rawUrl) };
};
import { normalizeBaseUrl } from "@openteam/client-core/http";
