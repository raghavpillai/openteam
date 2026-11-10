// Offline visual review of shipping components. Never connects to an account.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotView, ChannelView, ChannelMessageView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { DesktopHeader } from "../../src/renderer/components/openteam/desktop-header";
import { Inspector } from "../../src/renderer/components/openteam/inspector";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { api } from "../../src/renderer/client/openteam-api";
import "../../src/renderer/styles.css";
window.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("https://style-review.invalid/")) {
    if (url.endsWith(".docx"))
      return new Response(
        Uint8Array.from(
          atob(
            "UEsDBBQAAAAIANykal33S4B1wgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QuQ7CMAyGX6XKiqgRAwOiLMAKDLyAlbptRC7FLsfbk3INCBjt//gsLw7XSFxcnPVcqU4kzgFYd+SQyxDJZ6UJyaHkMbUQUR+xJZhOJjPQwQt5GcvQoZaLNTXYWyk2l7xmE3ylEllWxephHFiVwhit0ShZh5OvPyjjJ6HMybuHOxN5lA0KvhIG5TfgmdudKCVTU7HHJFt02QXnkGqog+5dTpb/a77cGZrGaHrnh7aYgiZm41tny7fi0PjX/XB/9/IGUEsDBBQAAAAIANykal1hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACADcpGpdCKvOi5QAAADmAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sbY9RCsIwDIavUnYAM3zwocyBN/AKtYtbsWlL0q16e1tBBfHlC/kT8v8Zip6iXQlDVnfyQXQ5dkvOSQOIXZCM7GLCUGfXyGRybXmGEnlKHC2KuDCTh33fH4CMC904FH2J06PV1MANeTwzbg6LEkPJ4wBNa+QX0+/6SQVcMxuvPvlqALU5WatWk9mb7P5cgbc7fD8bn1BLAQIUAxQAAAAIANykal33S4B1wgAAAHYBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgA3KRqXWF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAIAB8wAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgA3KRqXQirzouUAAAA5gAAABEAAAAAAAAAAAAAAIABpQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAGgCAAAAAA=="
          ),
          (c) => c.charCodeAt(0)
        )
      );
    return new Response(
      url.endsWith(".csv")
        ? "Month,Revenue,Orders\nJanuary,1200,12\nFebruary,1500,15\n"
        : "Preview sample\nA neutral file for visual checks."
    );
  }
  throw Error("Offline review: network disabled");
};
Object.assign(api, {
  assetUrl: (asset: { fileName: string }) => `https://style-review.invalid/${asset.fileName}`,
  routines: async () => [],
  pluginComposer: async () => ({ items: [] }),
});
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "dark";
const bot = {
  id: "review-bot",
  name: "Cap c18-1",
  color: "#1084fe",
  icon: "classic",
  status: "active",
  title: "",
  description: "",
  instructions: "",
} as BotView;
const channel = {
  id: "review-chat",
  kind: "bot_dm",
  name: bot.name,
  members: [{ botId: bot.id, ordinal: 0 }],
  createdAt: "2026-11-10T10:00:00Z",
} as ChannelView;
const bots = new Map([[bot.id, bot]]),
  empty = new Map();
const texts = [
  ["user", "Quick one: what's an 18% tip on $86.40?"],
  ["agent", "An 18% tip on $86.40 is $15.55, so the total comes to $101.95."],
  ["user", "And how many tablespoons are in a cup?"],
  ["agent", "A cup is 16 tablespoons in US measurements."],
  [
    "user",
    "Suggest a birthday gift for my sister, and tell me the latest date I should order it so it arrives on time.",
  ],
  [
    "agent",
    "On it. I'm looking for unscented orchid gifts under $60 that ship to Boston and checking their delivery times.",
  ],
  [
    "agent",
    "I'm now comparing a few unscented orchid options. Her birthday falls on a Sunday next year, and plenty of florists don't deliver on Sundays, so I'm working out order-by dates with that in mind.",
  ],
  [
    "agent",
    "My pick is the [Calyx Flowers Petite Phalaenopsis Plant](https://calyxflowers.com/product/petit-phalaenopsis-plant/). It's $25 plus shipping, a double-spiked mini orchid in a white or olive ceramic pot, and Phalaenopsis orchids have no scent. That leaves plenty of room under your $60 budget for two-day shipping, though the site didn't list the exact shipping price.\n\n**Order it by Friday, March 5, 2027, and choose Friday, March 12 for delivery.** Her birthday lands on a Sunday, and Calyx doesn't deliver on Sundays. Plants ship by two-day air, and they can push a delivery back by up to 5 days for weather. Ordering by the 5th leaves you a cushion, and you can order earlier and still pick the date.\n\nA couple of nicer options go over budget: the [Bloomscape Little White Orchid](https://bloomscape.com/product/little-white-orchid/) is $69 with free express shipping, and the [ProFlowers Bliss White Orchid](https://proflowers.com/product/bliss-white-orchid-prd-p2162) comes to about $80 with delivery. Want me to set a reminder for late February so you can order it then?",
  ],
];
const messages = texts.map(([sender, content], i) => ({
  id: `review-${i}`,
  channelId: channel.id,
  sequence: String(i + 1),
  sender,
  senderBotId: sender === "agent" ? bot.id : null,
  sourceRunId: null,
  content,
  metadata: {},
  createdAt: new Date(Date.parse("2026-11-10T10:00:00Z") + i * 10000).toISOString(),
})) as ChannelMessageView[];
if (new URLSearchParams(location.search).has("onboarding")) {
  messages.splice(
    0,
    messages.length,
    {
      ...messages[1]!,
      id: "greeting",
      content:
        "Hi Raghav, I'm Cap c18-1. Glad to be here and ready to help with whatever you need.",
    },
    {
      ...messages[1]!,
      id: "question",
      sequence: "2",
      content: "",
      metadata: {
        type: "widget",
        widget: {
          prompt: "What would you most like a hand with?",
          options: [
            "Email and inbox",
            "Calendar and scheduling",
            "Research and reports",
            "Errands and shopping",
            "Cooking and meal planning",
          ].map((label, i) => ({ label, value: String(i) })),
          multiSelect: false,
        },
      },
    },
    {
      ...messages[0]!,
      id: "background",
      sequence: "3",
      content:
        "Some background for later: my sister Priya's birthday is March 14, she loves orchids but hates anything scented, and my gift budget is $60. I live in Boston.",
    },
    { ...messages[1]!, id: "saved", sequence: "4", content: "Got it, I'm saving that now." },
    {
      ...messages[1]!,
      id: "memory",
      sequence: "5",
      content:
        "I've saved it: Priya's birthday is March 14, she loves orchids but nothing scented, your budget is $60, and you're in Boston. Want me to set a reminder for early March that comes with a few unscented orchid gift ideas under $60?",
    }
  );
}
if (new URLSearchParams(location.search).has("files")) {
  const names = [
    "bank-transactions-reconciled-v2-2026-11-10.csv",
    "bank-transactions-reconciled-v2-coverage.csv",
    "Preview sample.docx",
    "Project notes.txt",
    "Design.key",
    "Ledger.numbers",
    "Archive.zip",
  ];
  const attachments = names.map((fileName, i) => ({
    assetId: String(i + 1).repeat(64),
    fileName,
    byteSize: i === 0 ? 76800 : i === 1 ? 5325 : 2048,
    kind: "file" as const,
    mimeType: fileName.endsWith(".csv")
      ? "text/csv"
      : fileName.endsWith(".docx")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : fileName.endsWith(".txt")
          ? "text/plain"
          : "application/octet-stream",
  }));
  messages.splice(
    0,
    messages.length,
    ...attachments.map((attachment, i) => ({
      ...messages[1]!,
      id: `file-${i}`,
      content: i === 0 ? "File preview samples" : "",
      metadata: { attachments: [attachment] },
    }))
  );
}
messages.forEach((message, i) => {
  message.sequence = String(i + 1);
  message.createdAt = new Date(Date.parse("2026-11-10T10:00:00Z") + i * 10000).toISOString();
});
const noop = () => {};
function Review() {
  const [open, setOpen] = useState(true),
    [mode, setMode] = useState<"summary" | "settings" | "routine">("summary");
  return (
    <TooltipProvider>
      <main style={{ display: "flex", height: "100vh", position: "relative" }}>
        <DesktopHeader
          agentNameById={empty}
          botById={bots}
          detailsOpen={open}
          inspectorWidth={280}
          inspectorMode={mode}
          selected={channel}
          selectedBot={bot}
          onDetailsOpenChange={setOpen}
          onShowSummary={() => setMode("summary")}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChatPane
            channel={channel}
            selectedBot={bot}
            botById={bots}
            agentNameById={empty}
            itemsByRun={empty}
            capabilities={CLIENT_CAPABILITIES}
            messages={messages}
            runs={[]}
            subagents={[]}
            runtime={
              {
                server: "ready",
                database: "ready",
                queue: "ready",
                computer: "ready",
                inference: "ready",
              } as any
            }
            mutate={async (op) => op()}
            focusMessage={null}
          />
        </div>
        <div
          style={{
            width: open ? 280 : 0,
            overflow: "hidden",
            borderLeft: "0.5px solid var(--border)",
            transition: "width 300ms cubic-bezier(.22,1,.36,1)",
          }}
          inert={!open}
        >
          <div style={{ width: 280, height: "100%" }}>
            <Inspector
              channel={channel}
              botById={bots}
              active={open}
              screenEnabled={false}
              mode={mode}
              onEnableScreen={noop}
              onModeChange={setMode}
              onUpdateBot={async () => bot}
              onRetryBot={async () => {}}
              onOpenTeam={noop}
              onSetGroupAvatar={async () => {}}
              onSetMembers={async () => {}}
              onUpdateGroupProfile={async () => channel}
            />
          </div>
        </div>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Review />);
