import type { AuthSession, ProviderConnectionAPI } from "../../src/provider-connection-api";
import { ProviderConnectionSession } from "../../src/provider-connection-session";

export const authView = (overrides: Partial<AuthSession> = {}): AuthSession => ({
  id: "session-1",
  providerId: "anthropic",
  authType: "oauth",
  status: "waiting",
  prompt: {
    id: "prompt-1",
    type: "manual_code",
    message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
  },
  authorizationUrl:
    "https://claude.ai/oauth/authorize?state=synthetic-state-that-should-stay-hidden",
  deviceCode: null,
  messages: [],
  error: null,
  ...overrides,
});
export const connectionFixture = (authType: "oauth" | "api_key" = "oauth", pollMs = 1000) => {
  const calls = {
    start: 0,
    read: 0,
    cancel: [] as string[],
    responses: [] as string[],
    imports: [] as string[],
    links: [] as string[],
  };
  let current = authView(
    authType === "api_key"
      ? {
          authType,
          providerId: "openai",
          authorizationUrl: null,
          prompt: { id: "key-1", type: "secret", message: "API key" },
        }
      : {}
  );
  const api: ProviderConnectionAPI = {
    start: async () => {
      calls.start++;
      return structuredClone(current);
    },
    read: async () => {
      calls.read++;
      return structuredClone(current);
    },
    respond: async (_id, _prompt, value) => {
      calls.responses.push(value);
      current = { ...current, status: "connected", prompt: null };
      return structuredClone(current);
    },
    cancel: async (id) => {
      calls.cancel.push(id);
      current.status = "cancelled";
    },
    importLogin: async (provider) => {
      calls.imports.push(provider);
    },
  };
  const session = new ProviderConnectionSession(
    authType === "oauth" ? "anthropic" : "openai",
    authType,
    api,
    {
      open: async (url) => {
        calls.links.push(url);
      },
      copy: async (url) => {
        calls.links.push(url);
      },
    },
    pollMs
  );
  return {
    session,
    api,
    calls,
    set: (value: Partial<AuthSession>) => {
      current = { ...current, ...value };
    },
  };
};
export const settle = async (predicate: () => boolean) => {
  const until = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Connection did not reach expected state");
    await Bun.sleep(2);
  }
};
export const connectionScreen = (session: ProviderConnectionSession, width = 90) => {
  const frame = session.frame(width, false);
  return [...frame.header, ...frame.body, ...frame.footer].join("\n");
};
export const choose = (session: ProviderConnectionSession, id: string) => {
  session.handle("", { name: "home" });
  const index = session.actions().findIndex((action) => action.id === id);
  if (index < 0) throw new Error("Missing connection action: " + id);
  for (let i = 0; i < index; i++) session.handle("", { name: "down" });
  return session.handle("", { name: "return" });
};
