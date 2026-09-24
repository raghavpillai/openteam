// Opt-in acceptance checks against connected accounts, never part of bun test.
// Run with the server's environment; see docs/reference/development.md.
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

const flags = new Set(process.argv.slice(2));
if (!flags.has("--live") || [...flags].some((flag) => !["--live", "--native"].includes(flag))) {
  console.error("Usage: bun apps/server/test/plugin/live-read.ts --live [--native]");
  console.error(
    "Reads the default connected accounts. --native also authenticates 1Password and lists environments."
  );
  process.exit(2);
}
for (const key of ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN"]) {
  if (!process.env[key]) {
    console.error(`Missing server environment variable: ${key}`);
    process.exit(2);
  }
}

const prisma = createPrismaClient(process.env.DATABASE_URL!);
const service = new PluginService(prisma, (path, init) => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${process.env.OPENTEAM_CONTROL_TOKEN}`);
  headers.set("content-type", "application/json");
  return fetch(`${process.env.OPENTEAM_COMPUTER_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(45_000),
  });
});
let passed = 0;
let failed = 0;

function accountId(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return accountId(JSON.parse(value));
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["accountId", "account_id"]) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const child of Object.values(record)) {
    const id = accountId(child);
    if (id) return id;
  }
}

async function check(
  plugin: string,
  tool: string,
  args: Record<string, unknown>,
  nativeAuth = false
) {
  let status = "invocation_failed";
  try {
    const connection = await prisma.pluginConnection.findFirst({
      where: { alias: "default", installation: { pluginKey: plugin, status: "installed" } },
      select: { id: true, status: true },
    });
    if (!connection || connection.status !== "ready") {
      status = "not_connected";
    } else {
      const response = await Effect.runPromise(
        service.testTool(connection.id, {
          toolName: tool,
          arguments: args,
          ...(nativeAuth ? { confirmSideEffect: true } : {}),
        })
      );
      const result = response.result as { isError?: boolean } | null;
      if (!result || typeof result !== "object") {
        status = "missing_result";
      } else if (result.isError) {
        status = "provider_error";
      } else if (nativeAuth && !accountId(result)) {
        status = "missing_account_id";
      } else {
        passed++;
        console.log(JSON.stringify({ plugin, tool, status: "pass" }));
        return response.result;
      }
    }
  } catch {
    // Provider errors may contain credentials or account data. Never log them.
  }
  failed++;
  console.log(JSON.stringify({ plugin, tool, status }));
}

try {
  const start = new Date();
  const end = new Date(start.getTime() + 86_400_000);
  const checks: Array<[string, string, Record<string, unknown>]> = [
    ["slack", "slack_read_user_profile", { response_format: "concise" }],
    [
      "slack",
      "slack_list_user_channels",
      { types: "public_channel", limit: 1, format: "names_only" },
    ],
    ["slack", "slack_search_channels", { query: "general", limit: 1, response_format: "concise" }],
    ["github", "get_me", {}],
    ["github", "search_repositories", { query: "openteam in:name", perPage: 1 }],
    ["gmail", "get_profile", {}],
    ["gmail", "list_labels", {}],
    ["gmail", "search_messages", { query: "in:inbox", maxResults: 1 }],
    ["google-calendar", "list_calendars", { maxResults: 1 }],
    [
      "google-calendar",
      "list_events",
      {
        calendarId: "primary",
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        maxResults: 1,
      },
    ],
    ["google-drive", "list_recent_files", { pageSize: 1, excludeContentSnippets: true }],
    ["granola", "get_account_info", {}],
    ["granola", "list_meetings", { time_range: "this_week" }],
    ["linear", "get_workspace", {}],
    ["linear", "list_teams", { limit: 1 }],
    ["notion", "notion-get-users", { user_id: "self", page_size: 1 }],
    ["notion", "notion-search", { query: "OpenTeam", page_size: 1, max_highlight_length: 0 }],
  ];
  for (const [plugin, tool, args] of checks) await check(plugin, tool, args);
  if (flags.has("--native")) {
    const result = await check("1password", "authenticate", {}, true);
    const id = accountId(result);
    if (id) await check("1password", "list_environments", { accountId: id });
  }
  console.log(JSON.stringify({ passed, failed, native: flags.has("--native") }));
  process.exitCode = failed ? 1 : 0;
} finally {
  await service.close();
  await prisma.$disconnect();
}
