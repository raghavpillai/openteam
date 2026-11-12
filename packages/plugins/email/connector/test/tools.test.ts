import { describe, expect, test } from "bun:test";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { tools } from "../server";

const ours = Object.fromEntries(tools("account-1").map((tool) => [tool.name, tool]));
const valid = (name: string, args: Record<string, unknown>) =>
  createToolValidator(ours[name]!.inputSchema)(args).valid;

describe("Email tool contracts", () => {
  test("Bots get four read-only tools with bounded inputs", () => {
    const bot = tools("account-1").filter((tool) => !tool._meta?.["openteam/hostOnly"]);
    expect(bot.map((tool) => tool.name)).toEqual([
      "ListEmailInboxes",
      "SearchEmailThreads",
      "ReadEmailThread",
      "ReadEmailAttachment",
    ]);
    for (const name of ["ListEmailInboxes", "SearchEmailThreads", "ReadEmailThread", "ReadEmailAttachment"])
      expect(ours[name]!.annotations.readOnlyHint).toBe(true);
    expect(ours.SearchEmailThreads!.inputSchema.required).toEqual(["query"]);
    expect(ours.SearchEmailThreads!.inputSchema.properties.mode.enum).toEqual(["hybrid", "keyword", "semantic"]);
    expect(ours.ReadEmailThread!.inputSchema.required).toEqual(["thread_id"]);
    expect(ours.ReadEmailAttachment!.inputSchema.required).toEqual(["attachment_id"]);
    expect(ours.ListEmailInboxes!.description).toContain("(providerIdentifier account-1)");
  });

  test("outbound mail goes only through review cards", () => {
    for (const name of ["send_reviewed_email", "poll_new_mail"])
      expect(ours[name]!._meta).toEqual({ "openteam/hostOnly": true });
  });
});
