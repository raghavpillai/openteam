// Offline visual review of shipping components. Never connects to an account.
import { createRoot } from "react-dom/client";
import type { BotView, ChannelView, ChannelMessageView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { api } from "../../src/renderer/client/openteam-api";
import { API_BASE } from "../../src/renderer/client/http";
import "../../src/renderer/styles.css";
const visualAssetFetches: string[] = [];
Object.assign(window, { visualAssetFetches });
window.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith(API_BASE + "/api/assets/")) {
    visualAssetFetches.push(url);
    if (url.endsWith(".png") || url.endsWith(".jpg")) {
      if (params.get("media") === "missing") return new Response("Not found", { status: 404 });
      if (params.get("media") === "broken")
        return new Response("invalid image", { headers: { "content-type": "image/png" } });
      if (params.get("media") === "slow") await new Promise((resolve) => setTimeout(resolve, 900));
      const colors = ["#db4444", "#3b9c50", "#407cdf", "#e5bf35", "#8b5bc5", "#db823e"];
      const index = /n(\d+)-/.test(url)
        ? Number(/n(\d+)-/.exec(url)![1]) - 1
        : Number(/image-(\d+)/.exec(url)?.[1] ?? 0);
      const twenty = params.get("media") === "twenty";
      const solids = [
        "#ff0000",
        "#008000",
        "#0000ff",
        "#ffff00",
        "#800080",
        "#00ffff",
        "#ff00ff",
        "#a52a2a",
        "#ffc0cb",
        "#808080",
        "#000080",
        "#808000",
        "#800000",
        "#00ff00",
        "#008080",
        "#ffa500",
        "#ffd700",
        "#c0c0c0",
        "#ff7f50",
        "#000000",
      ];
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${twenty ? 640 : index % 2 ? 600 : 400}" height="${twenty ? 480 : index % 2 ? 400 : 800}"><rect width="100%" height="100%" fill="${twenty ? solids[index % solids.length] : colors[index % colors.length]}"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } }
      );
    }
    if (url.endsWith(".xlsx")) {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ["Month", "Revenue", "Orders"],
          ["January", 1200, 12],
          ["February", 1500, 15],
        ]),
        "Summary"
      );
      return new Response(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    }
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
  assetUrl: (asset: { fileName: string }) =>
    (window as Window & { visualAuditAssetUrls?: Record<string, string> }).visualAuditAssetUrls?.[
      asset.fileName
    ] ?? `${API_BASE}/api/assets/${encodeURIComponent(asset.fileName)}`,
  routines: async () => [],
  pluginComposer: async () => ({ items: [] }),
});
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "dark";
const bot = {
  id: "review-bot",
  name: new URLSearchParams(location.search).get("bot") ?? "Cap c18-1",
  color: new URLSearchParams(location.search).get("botColor") ?? "#1084fe",
  icon: "classic",
  status: "active",
  title: "",
  description: "",
} as BotView;
if (new URLSearchParams(location.search).has("legacy-profile")) {
  bot.title = "Existing internal title";
}
Object.defineProperty(window, "desktopStyleProfile", { get: () => ({ ...bot }) });
const channel = {
  id: "review-chat",
  kind: "bot_dm",
  name: bot.name,
  members: [{ botId: bot.id, ordinal: 0 }],
  createdAt: "2026-11-10T10:00:00Z",
} as ChannelView;
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
const colorSample = new URLSearchParams(location.search).get("colorSample");
if (colorSample) texts.splice(0, texts.length, ["user", colorSample]);
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
const mediaMode = new URLSearchParams(location.search).get("media");
const solidNames = [
  "red",
  "green",
  "blue",
  "yellow",
  "purple",
  "cyan",
  "magenta",
  "brown",
  "pink",
  "gray",
  "navy",
  "olive",
  "maroon",
  "lime",
  "teal",
  "orange",
  "gold",
  "silver",
  "coral",
  "black",
];
const mediaAttachments = Array.from(
  {
    length:
      mediaMode === "single" || mediaMode === "reference" ? 1 : mediaMode === "twenty" ? 20 : 8,
  },
  (_, index) => ({
    assetId: (index + 10).toString(16).padStart(64, "0"),
    fileName:
      mediaMode === "twenty"
        ? `n${String(index + 1).padStart(2, "0")}-${solidNames[index]}.jpg`
        : `image-${index}.png`,
    mimeType: "image/png",
    byteSize: 2048,
    kind: "image" as const,
    width: mediaMode === "twenty" ? 640 : index % 2 ? 600 : 400,
    height: mediaMode === "twenty" ? 480 : index % 2 ? 400 : 800,
    alt:
      mediaMode === "twenty"
        ? `n${String(index + 1).padStart(2, "0")}-${solidNames[index]}.jpg`
        : `Image ${index + 1}`,
  })
);
if (mediaMode === "reference") {
  const reference = (
    window as Window & { visualAuditImage?: { width: number; height: number; alt: string } }
  ).visualAuditImage;
  if (reference) Object.assign(mediaAttachments[0]!, reference, { fileName: "eiffel.jpg" });
}
if (mediaMode)
  messages.splice(0, messages.length, {
    ...messages[1]!,
    content: "Image samples",
    metadata: { attachments: mediaAttachments },
  });
messages.forEach((message, i) => {
  message.sequence = String(i + 1);
  message.createdAt = new Date(Date.parse("2026-11-10T10:00:00Z") + i * 10000).toISOString();
});

import { openTeamClient } from "../../src/renderer/client/openteam-api";
import { initializeTheme } from "../../src/renderer/lib/theme";
localStorage.setItem("openteam:theme", new URLSearchParams(location.search).get("theme") ?? "dark");
initializeTheme();
const params = new URLSearchParams(location.search);
const group = params.has("group");
if (group) {
  channel.kind = "group";
  channel.name = "Audit group";
}
Object.assign(bot, {
  dmChannelId: channel.id,
  onboardingStatus: "completed",
  notifyOnUpdates: true,
});
localStorage.setItem("openteam:selected-channel", channel.id);
localStorage.setItem("openteam:inspector-width", "320");
const runtime = {
  server: "ready",
  database: "ready",
  queue: "ready",
  computer: "ready",
  inference: "ready",
  transcription: "configured",
};
if (params.has("history")) {
  const count = Number(params.get("history"));
  messages.unshift(
    ...Array.from({ length: count }, (_, i) => ({
      ...messages[1]!,
      id: `history-${i}`,
      sequence: String(i + 1),
      content: `Earlier message ${i}: a representative paragraph for smooth panel resizing.`,
      createdAt: new Date(Date.parse("2026-11-01T10:00:00Z") + i * 1000).toISOString(),
    }))
  );
  messages.forEach((message, i) => {
    message.sequence = String(i + 1);
  });
}
const otherChannel = {
  ...channel,
  id: "review-other-chat",
  name: "Other bot",
  members: [{ botId: "review-other-bot", ordinal: 0 }],
};
const otherBot = {
  ...bot,
  id: "review-other-bot",
  name: "Other bot",
  dmChannelId: otherChannel.id,
};
const otherMessages = [
  {
    ...messages[0]!,
    id: "other-message",
    channelId: otherChannel.id,
    content: "A different conversation.",
  },
];
const state = {
  channelId: channel.id,
  revision: "100",
  channelRounds: [],
  runs: [],
  runItems: [],
  subagents: [],
  truncated: { channelRounds: false, runs: false, runItems: false, subagents: false },
};
Object.assign(api, {
  bootstrap: async () =>
    structuredClone({
      cursor: "100",
      workspace: { id: "audit", name: "Audit workspace" },
      bots: params.has("navigation") ? [bot, otherBot] : [bot],
      channels: params.has("navigation") ? [channel, otherChannel] : [channel],
      latestMessages: params.has("navigation")
        ? [messages.at(-1), otherMessages[0]]
        : [messages.at(-1)],
      activeRuns: [],
      channelRounds: [],
      subagents: [],
      runtime,
      capabilities: CLIENT_CAPABILITIES,
    }),
  channelHistory: async (id: string) => ({
    channelId: id,
    messages: id === channel.id ? messages : otherMessages,
    threadContext: [],
    threadContextTruncated: false,
    beforeSequence: null,
    hasMore: false,
    revision: "100",
  }),
  channelLibrary: async (_channelId: string, before: string | null) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const mode = params.get("library");
    if (mode === "error" && !sessionStorage.getItem("library-retried")) {
      sessionStorage.setItem("library-retried", "1");
      throw Error("Controlled Library load failure");
    }
    if (mode === "empty") return { items: [], nextCursor: null };
    if (mode === "images")
      return {
        items: mediaAttachments.map((attachment) => ({
          id: attachment.assetId,
          messageId: "image-samples",
          createdAt: "2026-10-26T00:00:00Z",
          attachment,
        })),
        nextCursor: null,
      };
    const item = (id: string, fileName: string) => ({
      id: id.repeat(64),
      messageId: `library-${id}`,
      createdAt: "2026-10-26T00:00:00Z",
      attachment: {
        assetId: id.repeat(64),
        fileName,
        mimeType: fileName.endsWith("xlsx")
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/plain",
        byteSize: 100,
        kind: "file",
      },
    });
    return {
      items: [before ? item("b", "older-notes.txt") : item("a", "sales_summary.xlsx")],
      nextCursor: before || mode === "single" ? null : "2.1",
    };
  },
  channelState: async (id: string) => ({ ...state, channelId: id }),
  activeAgent: async () => ({ activeAgentId: bot.id }),
  setActiveAgent: async () => ({}),
  markChannelRead: async () => ({ channelId: channel.id, lastReadSequence: "100", unreadCount: 0 }),
  runtime: async () => ({ runtime }),
  search: async () => ({ results: [] }),
  renameChannel: async (_id: string, name: string) => {
    if (name === "Fail rename") throw new Error("Controlled rename failure");
    Object.assign(bot, { name, updatedAt: new Date().toISOString() });
    Object.assign(channel, { name, updatedAt: bot.updatedAt });
    return { ...channel };
  },
  updateBot: async (_id: string, input: { name?: string }) => {
    if (input.name === "Fail rename") throw new Error("Controlled rename failure");
    Object.assign(bot, input, { updatedAt: new Date().toISOString() });
    if (input.name && channel.kind === "bot_dm") channel.name = input.name;
    return { ...bot };
  },
  screenStatus: async () => ({
    botId: bot.id,
    state:
      params.get("screen") === "failed"
        ? "failed"
        : params.get("screen") === "starting"
          ? "starting"
          : "ready",
    width: 1280,
    height: 800,
  }),
  screenTakeover: async () => ({
    botId: bot.id,
    state: params.get("screen") === "failed" ? "failed" : "starting",
    width: 1280,
    height: 800,
  }),
  account: async () => ({ name: "Audit user", email: "audit@example.invalid" }),
});
openTeamClient.listenForEvents = async (_cursor, _handlers, signal) =>
  new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true })
  );
const { default: App } = await import("../../src/renderer/App");
createRoot(document.getElementById("root")!).render(<App />);
