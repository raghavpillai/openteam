import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityApprovals,
  CapabilityApprovalRequired,
} from "../../src/main/host/capability-approval";
import { HostCapabilities } from "../../src/main/host/capabilities";
import { CapabilitySettingsStore } from "../../src/main/host/capability-settings";
import { NativeActionReceipts } from "../../src/main/host/action-receipts";

test("native consent is bound to action, bot, call, permission epoch and expiry", async () => {
  let now = 10;
  const approvals = new CapabilityApprovals(
    async () => {
      throw new Error("Native dialog must not be used");
    },
    () => now
  );
  const request = {
    chatApproval: true,
    botId: "bot",
    callId: "call",
    tool: "UseSavedCredential",
    arguments: { site: "https://example.test" },
  };
  const prompt = { title: "Use saved login?", detail: "Fixture login on example.test" };
  const attempt = (input = request, epoch = 0) =>
    approvals.run(input, epoch, () => approvals.consent(prompt));
  const error = (await attempt().catch((error) => error)) as CapabilityApprovalRequired;
  expect(error.approval.gate).toBe("capability");
  const accepted = {
    ...request,
    capabilityApprovals: [{ token: error.approval.token, decision: "allow-once" }],
  };
  expect(await attempt(accepted)).toBe("once");
  await expect(attempt({ ...accepted, botId: "other" })).rejects.toBeInstanceOf(
    CapabilityApprovalRequired
  );
  await expect(
    attempt({ ...accepted, arguments: { site: "https://other.test" } })
  ).rejects.toBeInstanceOf(CapabilityApprovalRequired);
  await expect(attempt(accepted, 1)).rejects.toBeInstanceOf(CapabilityApprovalRequired);
  now += 16 * 60_000;
  await expect(attempt(accepted)).rejects.toBeInstanceOf(CapabilityApprovalRequired);
});

test("pending Messages approval does not consume send receipt; accepted retry sends once", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-review-"));
  let sends = 0;
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    const capabilities = new HostCapabilities(
      settings,
      async () => {
        throw new Error("No dialog");
      },
      {
        execute: async () => {
          sends++;
          return { sent: true };
        },
      } as any,
      undefined,
      undefined,
      "darwin",
      new NativeActionReceipts(join(root, "receipts.json"))
    );
    const request = {
      chatApproval: true,
      botId: "fixture",
      callId: "send-once",
      tool: "SendIMessage",
      arguments: { to: "fixture@example.test", text: "Synthetic fixture", service: "iMessage" },
    };
    const error = (await capabilities
      .handle(request)
      .catch((error) => error)) as CapabilityApprovalRequired;
    expect(error).toBeInstanceOf(CapabilityApprovalRequired);
    expect(sends).toBe(0);
    const accepted = {
      ...request,
      capabilityApprovals: [{ token: error.approval.token, decision: "allow-once" }],
    };
    expect(await capabilities.handle(accepted)).toEqual({ sent: true });
    expect(await capabilities.handle(accepted)).toEqual({ sent: true });
    expect(sends).toBe(1);
    await settings.update({ revoke: "messages" });
    await expect(capabilities.handle({ ...accepted, callId: "second" })).rejects.toBeInstanceOf(
      CapabilityApprovalRequired
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cookie selection is restricted to the reviewed sites and replay keeps that scope", async () => {
  const approvals = new CapabilityApprovals(async () => "deny");
  const request = { chatApproval: true, botId: "bot", callId: "cookies", tool: "request_cookie_origin_approval", arguments: {} };
  let selected: readonly string[] | undefined;
  const prompt = { title: "Import Chrome logins?", detail: "Synthetic sites", allowAlways: true,
    presentation: { kind: "cookie-import" as const, items: [
      { origin: ".alpha.test", profileId: "Default", profileDisplayName: "Personal" },
      { origin: ".beta.test", profileId: "Default", profileDisplayName: "Personal" },
    ] }, selectItems: (items: readonly string[]) => { selected = items; } };
  const pending = await approvals.run(request, 0, () => approvals.consent(prompt)).catch(error => error) as CapabilityApprovalRequired;
  const retry = (items: string[]) => approvals.run({ ...request, capabilityApprovals: [{ token: pending.approval.token, decision: "always", selectedItems: items }] }, 0, () => approvals.consent(prompt));
  const key = JSON.stringify(["Default", ".alpha.test"]);
  expect(await retry([key])).toBe("always"); expect(selected).toEqual([key]);
  await expect(retry([JSON.stringify(["Default", ".unreviewed.test"])] )).rejects.toThrow("do not match");
  await expect(retry([])).rejects.toThrow("do not match");
  expect(await retry([key])).toBe("always"); expect(selected).toEqual([key]);
});
