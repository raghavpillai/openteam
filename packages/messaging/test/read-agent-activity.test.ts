import { expect, test } from "bun:test";
import { renderAgentActivity } from "../src/read-agent-activity";

const now = new Date("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("renders each bot's activity in the host's format", () => {
  const bounds = { sinceHours: 72, maxAgents: 10, excerptChars: 1500 };
  expect(renderAgentActivity({ kind: "unavailable" }, bounds, now)).toBe("This user owns no other bots to read.");
  expect(renderAgentActivity({ kind: "read", agents: [], truncated: false }, bounds, now)).toBe(
    "No activity on the user's other bots (last 72h, up to 10 bots, 1500 excerpt chars each)."
  );
  expect(renderAgentActivity({ kind: "read", truncated: true, agents: [{
    agentId: "a1", name: "Hiring", description: "Runs hiring.",
    lastUserMessageAt: ago(2 * 3_600_000 + 5 * 60_000), lastAssistantMessageAt: ago(30_000),
    openTodos: [{ status: "pending", content: "Post the CSM role" }],
    pendingQuestions: [{ askedAt: ago(26 * 3_600_000), text: "Which level should the role be?" }],
    recentExcerpt: "User: hi\nHiring: Which level should the role be?",
  }] }, bounds, now)).toBe([
    "Other bots' recent activity, 1 bot (last 72h, up to 10 bots, 1500 excerpt chars each). Truncated: more qualifying activity than shown.",
    "",
    "## Hiring (agent a1)",
    "Runs hiring.",
    "Last user message: 2h 5m ago. Last assistant message: just now.",
    "Open todos (1):",
    "- [pending] Post the CSM role",
    "Pending questions (1):",
    "- 1d 2h ago: Which level should the role be?",
    "Recent excerpt:",
    "User: hi\nHiring: Which level should the role be?",
  ].join("\n"));
});
