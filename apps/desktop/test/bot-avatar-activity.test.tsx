import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, ChannelView, RunItemView, RunView } from "@openteam/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BotAvatarActivityProvider,
  useBotAvatarMode,
} from "../src/renderer/components/openteam/bot-avatar-activity";

const channel = { id: "group", members: [{ botId: "one" }, { botId: "two" }] } as ChannelView;
function Probe({ botId, channelId }: { botId: string; channelId?: string }) {
  return <span>{useBotAvatarMode(botId, channelId)}</span>;
}
function mode(
  botId: string,
  channelId?: string,
  status: RunView["status"] = "running",
  active: ChannelView | null = channel
) {
  return renderToStaticMarkup(
    <BotAvatarActivityProvider channel={active} run={{ botId: "one", status } as RunView}>
      <Probe botId={botId} channelId={channelId} />
    </BotAvatarActivityProvider>
  );
}

describe("robot avatar chat activity", () => {
  test("shows the open chat's live activity and waits on unanswered cards", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarActivityProvider
        channel={channel}
        runsByChannel={new Map([["group", [{ id: "run", botId: "one", status: "running" } as RunView]]])}
        itemsByRun={new Map([["run", [{ id: "i", runId: "run", kind: "tool", status: "running", title: null, content: { tool: "WebSearch" }, createdAt: "t", updatedAt: "t" } as RunItemView]]])}
        latestMessageByChannel={new Map([["group", { sender: "agent", senderBotId: "two", metadata: { type: "user-form" } } as ChannelMessageView]])}
      >
        <Probe botId="one" channelId="group" />
        <Probe botId="two" channelId="group" />
      </BotAvatarActivityProvider>
    );
    expect(markup).toBe("<span>searching</span><span>waiting</span>");
  });
  test("animates only the running member of the open group", () => {
    expect(mode("one", "group")).toBe("<span>thinking</span>");
    expect(mode("two", "group")).toBe("<span>idle</span>");
    expect(mode("outsider", "group")).toBe("<span>idle</span>");
  });
  test("keeps another chat idle even when it contains the active bot", () => {
    expect(mode("one", "other-chat")).toBe("<span>idle</span>");
    expect(mode("one", undefined, "running", null)).toBe("<span>still</span>");
  });
  test("passes background conversation runs to avatars even without an open chat", () => {
    const runsByChannel = new Map([["background", [
      { botId: "one", status: "running" } as RunView,
      { botId: "two", status: "queued" } as RunView,
    ]]]);
    const markup = renderToStaticMarkup(
      <BotAvatarActivityProvider channel={null} runsByChannel={runsByChannel}>
        <Probe botId="one" channelId="background" />
        <Probe botId="two" channelId="background" />
        <Probe botId="one" channelId="resting" />
      </BotAvatarActivityProvider>
    );
    expect(markup).toBe("<span>working</span><span>working</span><span>idle</span>");
  });
  test("returns to idle for completion, failure, cancellation, and approval", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "waiting_approval",
    ] as const) {
      expect(mode("one", "group", status)).toBe("<span>idle</span>");
    }
  });
});
