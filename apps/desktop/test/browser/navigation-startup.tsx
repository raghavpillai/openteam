import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useOpenTeam } from "../../src/renderer/state/use-openteam";
import { api } from "../../src/renderer/client/openteam-api";
import { ClientError } from "../../src/renderer/client/http";
import {
  Conversation,
  ConversationContent,
} from "../../src/renderer/components/ai-elements/conversation";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { mobileFixture } from "../../../ios/scripts/fixtures/snapshot";
import "../../src/renderer/styles.css";
const root = createRoot(document.getElementById("root")!);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reports: string[] = [];
const failures: string[] = [];
Object.defineProperty(document, "hidden", { configurable: true, value: true });
window.fetch = async () => {
  throw new Error("Unexpected network request");
};
const snapshot = { ...structuredClone(mobileFixture), cursor: "14" };
const bootstrap = {
  ...snapshot,
  latestMessages: snapshot.channelMessages,
  activeRuns: snapshot.runs,
  capabilities: CLIENT_CAPABILITIES,
};
const id = snapshot.channels[0]!.id;
let state: ReturnType<typeof useOpenTeam>;
function Fixture() {
  state = useOpenTeam();
  useEffect(() => {
    if (state.snapshot) void state.loadChannel(id);
  }, [state.snapshot !== null]);
  return state.snapshot ? (
    <Conversation style={{ height: 600, width: 500 }}>
      <ConversationContent
        initialContentPending={state.historyByChannel.get(id)?.initialLoading ?? true}
      >
        <p>Saved conversation is readable</p>
      </ConversationContent>
    </Conversation>
  ) : (
    <div>Connecting</div>
  );
}
async function run(name: string, test: () => Promise<void>) {
  root.render(null);
  await pause(30);
  try {
    await test();
    reports.push(name);
  } catch (error) {
    failures.push(`${name}: ${error}`);
  }
}
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
await run("cold legacy snapshot opens without a permanent loading indicator", async () => {
  Object.assign(api, {
    bootstrap: async () => {
      throw new ClientError("missing", "not_found", 404);
    },
    snapshot: async () => snapshot,
  });
  root.render(
    <StrictMode>
      <Fixture />
    </StrictMode>
  );
  await pause(1000);
  check(state.snapshot, "snapshot did not load");
  check(
    document.querySelector('[data-chat-layout-ready="true"]'),
    "loaded legacy snapshot remained hidden"
  );
});
await run("cold bootstrap recovers after a temporary startup failure in StrictMode", async () => {
  let attempts = 0;
  Object.assign(api, {
    bootstrap: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary startup failure");
      return bootstrap;
    },
    channelHistory: async () => ({
      channelId: id,
      messages: [],
      threadContext: [],
      hasMore: false,
      beforeSequence: null,
      revision: "14",
    }),
    channelState: async () => ({
      channelId: id,
      revision: "14",
      runs: [],
      runItems: [],
      subagents: [],
      channelRounds: [],
      truncated: {},
    }),
  });
  root.render(
    <StrictMode>
      <Fixture />
    </StrictMode>
  );
  await pause(4200);
  check(state.snapshot, `startup did not recover (${attempts} requests): ${state.error}`);
});
await run("switching directly between search-result threads waits for the new layout", async () => {
  Object.assign(api, {
    pluginComposer: async () => ({ items: [] }),
    messageDeliveryStatus: async () => ({ status: "not_found", acceptedAtMs: null, message: null }),
  });
  const template = snapshot.channelMessages[0]!;
  const make = (group: string, index: number) => ({
    ...template,
    id: `${group}-${index}`,
    channelId: id,
    sequence: String((group === "a" ? 0 : 100) + index),
    content:
      group === "b"
        ? "## New thread\n\n" +
          "- A longer formatted reply to prepare before displaying.\n".repeat(6)
        : `Thread ${group} reply ${index}`,
    metadata: index ? { replyTo: `${group}-0`, branched: true } : {},
    createdAt: new Date(1700000000000 + ((group === "a" ? 0 : 100) + index) * 1000).toISOString(),
  });
  const messages = [
    ...Array.from({ length: 45 }, (_, i) => make("a", i)),
    ...Array.from({ length: 45 }, (_, i) => make("b", i)),
  ];
  const botById = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  const empty = new Map();
  const render = (target: string) =>
    root.render(
      <StrictMode>
        <TooltipProvider>
          <main style={{ height: 650, width: 850, position: "relative" }}>
            <ChatPane
              channel={snapshot.channels[0]!}
              active
              selectedBot={snapshot.bots[0]}
              botById={botById}
              agentNameById={empty}
              itemsByRun={empty}
              capabilities={CLIENT_CAPABILITIES}
              messages={target.startsWith("a") ? messages.slice(0, 45) : messages}
              runs={[]}
              subagents={[]}
              runtime={snapshot.runtime}
              mutate={async (operation) => operation()}
              focusMessage={{ messageId: target, nonce: target === "a-25" ? 1 : 2 }}
            />
          </main>
        </TooltipProvider>
      </StrictMode>
    );
  render("a-25");
  await pause(1500);
  check(document.querySelector('[data-thread-message-id="a-25"]'), "first thread did not open");
  render("b-25");
  let revealedY: number | undefined;
  for (let i = 0; i < 100; i++) {
    await new Promise(requestAnimationFrame);
    const tray = document.querySelector("[data-thread-tray]");
    const content = tray?.querySelector('[role="list"] > div');
    check(
      !(
        content?.getAttribute("aria-hidden") === "false" &&
        content.querySelector("[data-chat-layout-pending]")
      ),
      "new thread displayed unfinished content using the previous thread's ready state"
    );
    if (content?.getAttribute("aria-hidden") === "false") {
      const target = content
        .querySelector('[data-thread-message-id="b-25"]')
        ?.getBoundingClientRect();
      const port = tray!.querySelector('[role="list"]')!.getBoundingClientRect();
      check(target, "search target was not mounted at reveal");
      if (target) {
        const y = target.top - port.top;
        if (revealedY !== undefined)
          check(Math.abs(y - revealedY) <= 1, `target moved ${y - revealedY}px after reveal`);
        revealedY = y;
        check(
          target.bottom > port.top && target.top < port.bottom,
          "search target is outside the visible thread"
        );
      }
    }
  }
  check(revealedY !== undefined, "second thread never finished preparing");
  check(document.querySelector('[data-thread-message-id="b-25"]'), "second thread did not open");
});
root.render(null);
console.log(
  "IMAGE_LAYOUT_RESULT " +
    JSON.stringify({ reports, error: failures.length ? failures.join("\n") : undefined })
);
