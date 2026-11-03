import { expect, test } from "bun:test";
import { connectorArguments, normalizeMcpArgumentsToInputSchema } from "../src/mcp-argument-normalization";

const schema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    format: { type: "string", enum: ["full", "metadata"] },
    query: { type: "string" },
    options: { type: "object", properties: { maxResults: { type: "integer" } } },
  },
  required: ["query"],
};

test("arguments are repaired against the advertised schema as in the reference", () => {
  // Loose key spelling, enum case and a scalar where the schema wants an array.
  expect(normalizeMcpArgumentsToInputSchema({ user_id: "me", labels: "INBOX", format: "FULL", query: "x" }, schema).arguments)
    .toEqual({ userId: "me", labels: ["INBOX"], format: "full", query: "x" });
  // Singular/plural key, a stringified object, and a lone undeclared key moved to the lone missing required key.
  expect(normalizeMcpArgumentsToInputSchema({ label: "INBOX", options: '{"maxResults":5}', q: "from:ann" }, schema).arguments)
    .toEqual({ labels: ["INBOX"], options: { maxResults: 5 }, query: "from:ann" });
  // A mistaken envelope is unwrapped.
  expect(normalizeMcpArgumentsToInputSchema({ arguments: { query: "x", format: "Metadata" } }, schema).arguments).toEqual({ query: "x", format: "metadata" });
  // Ambiguous or ill-fitting keys are left for the server to judge.
  expect(normalizeMcpArgumentsToInputSchema({ query: "x", extra: 1 }, schema).arguments).toEqual({ query: "x", extra: 1 });
});

test("only missing required arguments with nothing else to place are refused locally", () => {
  expect(() => connectorArguments("search_threads", { format: "full" }, schema)).toThrow(
    `Tool execution error. The call to search_threads was not sent: it is missing the required argument query. Input schema:\n${JSON.stringify(schema)}\nRebuild the arguments from this schema before retrying.`
  );
  // An undeclared key could be what the server wants, so the call goes through.
  expect(connectorArguments("search_threads", { needle: 1, other: 2 }, schema)).toEqual({ needle: 1, other: 2 });
});
