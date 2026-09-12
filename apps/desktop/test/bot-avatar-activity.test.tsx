import { describe, expect, test } from "bun:test";
import type { ChannelView, RunView } from "@openteam/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BotAvatarActivityProvider,
  useBotAvatarMode,
} from "../src/renderer/components/openteam/bot-avatar-activity";
import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";

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
  test("animates only the running member of the open group", () => {
    expect(mode("one", "group")).toBe("<span>thinking</span>");
    expect(mode("two", "group")).toBe("<span>idle</span>");
    expect(mode("outsider", "group")).toBe("<span>still</span>");
  });
  test("keeps another chat still even when it contains the active bot", () => {
    expect(mode("one", "other-chat")).toBe("<span>still</span>");
    expect(mode("one", undefined, "running", null)).toBe("<span>still</span>");
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
  test("retains new robot choices and consistently maps saved legacy icons", () => {
    expect(normalizeRobotAvatarShape("periscope")).toBe("periscope");
    expect(normalizeRobotAvatarShape(" DUAL-SCREEN ")).toBe("dual-screen");
    expect(normalizeRobotAvatarShape("triangle")).toBe("classic");
    expect(normalizeRobotAvatarShape("hexagon")).toBe("hex-visor");
    expect(normalizeRobotAvatarShape("cloud")).toBe("chip");
    expect(normalizeRobotAvatarShape(null)).toBe("chip");
  });
});
