export interface ServerConnectionConfig {
  serverUrl: string;
  accessToken: string;
}

export const normalizeServerConnection = (
  input: ServerConnectionConfig
): ServerConnectionConfig => {
  const rawUrl = input.serverUrl.trim();
  if (!rawUrl) return { serverUrl: "", accessToken: "" };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid OpenBot server URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("The OpenBot server URL must use HTTP or HTTPS.");
  }
  return {
    serverUrl: rawUrl.replace(/\/+$/, ""),
    accessToken: input.accessToken.trim(),
  };
};
