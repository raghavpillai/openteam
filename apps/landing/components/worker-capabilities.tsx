"use client";

import { Tabs } from "@base-ui/react/tabs";
import { ArrowUpRight, CalendarClock, HardDrive, Monitor, Smartphone } from "lucide-react";
import { ComputerDemo, MemoryDemo, MobileDemo, RoutineDemo } from "./app-demo-details";

const capabilities = [
  {
    id: "computer",
    label: "Computer",
    icon: Monitor,
    heading: "Watch the screen. Take control when needed.",
    description:
      "Your workers use Chromium, a terminal, and a shared filesystem. Each worker has its own screen on the team's computer.",
    detail:
      "Watch the live screen, take over to sign in or complete a step, then return control to the worker.",
    demo: ComputerDemo,
  },
  {
    id: "memory",
    label: "Memory",
    icon: HardDrive,
    heading: "Keep instructions and context between tasks.",
    description:
      "Each worker keeps an ongoing conversation and saved notes. Shared memory and project files give the team context it can reuse.",
    detail:
      "Memory is stored in editable Markdown files on your server. Read the notes, correct them, or add instructions yourself.",
    demo: MemoryDemo,
  },
  {
    id: "routines",
    label: "Scheduled work",
    icon: CalendarClock,
    heading: "Give recurring work a schedule.",
    description:
      "Ask a worker to check dashboards every morning or prepare a weekly report. Save the instructions and choose when it runs.",
    detail:
      "Each run uses the worker's conversation context. Review results in the same thread and inspect the run history.",
    demo: RoutineDemo,
  },
  {
    id: "apps",
    label: "Desktop + iPhone",
    icon: Smartphone,
    heading: "The same team on desktop and iPhone.",
    description:
      "Send messages, review files, and follow the work from either app. Both connect to the same workers and conversations on your server.",
    detail:
      "Check available desktop builds for macOS, Windows, and Linux. The iPhone app is currently available to build from source.",
    demo: MobileDemo,
  },
];

export function WorkerCapabilities() {
  return (
    <Tabs.Root defaultValue="computer" className="ot-worker-tabs">
      <Tabs.List className="ot-worker-tab-list" aria-label="Explore worker capabilities">
        {capabilities.map(({ id, label, icon: Icon }) => (
          <Tabs.Tab value={id} key={id} className="ot-worker-tab">
            <Icon size={17} /> {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {capabilities.map(({ id, heading, description, detail, demo: Demo }) => (
        <Tabs.Panel value={id} key={id} className={`ot-worker-panel ot-worker-panel-${id}`}>
          <div className="ot-worker-panel-copy">
            <h3>{heading}</h3>
            <p>{description}</p>
            <p>{detail}</p>
            {id === "apps" && (
              <a href="/download" className="ot-text-link">
                See available downloads <ArrowUpRight size={15} />
              </a>
            )}
          </div>
          <div className="ot-worker-panel-demo">
            <Demo />
          </div>
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
