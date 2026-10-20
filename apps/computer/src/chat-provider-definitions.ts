import type { Api } from "@earendil-works/pi-ai";

/** The server owns supported built-ins; clients render the catalog it returns. */
export const CHAT_PROVIDER_DEFINITIONS: Readonly<
  Record<
    string,
    {
      name: string;
      api: Api;
      /** Suggested defaults in preference order; the first one the account lists is recommended. */
      recommendedModels?: readonly string[];
    }
  >
> = {
  "openai-codex": { name: "Codex", api: "openai-codex-responses" },
  "claude-code": { name: "Claude Code", api: "anthropic-messages" },
  openai: { name: "OpenAI", api: "openai-responses" },
  anthropic: { name: "Anthropic", api: "anthropic-messages" },
  openrouter: {
    name: "OpenRouter",
    api: "openai-completions",
    // The Auto Router picks a model per request; the rolling "latest" aliases stay current.
    recommendedModels: [
      "openrouter/auto",
      "~anthropic/claude-sonnet-latest",
      "~openai/gpt-sol-latest",
      "~google/gemini-pro-latest",
    ],
  },
};
