import { expect, test } from "bun:test";
import type { RoutineView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { attachmentLimitForName, attachmentSizeRejection } from "@openteam/contracts/media-input";
import {
  activityContentSummary,
  attachmentByteLimit,
  attachmentPreviewKind,
  firstOversizedAttachment,
  formatAttachmentBytes,
  projectRichMessage,
  routineScheduleEditMode,
  routineSchedulePatch,
} from "../src";
import { selectAttachments } from "../src/attachments";
import { pluginAuthorization } from "../src/plugin-authorization";
import { redactSensitiveText } from "../src/redaction";
import { userFormOutcome } from "../src/rich-messages";
import { formatRosterTimestamp } from "../src/timestamps";
import { view } from "./fixtures";

test("attachment size limits are exact byte boundaries and selection uses only the remaining capacity", () => {
  for (const name of ["a.png", "a.txt", "a.mp4", "a.ogv"]) {
    const maximum = attachmentLimitForName(name);
    expect([attachmentSizeRejection(name, maximum), attachmentSizeRejection(name, maximum + 1), attachmentSizeRejection(name, 0)]).toEqual([null, "too-large", "empty"]);
  }
  expect(attachmentSizeRejection("unknown-size.txt", undefined)).toBeNull();
  const limits = CLIENT_CAPABILITIES.uploads;
  const max = limits.maxAttachmentsPerMessage;
  const selection = Array.from({ length: max + 1 }, (_, i) => ({ fileName: `file-${i}.txt`, byteSize: 1 }));
  for (const staged of [0, 1, max - 1, max, max + 1]) {
    const result = selectAttachments(selection, staged, limits);
    expect(result.accepted).toEqual(selection.slice(0, Math.max(0, max - staged)));
    expect(result.notice).not.toBeNull();
  }
});

test("uses one capability-driven upload policy for video and regular files", () => {
  const video = { fileName: "demo.MOV", mimeType: "application/octet-stream", byteSize: 201 };
  const document = { fileName: "notes.md", mimeType: "text/markdown", byteSize: 101 };
  const capabilities = { ...CLIENT_CAPABILITIES.uploads, maxRegularBytes: 100, maxVideoBytes: 200 };
  expect(attachmentByteLimit(video, capabilities)).toBe(200);
  expect(firstOversizedAttachment([video, document], capabilities)).toEqual({ candidate: video, limit: 200 });
  expect(formatAttachmentBytes(1_572_864)).toBe("1.5 MB");
  expect(attachmentPreviewKind({ assetId: "asset-1", fileName: "report.csv", mimeType: "application/octet-stream", byteSize: 10, kind: "file" })).toBe("table");
});

test("rich messages fail closed for incomplete secret requests and bound cyclic activity payloads", () => {
  const secret = (secretRequest: unknown) => projectRichMessage(view({ sender: "agent", metadata: { type: "secret-request", secretRequest } }));
  expect(secret({ label: "Token" })).toBeNull();
  expect(secret({ label: "Token", connector: "github", field: "token" })).toMatchObject({ kind: "secret-request", provided: false });
  const payload: Record<string, unknown> = { output: "ok" };
  payload.self = payload;
  const summary = activityContentSummary(payload);
  expect(summary).toContain('"self": "[Circular]"');
  expect(summary?.length).toBeLessThanOrEqual(1_501);
});

test("partial and uncertain forms show actionable status without values, snapshots or unknown fields", () => {
  const form = { title: "Sign in", instruction: "Fixture", fields: [{ id: "password", label: "Password", type: "password" as const }] };
  const outcome = userFormOutcome(form, { cardState: "submitted", formReceipt: { fields: [{ id: "password", status: "held", value: "private" }, { id: "private", status: "filled" }], snapshot: "private" } });
  expect(outcome.fields).toEqual([{ id: "password", label: "Password", status: "Held for recovery" }]);
  expect(outcome.summary).toContain("recover held fields");
  expect(JSON.stringify(outcome)).not.toContain("private");
  expect(userFormOutcome(form, { cardState: "submitted", formReceipt: { interrupted: true } }).summary).toContain("interrupted");
  expect(userFormOutcome(form, { cardState: "submitted", formReceipt: { submitAttempted: true, submitSucceeded: false } }).summary).toContain("pressing Enter failed");
});

test("simple clients never flatten event or composite routine schedules", () => {
  const routine = (overrides: Partial<RoutineView> = {}) => ({ scheduleKind: "cron", schedule: "0 9 * * *", schedules: ["0 9 * * *"], ...overrides }) as RoutineView;
  const event = routine({ scheduleKind: "event", schedule: "event:github", schedules: [] });
  const composite = routine({ schedules: ["0 9 * * *", "0 17 * * *"], trigger: { type: "group", operator: "any", children: [] } } as Partial<RoutineView>);
  expect([routineScheduleEditMode(null), routineScheduleEditMode(event), routineScheduleEditMode(composite)]).toEqual(["editable", "event", "composite"]);
  expect(routineSchedulePatch(event, "0 8 * * *")).toEqual({});
  expect(routineSchedulePatch(composite, "0 8 * * *")).toEqual({});
  expect(routineSchedulePatch(routine(), " 0 8 * * * ")).toEqual({ schedule: "0 8 * * *" });
});

test("OAuth handoff distinguishes waiting, expired, settled and unsafe destinations", () => {
  const connection = { status: "needs_auth", authorizationUrl: "https://provider.example/authorize?state=fixture", authorizationExpiresAt: new Date(2000).toISOString() };
  expect(pluginAuthorization(connection, 1000)).toEqual({ url: connection.authorizationUrl, state: "fixture", expired: false });
  expect(pluginAuthorization(connection, 2000)?.expired).toBe(true);
  expect(pluginAuthorization({ ...connection, status: "ready" })).toBeNull();
  expect(pluginAuthorization({ ...connection, authorizationUrl: "javascript:alert(1)?state=fixture" })).toBeNull();
  expect(pluginAuthorization({ ...connection, authorizationUrl: "https://provider.example/no-state" })).toBeNull();
});

test("diagnostic redaction removes bearer, environment, JSON, CLI, URL, provider and quoted secrets", () => {
  const secrets = ["abc.def.ghi", "super-secret-value", "hunter2", "ghp_abcdefghijklmnopqrstuvwxyz123456", "owner:password@", "sk-proj-abcdefghijklmnopqrstuvwxyz"];
  const output = redactSensitiveText([
    "Authorization: Bearer abc.def.ghi", "OPENTEAM_AUTH_SECRET=super-secret-value", '"password":"hunter2"',
    "openteam command --token ghp_abcdefghijklmnopqrstuvwxyz123456", "https://owner:password@example.com/path", "sk-proj-abcdefghijklmnopqrstuvwxyz",
  ].join("\n"));
  for (const secret of secrets) expect(output).not.toContain(secret);
  expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  expect(redactSensitiveText(`OPENTEAM_AUTH_PASSWORD="correct horse battery staple" openteam auth-reset --password 'another secret phrase'`))
    .toBe("OPENTEAM_AUTH_PASSWORD=[REDACTED] openteam auth-reset --password [REDACTED]");
});

test("roster calendar-day labels survive a daylight-saving transition", () => {
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const now = new Date(2026, 2, 9, 12);
    const sevenDaysAgo = new Date(2026, 2, 2, 12);
    for (const variant of ["compact", "expanded"] as const) {
      expect(formatRosterTimestamp(new Date(2026, 2, 8, 12).toISOString(), variant, now)).toBe("Yesterday");
      expect(formatRosterTimestamp(new Date(2026, 2, 3, 12).toISOString(), variant, now)).toBe("Tuesday");
      expect(formatRosterTimestamp(sevenDaysAgo.toISOString(), variant, now)).toBe(sevenDaysAgo.toLocaleDateString([], { month: "numeric", day: "numeric" }));
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
