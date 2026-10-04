import React from "react";
import { createRoot } from "react-dom/client";
import { Message, MessageContent, MessageResponse } from "../../src/renderer/components/ai-elements/message";
import { RichMessage } from "../../src/renderer/components/openteam/rich-message";
import type { ChannelMessageView } from "@openteam/contracts";
import "../../src/renderer/styles.css";

document.documentElement.dataset.theme = "light";
const report = "Stopped after the first browser error (allocation not ready). No heading retrieved; no `browser_run_code` run.\n\n**Tool call 1 — FAILURE**\n\n- Tool: `browser_navigate`\n- Args: `{\"url\":\"https://example.com\"}`\n- Receipt: `Error: This agent's browser window is not ready yet; try again in a moment.`\n\nPage heading: not retrieved.";
const question = new URLSearchParams(location.search).has("question");
const widget = {
  id: "rounding-review-widget", channelId: "rounding-review", sequence: "2", sender: "agent",
  content: "", createdAt: "2026-10-04T12:00:00Z", metadata: {
    type: "widget", respondedValue: "all",
    widget: { prompt: "What would you like me to search for?", options: [{ label: "Unread mail", value: "unread" }], allowCustom: true },
  },
} as ChannelMessageView;
const content = question ? [
  "Yes, I can search both accounts together.", "", "I’ll search across all mail in both accounts, without an unread filter, and start with the newest results.",
] : [
  "On it — opening example.com in the browser and running that page evaluate next.",
  "Browser worker finished — pulling the heading and tool receipts now.", report, report,
];
const positions = question ? ["first", "middle", "last"] as const : ["first", "middle", "middle", "last"] as const;
createRoot(document.getElementById("root")!).render(
  <main style={{ width: 560, margin: "13.5px 11px", display: "flex", flexDirection: "column", gap: 4 }}>
    {content.map((text, index) => <Message key={index} from="assistant">
      <div className="message-with-actions" data-role="assistant" data-group-position={positions[index]} style={{ maxWidth: "100%", width: question && index === 1 ? "100%" : "fit-content" }}>
        {question && index === 1 ? <RichMessage message={widget} /> : <MessageContent from="assistant" data-group-position={positions[index]}><MessageResponse>{text}</MessageResponse></MessageContent>}
      </div>
    </Message>)}
  </main>
);
