// Opt-in acceptance check, run inside the OpenTeam server with its existing environment.
// Supply { configuration: <resolved packaged MCP config> } on stdin; credentials stay in memory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.argv.length !== 3 || process.argv[2] !== "--live") {
  console.error("Usage: bun live-read.mjs --live < configuration-input");
  process.exit(2);
}
for (const key of ["OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN"]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const { configuration, channelId } = JSON.parse(await Bun.stdin.text());
if (channelId !== undefined) assert.match(channelId, /^[CG][A-Z0-9]{8,}$/);
assert.equal(configuration.env?.SLACK_MCP_XOXP_TOKEN, undefined, "Live test must use browser-session auth");
assert.ok(configuration.env?.SLACK_MCP_XOXC_TOKEN?.startsWith("xoxc-"));
assert.ok(configuration.env?.SLACK_MCP_XOXD_TOKEN?.startsWith("xoxd-"));
const id = `slack-stealth-test-${randomUUID()}`;
const endpoint = `${process.env.OPENTEAM_COMPUTER_URL}/v1/mcp/connections/${id}`;
const headers = {
  authorization: `Bearer ${process.env.OPENTEAM_CONTROL_TOKEN}`,
  "content-type": "application/json",
};
const checks = [];
let current = "startup";
const request = async (path, body, method = "POST") => {
  const response = await fetch(endpoint + path, {
    method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(330_000),
  });
  // Provider errors may contain account data or credentials. Never echo response bodies.
  if (!response.ok) throw new Error(`computer_http_${response.status}`);
  return response.json();
};
try {
  const { tools } = await request("/discover", { configuration });
  assert.equal(tools.length, 9);
  checks.push({ tool: "discovery", status: "pass", tools: tools.length });
  const call = async (name, args) => {
    current = name;
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
    const { result } = await request("/call", { configuration, toolName: name, arguments: args });
    const text = (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (result?.isError) {
      const code = text.match(/\b(invalid_auth|token_revoked|account_inactive|enterprise_is_restricted|missing_scope|not_in_channel|channel_not_found|ratelimited)\b/)?.[0];
      checks.push({ tool: name, status: "fail", code: code ?? "provider_error" });
      return null;
    }
    assert.ok(text.length, "Provider response must contain data");
    checks.push({ tool: name, status: "pass", responseBytes: Buffer.byteLength(text) });
    return text;
  };
  await call("channels_list", { channel_types: "public_channel", limit: 3 });
  const mine = await call("channels_me", { channel_types: "public_channel", limit: 3 });
  const channel = mine?.match(/\b[CG][A-Z0-9]{8,}\b/)?.[0] ?? channelId;
  assert.ok(channel, "Need a public channel membership to test history");
  const history = await call("conversations_history", { channel_id: channel, limit: "3" });
  await call("conversations_search_messages", { filter_in_channel: channel, limit: 3 });
  const timestamp = history?.match(/\b\d{10}\.\d{6}\b/)?.[0];
  if (timestamp) await call("conversations_replies", { channel_id: channel, thread_ts: timestamp, limit: "3" });
  else checks.push({ tool: "conversations_replies", status: "skipped", code: "no_message_timestamp" });
  const passed = checks.every((check) => check.status === "pass");
  console.log(JSON.stringify({ checks, readOnly: true, credentialsPersisted: false, status: passed ? "pass" : "fail" }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const code = error instanceof Error && /^computer_http_\d+$|^provider_error$/.test(error.message)
    ? error.message : "check_failed";
  console.log(JSON.stringify({ checks, failedCheck: current, status: "fail", code, readOnly: true }));
  process.exitCode = 1;
} finally {
  await request("", undefined, "DELETE").catch(() => {});
}
