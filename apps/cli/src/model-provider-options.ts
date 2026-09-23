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

/** Keep access method separate from connection state, including on older server catalogs. */
export const modelProviderOptions = (providers: ModelProvider[]): ProviderOption[] =>
  providers.flatMap((provider) => {
    const methods = provider.authMethods?.length
      ? provider.authMethods
      : provider.id === "openai" || provider.id === "anthropic" || provider.id === "openrouter"
        ? [{ type: "api_key" as const, label: "API key", subscription: false }]
        : provider.id === "openai-codex" || provider.id === "claude-code"
          ? [{ type: "oauth" as const, label: "ChatGPT", subscription: true }]
          : [undefined];
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
        provider.id === "openai-codex"
          ? "Codex"
          : provider.id === "openai"
            ? "OpenAI"
            : provider.id === "anthropic"
              ? subscription
                ? "Claude Code"
                : "Anthropic"
              : provider.name;
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
            ? "Claude Code sign-in"
            : provider.id === "openai-codex"
              ? "Codex sign-in"
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
  if (options.length > 1) return `${provider.name} · Subscription or API`;
  const option = options[0];
  return option ? accessLabel(option) : provider.name;
};
