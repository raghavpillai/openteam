import assert from "node:assert/strict";
import { test } from "node:test";
import { createCustomerPolicy, renderDecision } from "./support-customer-policy.mjs";

const account = {
  firstName: "Casey",
  lastName: "Rao",
  password: "Hidden-Password-999",
  pin: "4782",
  card: { last4: "2290" },
  serviceAddress: { line1: "77 Fixture Way", city: "Bend", state: "OR", zip: "97703" },
  websiteUrl: "https://provider.example",
  singleActionOnly: true,
};
const d = (intent, extra = {}) => ({
  intent,
  factKeys: [],
  optionIndex: null,
  scopeIssues: [],
  ...extra,
});
const response = (decision) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "holder_decision", arguments: JSON.stringify(decision) } },
            ],
          },
        },
      ],
      usage: { total_tokens: 30 },
    }),
    { status: 200 }
  );
test("approval renderer preserves one action and all authority limits across arbitrary proposed wording", () => {
  const r = renderDecision(d("approval"), { account, singleActionOnly: true });
  assert.equal(r.kind, "permission");
  assert.match(r.text, /only the immediate/);
  assert.match(r.text, /later outgoing action still needs/);
  assert.match(r.text, /Do not accept fees/);
});
test("model cannot generate fact values or introduce unknown fields", () => {
  assert.throws(() => renderDecision(d("facts", { factKeys: ["password"] }), { account }));
  assert.throws(() =>
    renderDecision(
      { ...d("facts", { factKeys: ["zip"] }), text: "Invented ZIP 12345" },
      { account }
    )
  );
  const r = renderDecision(d("facts", { factKeys: ["zip", "cardLast4"] }), { account });
  assert.match(r.text, /97703/);
  assert.match(r.text, /2290/);
  assert.doesNotMatch(r.text, /4782|Hidden-Password/);
});
test("unavailable facts are explicit, not fabricated yes or silent null", () => {
  const r = renderDecision(d("facts", { factKeys: ["billingAddress"] }), { account });
  assert.match(r.text, /do not have billingAddress/);
  assert.doesNotMatch(r.text, /77 Fixture/);
  assert.match(
    renderDecision(d("unavailable_fact"), { account }).text,
    /do not have that information/
  );
});
test("scope issues override an otherwise approving classifier for every restricted category", () => {
  for (const issue of [
    "fee",
    "credit",
    "retention",
    "changed_terms",
    "recurring_watch",
    "unrelated",
    "protected_credentials",
    "human_takeover",
    "alternate_url",
  ])
    assert.equal(
      renderDecision(d("approval", { scopeIssues: [issue] }), { account }).kind,
      "scope"
    );
});
test("clarification selects only an existing option and does not approve sending it", () => {
  assert.throws(() =>
    renderDecision(d("clarification", { optionIndex: 1 }), { account, options: ["one"] })
  );
  const r = renderDecision(d("clarification", { optionIndex: 0 }), {
    account,
    options: ["Eligible charges only"],
  });
  assert.match(r.text, /Eligible charges only/);
  assert.match(r.text, /does not authorize a new outgoing action/);
});
test("access response provides only existing normal URL and never promises takeover", () => {
  const r = renderDecision(d("access"), { account });
  assert.match(r.text, /https:\/\/provider.example/);
  assert.match(r.text, /cannot provide another address or take over/);
});
test("injected transport receives no holder credentials and cached decisions do not duplicate inference", async () => {
  let calls = 0;
  const audit = [];
  const reply = createCustomerPolicy({
    key: "Test-Inference-Key",
    operatorKey: "Test-Operator-Key",
    request: async (_url, init) => {
      calls++;
      const b = JSON.parse(init.body);
      const input = b.messages[1].content;
      assert.doesNotMatch(input, /Hidden-Password-999|4782|Test-Inference-Key|Test-Operator-Key/);
      assert.ok(input.includes("factsAvailable"));
      assert.equal(b.model, "anthropic/claude-opus-5.5");
      return response(d("approval"));
    },
    audit: (e) => audit.push(e),
  });
  const text =
    "I have the password Hidden-Password-999 and PIN 4782. Next step is ready when you give the go-ahead.";
  const a = await reply(text, account, { messageId: "a" });
  const b = await reply(text, account, { messageId: "a" });
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].intent, "approval");
});
test("bad provider outputs reject explicitly and never become agent failure or freeform authority", async () => {
  for (const value of [
    { choices: [] },
    { choices: [{ message: { tool_calls: [{ function: { name: "other", arguments: "{}" } }] } }] },
    {},
  ]) {
    const reply = createCustomerPolicy({
      key: "private-test-key",
      request: async () => new Response(JSON.stringify(value)),
    });
    await assert.rejects(reply("Ready for approval", account), /fixture could not produce/);
  }
});
test("HTTP credential and raw error bodies never escape failure surface", async () => {
  const reply = createCustomerPolicy({
    key: "private-test-key",
    request: async () => new Response("secret private-test-key", { status: 402 }),
  });
  await assert.rejects(
    reply("Ready for approval", account),
    (e) => !e.message.includes("private-test-key") && !e.message.includes("secret")
  );
});
test("a classifier cannot echo a protected value via an option selection", async () => {
  const reply = createCustomerPolicy({
    key: "private-test-key",
    request: async () => response(d("clarification", { optionIndex: 0 })),
  });
  await assert.rejects(
    reply("Choose", account, { options: ["Send Hidden-Password-999"] }),
    /fixture could not produce/
  );
});
test("an unanswered widget cannot silently disappear as informational null", async () => {
  const reply = createCustomerPolicy({
    key: "private-test-key",
    request: async () => response(d("none")),
  });
  await assert.rejects(reply("Choose", account, { options: ["One"] }), /fixture could not produce/);
});

test("concurrent observation of the same request shares one inference decision", async () => {
  let calls = 0;
  const reply = createCustomerPolicy({
    key: "private-test-key",
    request: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(d("approval"));
    },
  });
  const results = await Promise.all([
    reply("Ready when you authorize it", account, { messageId: "same" }),
    reply("Ready when you authorize it", account, { messageId: "same" }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
});

test("excessive classifier decisions fail explicitly before another inference call", async () => {
  let calls = 0;
  const reply = createCustomerPolicy({
    key: "private-test-key",
    request: async () => {
      calls++;
      return response(d("none"));
    },
  });
  for (let i = 0; i < 64; i++)
    assert.equal(await reply("Informational progress", account, { messageId: String(i) }), null);
  await assert.rejects(
    reply("Another informational progress", account, { messageId: "overflow" }),
    /decision limit/
  );
  assert.equal(calls, 64);
});
