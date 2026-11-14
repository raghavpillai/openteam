import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelMessageView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { api } from "../../src/renderer/client/openteam-api";
import { useOpenTeam } from "../../src/renderer/state/use-openteam";
import { mobileFixture } from "../../../ios/scripts/fixtures/snapshot";

// Real renderer state hook, with deliberately stale server responses and no network.
Object.defineProperty(document, "hidden", { configurable: true, value: true });
window.fetch = async () => {
  throw new Error("Network disabled in question history fixture");
};
window.addEventListener("error", (event) =>
  console.log("QUESTION_HISTORY_RESULT " + JSON.stringify({ error: event.message }))
);
const answered = new URLSearchParams(location.search).has("answered");
const channel = mobileFixture.channels[0]!;
const bot = mobileFixture.bots[0]!;
const receipt = answered
  ? { respondedValue: "Blue", widgetResponseClientId: "answer" }
  : { widgetDismissed: true, widgetDismissClientId: "dismiss", widgetDismissalReason: "dismissed" };
const question: ChannelMessageView = {
  id: "question",
  sequence: "1",
  channelId: channel.id,
  sender: "agent",
  senderBotId: bot.id,
  sourceRunId: null,
  content: "Which color?",
  createdAt: channel.createdAt,
  metadata: { type: "widget", widget: { prompt: "Which color?", options: [{ label: "Blue" }] } },
};
const latest = {
  ...question,
  id: "latest",
  sequence: "10000",
  content: "Latest message",
  metadata: {},
};
const target = { ...latest, id: "target", sequence: "2" };
let stage = "settled",
  reads = 0;
const snapshot = {
  ...mobileFixture,
  bots: [bot],
  channels: [channel],
  channelMessages: [],
  runs: [],
  runItems: [],
  subagents: [],
  channelRounds: [],
  cursor: "20000",
};
Object.assign(api, {
  bootstrap: async () => ({
    ...snapshot,
    latestMessages: [],
    activeRuns: [],
    capabilities: CLIENT_CAPABILITIES,
  }),
  channelState: async () => ({
    channelId: channel.id,
    revision: "20000",
    channelRounds: [],
    subagents: [],
    runs: [],
    runItems: [],
    truncated: { channelRounds: false, runs: false, runItems: false, subagents: false },
  }),
  channelHistory: async () => {
    reads++;
    return {
      channelId: channel.id,
      messages:
        stage === "settled"
          ? [{ ...question, metadata: { ...(question.metadata as object), ...receipt } }]
          : [latest],
      threadContext: [],
      threadContextTruncated: false,
      beforeSequence: "1",
      hasMore: false,
      revision: "20000",
    };
  },
  messageContext: async () => ({
    channelId: channel.id,
    targetMessageId: target.id,
    messages: [{ ...question, content: "Stale payload arrived" }, target],
    threadContext: [],
    threadContextTruncated: false,
    beforeSequence: "1",
    afterSequence: "2",
    hasMoreBefore: false,
    hasMoreAfter: false,
    revision: "20000",
  }),
  activeAgent: async () => ({ activeAgentId: bot.id }),
  runtime: async () => ({ runtime: snapshot.runtime }),
});
let model: ReturnType<typeof useOpenTeam>;
function Fixture() {
  model = useOpenTeam();
  return null;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>
);
const wait = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Renderer state did not reach ${label}; rows=${JSON.stringify(retained().map((row) => row.id))}; error=${model?.error}`
  );
};
const retained = () => model.snapshot?.channelMessages ?? [];
async function check() {
  await wait(() => Boolean(model?.snapshot), "bootstrap");
  await model.loadChannel(channel.id);
  await wait(() => retained().some((row) => row.id === question.id), "settled page");
  stage = "replaced";
  await model.loadChannel(channel.id);
  await wait(
    () =>
      retained().some((row) => row.id === latest.id) &&
      !retained().some((row) => row.id === question.id),
    "replacement page"
  );
  if (!(await model.ensureMessageLoaded(channel.id, target.id)))
    throw new Error("Missing context target");
  await wait(
    () => retained().some((row) => row.content === "Stale payload arrived"),
    "stale context"
  );
  const restored = retained().find((row) => row.id === question.id)!;
  for (const [key, value] of Object.entries(receipt)) {
    if ((restored.metadata as Record<string, unknown>)[key] !== value)
      throw new Error(`Stale context reopened question: ${key}`);
  }
  model.clearSearchContext(channel.id);
  await wait(() => !retained().some((row) => row.id === target.id), "clear context");
  await model.ensureMessageLoaded(channel.id, target.id);
  await wait(() => retained().some((row) => row.id === target.id), "repeat context");
  const replay = retained().find((row) => row.id === question.id)!;
  for (const [key, value] of Object.entries(receipt)) {
    if ((replay.metadata as Record<string, unknown>)[key] !== value)
      throw new Error(`Repeated context reopened question: ${key}`);
  }
  console.log("QUESTION_HISTORY_RESULT " + JSON.stringify({ answered, reads, restored: true }));
}
void check().catch((error) =>
  console.log("QUESTION_HISTORY_RESULT " + JSON.stringify({ error: String(error) }))
);
