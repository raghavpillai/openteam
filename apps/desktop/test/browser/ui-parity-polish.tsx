import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotRecipe, ChannelMessageView } from "@openteam/contracts";
import "../../src/renderer/styles.css";
import { api } from "../../src/renderer/client/openteam-api";
import { ReviewActionCard } from "../../src/renderer/components/openteam/review-action-card";

// Manual browser QA: this fixture has no external side effects. All mutations
// are recorded visibly so read-only review can be distinguished from publishing.
if (window.openteam) throw new Error("Open this fixture in an isolated browser tab.");
window.fetch = async () => {
  throw new Error("External network is disabled in this fixture.");
};
const recipe: BotRecipe = {
  profile: {
    name: "Meridian report assistant",
    description: "Start reports with actionable next steps and use SI units.",
    avatarColor: "#5bc67a",
    avatarShape: "classic",
  },
  memory: [
    { content: "Launches require a manual review.", kind: "profile" },
    { content: "Staging batches contain 37 items.", kind: "log" },
  ],
  skills: [
    {
      name: "Release report",
      description: "Write the release summary.",
      content: "Describe the next action, risks, and owner.",
    },
  ],
  routines: [
    {
      slug: "weekly-review",
      name: "Weekly review",
      description: "Prepare the weekly release review.",
      content: "Collect the latest release checklist.",
    },
  ],
  plugins: [
    {
      pluginId: "example",
      name: "Example integration",
      description: "Provides release checklist data.",
    },
  ],
  visibility: "team",
};
const message = {
  id: "synthetic-template",
  content: "",
  metadata: {
    type: "review-action",
    cardState: "pending",
    review: { kind: "template", recipe, version: 1 },
  },
} as ChannelMessageView;
let failNext = false;
let reflect: (actions: string[]) => void = () => undefined;
const actions: string[] = [];
api.mutateReviewAction = (async (_id: string, action: string) => {
  actions.push(action);
  reflect([...actions]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (failNext) {
    failNext = false;
    throw new Error("Synthetic request failed. Retry is safe.");
  }
  return {
    message: {
      ...message,
      metadata: {
        ...(message.metadata as object),
        cardState:
          action === "unpublish" ? "unpublished" : action === "cancel" ? "canceled" : "published",
      },
    },
    ...(action === "import" ? { botId: "synthetic-import" } : {}),
  };
}) as typeof api.mutateReviewAction;
api.reviewRecipe = async () => recipe;
function Fixture() {
  const [log, setLog] = useState<string[]>([]);
  const [failing, setFailing] = useState(false);
  reflect = setLog;
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="mb-3 text-base font-medium">Isolated template review</h1>
      <p className="mb-4 text-[13px] text-foreground-secondary">
        Synthetic data; no publishing service or network connection.
      </p>
      <button
        className="mb-4 rounded-lg bg-subtle px-3 py-2 text-[13px]"
        onClick={() => {
          failNext = true;
          setFailing(true);
        }}
      >
        Fail next action{failing ? " (armed)" : ""}
      </button>
      <output aria-label="Mutation log" className="mb-4 block text-[13px]">
        {JSON.stringify(log)}
      </output>
      <ReviewActionCard message={message} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>
);
