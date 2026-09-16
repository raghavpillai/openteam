import type { BotRecipe } from "@openteam/contracts";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { TemplateDetails } from "../../src/renderer/components/openteam/template-details";

// Only the shipping presentation component and the existing fictional reference
// facts are used. This fixture cannot publish, call a server, or change a bot.
window.fetch = async () => {
  throw new Error("Network disabled in pixel/motion fixture");
};
const recipe: BotRecipe = {
  profile: {
    name: "Memory Box 914",
    description:
      "Holds reusable project conventions for how reports are written, how launches are reviewed, and how staging is batched.",
    avatarColor: "#5bc67a",
    avatarShape: "classic",
  },
  memory: [
    "For the fictional MBOX-914-B Meridian project, reports must start with actionable next steps and use SI units.",
    "For the fictional MBOX-914-B Meridian project, the database is PostgreSQL.",
    "For the fictional MBOX-914-B Meridian project, the review is planned for November 8, 2026 at 15:20 UTC.",
    "For the fictional MBOX-914-B Meridian project, launch requires manual review and the staging batch size is 37.",
    "For the fictional MBOX-914-B Meridian project, the accent is peach.",
  ].map((content) => ({ content, kind: "log" })),
  skills: [],
  routines: [],
  plugins: [],
  visibility: "team",
};
function Fixture() {
  const [open, setOpen] = useState(false);
  const [activeRecipe, setActiveRecipe] = useState(recipe);
  const [dark, setDark] = useState(true);
  const [action, setAction] = useState("");
  const [traces, setTraces] = useState<unknown[]>([]);
  useEffect(() => {
    const pending = new Set<number>();
    const record = (event: AnimationEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.classList.contains("template-page") ||
        target.classList.contains("outgoing")
      )
        return;
      const start = performance.now();
      const frames: unknown[] = [];
      const sample = () => {
        const elapsed = performance.now() - start;
        const panes = [...document.querySelectorAll<HTMLElement>(".template-page")].map(
          (element) => {
            const style = getComputedStyle(element),
              rect = element.getBoundingClientRect();
            return {
              page: element.dataset.page,
              outgoing: element.classList.contains("outgoing"),
              inert: element.inert,
              transform: style.transform,
              opacity: style.opacity,
              duration: style.animationDuration,
              easing: style.animationTimingFunction,
              x: rect.x,
              y: rect.y,
              width: rect.width,
            };
          }
        );
        frames.push({ elapsed, panes });
        if (elapsed < 350) {
          const id = requestAnimationFrame(() => {
            pending.delete(id);
            sample();
          });
          pending.add(id);
        } else setTraces((previous) => [...previous, { animation: event.animationName, frames }]);
      };
      sample();
    };
    document.addEventListener("animationstart", record);
    return () => {
      document.removeEventListener("animationstart", record);
      pending.forEach(cancelAnimationFrame);
    };
  }, []);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="mb-4 text-base">Isolated pixel and motion audit</h1>
      <div className="flex gap-4 text-sm">
        <button
          type="button"
          onClick={() => {
            setActiveRecipe(recipe);
            setOpen(true);
          }}
        >
          Open reference template
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveRecipe({
              ...recipe,
              skills: [
                {
                  name: "Reference skill",
                  description: "A fictional skill description.",
                  content: "Always start with the next action.",
                },
              ],
              routines: [
                {
                  slug: "daily-review",
                  name: "Daily review",
                  description: "Review the fictional project each day.",
                  content: "Summarize pending tasks.",
                },
              ],
              plugins: [
                {
                  pluginId: "synthetic",
                  name: "Reference integration",
                  description: "No credentials or external connection.",
                },
              ],
            });
            setOpen(true);
          }}
        >
          Open rich template
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveRecipe({
              ...recipe,
              profile: { ...recipe.profile, description: "" },
              memory: [],
            });
            setOpen(true);
          }}
        >
          Open empty template
        </button>
        <button
          type="button"
          onClick={() => {
            setDark(!dark);
            document.documentElement.dataset.theme = dark ? "light" : "dark";
          }}
        >
          Theme: {dark ? "dark" : "light"}
        </button>
      </div>
      <output>{action}</output>
      <output data-motion-traces hidden>
        {JSON.stringify(traces)}
      </output>
      <TemplateDetails
        recipe={activeRecipe}
        version={1}
        open={open}
        onOpenChange={setOpen}
        action="Publish"
        busy={false}
        onAction={() => setAction("Publish intercepted — no mutation")}
        updatedAt="2026-09-14T12:00:00.000Z"
        error=""
      />
    </main>
  );
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Fixture root missing");
const root = createRoot(rootElement);
import.meta.hot?.dispose(() => root.unmount());
root.render(
  <StrictMode>
    <Fixture />
  </StrictMode>
);
