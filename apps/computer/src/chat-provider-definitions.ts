import type { Api } from "@earendil-works/pi-ai";

/** The server owns supported built-ins; clients render the catalog it returns. */
export const CHAT_PROVIDER_DEFINITIONS: Readonly<Record<string, { name: string; api: Api }>> = {
  "openai-codex": { name: "Codex", api: "openai-codex-responses" },
  "claude-code": { name: "Claude Code", api: "anthropic-messages" },
  openai: { name: "OpenAI", api: "openai-responses" },
  anthropic: { name: "Anthropic", api: "anthropic-messages" },
  openrouter: { name: "OpenRouter", api: "openai-completions" },
};
