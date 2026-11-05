import type { ModelProvider } from "./model-settings";

export type ProviderOption = {
  id: string;
  provider: ModelProvider;
  authType?: "oauth" | "api_key";
  group: "Subscriptions" | "APIs" | "Custom endpoints" | "Other connections";
  label: string;
  connected: boolean;
  badge: string;
  detail: string;
};
export const PROVIDER_GROUPS = [
  "Subscriptions",
  "APIs",
  "Custom endpoints",
  "Other connections",
] as const;

/** The plan people pay for ("ChatGPT", "Claude") instead of the runtime's name, as in the apps. */
const PLAN_NAMES: Record<string, string> = { "openai-codex": "ChatGPT", "claude-code": "Claude" };
export const providerDisplayName = (provider: { id: string; name: string }): string =>
  PLAN_NAMES[provider.id] ?? provider.name;

/** Keep access method separate from connection state. */
export const modelProviderOptions = (providers: ModelProvider[]): ProviderOption[] =>
  providers.flatMap((provider) => {
    const methods = provider.authMethods.length ? provider.authMethods : [undefined];
    return methods.map((method): ProviderOption => {
      const connected =
        provider.connected &&
        (!method ||
          provider.authType === method.type ||
          (!provider.authType && methods.length === 1));
      const subscription = Boolean(method?.subscription);
      const group = provider.custom
        ? "Custom endpoints"
        : subscription
          ? "Subscriptions"
          : method?.type === "oauth"
            ? "Other connections"
            : "APIs";
      const label =
        provider.id === "openai"
          ? "OpenAI"
          : provider.id === "anthropic"
            ? subscription
              ? "Claude"
              : "Anthropic"
            : providerDisplayName(provider);
      return {
        id: `provider:${provider.id}${methods.length > 1 ? `:${method!.type}` : ""}`,
        provider,
        authType: method?.type,
        group,
        label,
        connected,
        badge: connected
          ? "Connected"
          : subscription
            ? "Connect subscription"
            : method?.type === "api_key"
              ? "Add API key"
              : "Connect",
        detail: subscription
          ? provider.id === "claude-code"
            ? "Claude sign-in"
            : provider.id === "openai-codex"
              ? "ChatGPT sign-in"
              : method!.label
          : method?.type === "api_key"
            ? "API key access"
            : "Provider connection",
      };
    });
  });

export const modelProviderAccess = (provider: ModelProvider): string => {
  const options = modelProviderOptions([provider]);
  const active = options.find((option) => option.connected);
  const accessLabel = (option: ProviderOption) =>
    `${option.label} · ${option.group === "Subscriptions" ? "Subscription" : option.group === "APIs" ? "API" : option.group === "Custom endpoints" ? "Custom" : "Account"}`;
  if (active) return accessLabel(active);
  if (options.length > 1) return `${providerDisplayName(provider)} · Subscription or API`;
  const option = options[0];
  return option ? accessLabel(option) : providerDisplayName(provider);
};
