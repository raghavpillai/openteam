import { createOpenTeamAuthClient, normalizeBaseUrl } from "@openteam/client-core";

const authClient = (serverUrl: unknown) => {
  if (typeof serverUrl !== "string" || serverUrl.length > 8_192) {
    throw new Error("OpenTeam server URL is invalid");
  }
  return createOpenTeamAuthClient({
    baseUrl: normalizeBaseUrl(serverUrl),
    // Node fetch has no renderer Origin or cookie jar. Never forward login
    // credentials or a bearer token through an HTTP redirect.
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
  });
};

export const desktopSignIn = (serverUrl: unknown, username: unknown, password: unknown) => {
  if (typeof username !== "string" || !username.trim() || username.length > 256) {
    throw new Error("Username is invalid");
  }
  if (typeof password !== "string" || !password || password.length > 128) {
    throw new Error("Password is invalid");
  }
  return authClient(serverUrl).signIn(username, password);
};

export const desktopSignOut = (serverUrl: unknown, token: unknown) => {
  if (typeof token !== "string" || !token.trim() || token.length > 16 * 1024) {
    throw new Error("Authentication token is invalid");
  }
  return authClient(serverUrl).signOut(token);
};
