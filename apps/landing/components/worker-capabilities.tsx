"use client";

import { Tabs } from "@base-ui/react/tabs";
import { ArrowUpRight, CalendarClock, HardDrive, Monitor, Smartphone } from "lucide-react";
import { ComputerDemo, MemoryDemo, MobileDemo, RoutineDemo } from "./app-demo-details";
import { useLayoutEffect, useRef, useState } from "react";

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
  const [selected, setSelected] = useState("computer");
  const [direction, setDirection] = useState("forward");
  const stage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = stage.current;
    const panel = element?.querySelector<HTMLElement>(`[data-capability="${selected}"]`);
    if (!element || !panel) return;
    const resize = () => {
      const floor = matchMedia("(min-width: 851px)").matches ? 650 : 0;
      element.style.height = `${Math.max(floor, panel.offsetHeight)}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [selected]);
  return (
    <Tabs.Root value={selected} onValueChange={(value) => {
      setDirection(capabilities.findIndex((item) => item.id === value) >= capabilities.findIndex((item) => item.id === selected) ? "forward" : "backward");
      setSelected(String(value));
    }} className="ot-worker-tabs" data-direction={direction}>
      <Tabs.List className="ot-worker-tab-list" aria-label="Explore worker capabilities">
        {capabilities.map(({ id, label, icon: Icon }) => (
          <Tabs.Tab value={id} key={id} className="ot-worker-tab">
            <Icon size={17} /> {label}
          </Tabs.Tab>
        ))}
        <Tabs.Indicator className="ot-worker-indicator" />
      </Tabs.List>
      <div className="ot-worker-stage" ref={stage}>
      {capabilities.map(({ id, heading, description, detail, demo: Demo }) => (
        <Tabs.Panel keepMounted value={id} key={id} data-capability={id} className={`ot-worker-panel ot-worker-panel-${id}`}>
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
      </div>
    </Tabs.Root>
  );
}
