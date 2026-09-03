import * as SecureStore from "expo-secure-store";
import { normalizeServerConnection, type ServerConnectionConfig } from "./server-config-core";

export { normalizeServerConnection, type ServerConnectionConfig } from "./server-config-core";

const SERVER_URL_KEY = "openteam.server-url.v1";
const LEGACY_ACCESS_TOKEN_KEY = "openteam.api-access-token.v1";

const bundledServerUrl = process.env.EXPO_PUBLIC_OPENTEAM_API_URL?.trim() ?? "";

const discardLegacyAccessToken = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(LEGACY_ACCESS_TOKEN_KEY).catch(() => undefined);
};

export const loadServerConnection = async (): Promise<ServerConnectionConfig> => {
  const serverUrl = (await SecureStore.getItemAsync(SERVER_URL_KEY))?.trim() || bundledServerUrl;
  await discardLegacyAccessToken();
  return { serverUrl };
};

export const saveServerConnection = async (
  input: ServerConnectionConfig
): Promise<ServerConnectionConfig> => {
  const config = normalizeServerConnection(input);
  if (config.serverUrl) await SecureStore.setItemAsync(SERVER_URL_KEY, config.serverUrl);
  else await SecureStore.deleteItemAsync(SERVER_URL_KEY);
  await discardLegacyAccessToken();
  return config;
};
