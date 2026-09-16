import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";
import { mobileFixture } from "../../src/fixtures";
import conversation from "../../../../scripts/screenshots/readme-conversation.json";

// Native screenshot entry point. Only sample records are used; no server is configured.
const at = new Date();
at.setHours(8, 0, 0, 0);
mobileFixture.runs = [];
mobileFixture.approvals = [];
mobileFixture.channelMessages = conversation.map((message, index) => ({
  id: `readme-message-${index}`,
  sequence: String(index + 1),
  channelId: "channel-research",
  sender: message.sender as "user" | "agent",
  senderBotId: message.sender === "agent" ? "bot-research" : null,
  sourceRunId: null,
  content: message.content,
  metadata: {},
  createdAt: new Date(at.getTime() + index * 60_000).toISOString(),
}));

const context = require.context("./routes", true, /\.[jt]sx?$/);
registerRootComponent(() => <ExpoRoot context={context} />);
