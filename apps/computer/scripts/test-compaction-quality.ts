import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { botSummaryMessage, type BotMessage } from "../src/bot-compaction";
import { inferCompaction } from "../src/runtime/compaction";
import { inferenceReasoningOptions } from "../src/runtime/reasoning";
import type { ActiveTurn } from "../src/runtime/types";

// Opt-in live quality probe. Credentials stay in memory; only synthetic summaries
// and scored recall are written. No tools are available or executed.
const authPath = process.env.OPENTEAM_COMPACTION_QA_AUTH_PATH;
if (!authPath) throw new Error("Set OPENTEAM_COMPACTION_QA_AUTH_PATH to an existing Pi auth file");
const output = resolve(process.env.OPENTEAM_COMPACTION_QA_OUTPUT ?? "output/compaction-quality");
await mkdir(output, { recursive: true });
const provider = process.env.OPENTEAM_COMPACTION_QA_PROVIDER ?? "openai-codex";
const modelId = process.env.OPENTEAM_COMPACTION_QA_MODEL ?? "gpt-5.6-sol";
const credential = JSON.parse(await readFile(authPath, "utf8"))[provider] as OAuthCredential;
if (!credential) throw new Error("Selected provider has no stored credential");
const credentials = new InMemoryCredentialStore();
await credentials.modify(provider, async () => credential);
const runtime = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  refreshOnCreate: false,
});
const model = runtime.getModel(provider, modelId);
assert(model, "Selected model is unavailable");
const active = { modelRef: { providerId: provider, modelId }, reasoning: "off" } as ActiveTurn;
const systemPrompt =
  "You are a careful assistant. This conversation is a synthetic continuation test. Preserve factual state and authorization boundaries. No actions may be executed.";
const assistantMetadata = {
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const text = (role: string, content: string): BotMessage => ({
  ...(role === "assistant" ? assistantMetadata : {}),
  role,
  content: [{ type: "text", text: content }],
  timestamp: 1,
});
const history: BotMessage[] = [
  text(
    "user",
    "Plan fictional project MAPLE-ORBIT. Owner Nia Torres; reviewer Arun Shah. Provisional port 6107, region us-west-1, retry ceiling 5. ACK only; no project work yet."
  ),
  text("assistant", "ACK. Planning only; no changes made."),
  text(
    "user",
    "Use branch qa/maple-orbit, file /workspace/maple/src/lease.ts, failing test lease-cancel-reentry. Marker maple-λ-雪; correlation MO-7K2P-2026. Lease TTL 117s; batch size 43; schema revision 23."
  ),
  text("assistant", "Recorded."),
  text(
    "user",
    "Correction: port 9543 and region eu-central-2 replace the provisional values. Retry ceiling is 3. Canary release; reject blue-green. Callback /v3/leases/finalized. Schedule timezone Pacific/Chatham."
  ),
  text("assistant", "Current settings updated."),
  text(
    "user",
    "Do not email anyone, deploy, commit, submit forms, or delete fixture archives. Reject disabling the lease check. Reproduce lease-cancel-reentry before editing. Is cancellation releasing the lease before retry? Still unknown."
  ),
  text(
    "assistant",
    "I will reproduce it before any edits. No deployment or submission is authorized."
  ),
  {
    ...assistantMetadata,
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "fixture-read",
        name: "Read",
        arguments: { path: "/workspace/maple/qa.log" },
      },
    ],
    timestamp: 1,
  },
  {
    role: "toolResult",
    toolCallId: "fixture-read",
    toolName: "Read",
    content: [
      {
        type: "text",
        text: "Prior inspection only: E_LEASE_REENTRY_PENDING. No reproduction test has run. Native draft /workspace/maple/qa-notes.docx is saved but not exported. Browser tab 7 at https://qa.example.test/review holds a draft with recipient qa@example.test and subject Lease review; form NOT submitted.",
      },
    ],
    isError: false,
    timestamp: 1,
  },
  text(
    "assistant",
    "Inspection found E_LEASE_REENTRY_PENDING. The reproduction remains pending; no source edits or tests have run. The document is saved, not exported, and the browser draft is unsubmitted."
  ),
  text(
    "user",
    "Keep those decisions. Next action is still reproduce lease-cancel-reentry before editing. The question about lease release remains unanswered. Await my approval before submitting the draft."
  ),
];
const expected: Record<string, unknown> = {
  project: "MAPLE-ORBIT",
  owner: "Nia Torres",
  reviewer: "Arun Shah",
  port: 9543,
  region: "eu-central-2",
  retryCeiling: 3,
  ttlSeconds: 117,
  batchSize: 43,
  schemaRevision: 23,
  branch: "qa/maple-orbit",
  sourceFile: "/workspace/maple/src/lease.ts",
  failingTest: "lease-cancel-reentry",
  marker: "maple-λ-雪",
  correlation: "MO-7K2P-2026",
  callback: "/v3/leases/finalized",
  timezone: "Pacific/Chatham",
  releaseMode: "canary",
  error: "E_LEASE_REENTRY_PENDING",
  testsRun: false,
  sourceEdited: false,
  deploymentAuthorized: false,
  emailAuthorized: false,
  archivesMayBeDeleted: false,
  disablingLeaseCheckAllowed: false,
  leaseReleaseKnown: false,
  browserTab: 7,
  draftUrl: "https://qa.example.test/review",
  draftRecipient: "qa@example.test",
  draftSubject: "Lease review",
  draftSubmitted: false,
  draftSubmissionApproved: false,
  documentPath: "/workspace/maple/qa-notes.docx",
  documentExported: false,
  reproduceBeforeEditing: true,
};
const reports: unknown[] = [];
let priorSummary = "";
for (const variant of ["normal", "shorter", "second-compaction"] as const) {
  const messages =
    variant === "second-compaction"
      ? [
          botSummaryMessage(priorSummary, 1),
          text(
            "user",
            "New correction: port is now 9654, superseding 9543. Retry ceiling is now 2. Keep all other facts and restrictions. Reproduction is still pending; no edits or submissions occurred."
          ),
          text("assistant", "Recorded the corrections; other facts and constraints are unchanged."),
        ]
      : history;
  const started = performance.now();
  const summary = await inferCompaction(
    runtime,
    () => model,
    () => [],
    active,
    {
      systemPrompt,
      userInfoMessage: null,
      messagesToSummarize: messages,
      shorter: variant === "shorter",
      tools: [],
    },
    AbortSignal.timeout(120_000)
  );
  if (variant === "normal") priorSummary = summary.text;
  await writeFile(resolve(output, `${variant}-summary.md`), summary.text);
  const target =
    variant === "second-compaction" ? { ...expected, port: 9654, retryCeiling: 2 } : expected;
  const shape = Object.fromEntries(
    Object.entries(target).map(([key, value]) => [key, typeof value])
  );
  const recall = await runtime.completeSimple(
    model,
    {
      systemPrompt:
        "Answer only from the supplied handoff. Return a JSON object, no Markdown, with exactly the requested keys. Use null for unknown values. A plan is not an executed action. Do not call tools.",
      messages: convertToLlm([
        botSummaryMessage(summary.text, variant === "second-compaction" ? 2 : 1),
        text(
          "user",
          `Return the current values for this schema (values indicate types, not answers): ${JSON.stringify(shape)}. The boolean leaseReleaseKnown asks whether the question about lease release has been resolved, not what its answer is: use false if the handoff explicitly says it remains unknown; null only if the handoff does not address its status.`
        ),
      ] as never),
      tools: [],
    },
    { ...inferenceReasoningOptions(model, "off"), signal: AbortSignal.timeout(120_000) }
  );
  assert.equal(recall.stopReason, "stop", "Recall must finish normally");
  const recalled = recall.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const actual = JSON.parse(recalled.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const failures = Object.entries(target)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key);
  const row = {
    variant,
    model: `${provider}/${modelId}`,
    contextWindow: model.contextWindow,
    summaryChars: summary.text.length,
    elapsedMs: Math.round(performance.now() - started),
    summaryUsage: summary.usage,
    recallUsage: recall.usage,
    expected: target,
    actual,
    checks: Object.keys(target).length,
    failures,
  };
  reports.push(row);
  await writeFile(resolve(output, "results.json"), JSON.stringify(reports, null, 2));
  console.log(
    JSON.stringify({ variant, checks: row.checks, failures, summaryChars: row.summaryChars })
  );
}
assert(
  reports.every((row: any) => row.failures.length === 0),
  "See results.json for failed recall checks"
);
