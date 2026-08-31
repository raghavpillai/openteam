import * as SecureStore from "expo-secure-store";
import { normalizeServerConnection, type ServerConnectionConfig } from "./server-config-core";

export { normalizeServerConnection, type ServerConnectionConfig } from "./server-config-core";

const SERVER_URL_KEY = "openbot.server-url.v1";
const ACCESS_TOKEN_KEY = "openbot.api-access-token.v1";

const bundledServerUrl = process.env.EXPO_PUBLIC_OPENBOT_API_URL?.trim() ?? "";

export const loadServerConnection = async (): Promise<ServerConnectionConfig> => ({
  serverUrl: (await SecureStore.getItemAsync(SERVER_URL_KEY))?.trim() || bundledServerUrl,
  accessToken: (await SecureStore.getItemAsync(ACCESS_TOKEN_KEY))?.trim() || "",
});

export const saveServerConnection = async (
  input: ServerConnectionConfig
): Promise<ServerConnectionConfig> => {
  const config = normalizeServerConnection(input);
  if (config.serverUrl) await SecureStore.setItemAsync(SERVER_URL_KEY, config.serverUrl);
  else await SecureStore.deleteItemAsync(SERVER_URL_KEY);
  if (config.accessToken) {
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, config.accessToken, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  }
  return config;
};
