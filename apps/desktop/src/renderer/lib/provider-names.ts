// The plans people pay for, instead of the runtime's names for them ("Codex", "Claude Code").
const PLAN_NAMES: Record<string, string> = {
  "openai-codex": "ChatGPT",
  "claude-code": "Claude",
};

export const providerName = (id: string, fallback?: string | null) =>
  PLAN_NAMES[id] ?? fallback ?? id;
