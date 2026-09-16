"use client";

import { Tabs } from "@base-ui/react/tabs";
import { CalendarClock, HardDrive, Monitor } from "lucide-react";
import { ComputerDemo, MemoryDemo, RoutineDemo } from "./app-demo-details";
import { useLayoutEffect, useRef, useState } from "react";

const capabilities = [
  {
    id: "computer",
    label: "Computer",
    icon: Monitor,
    heading: "Watch the screen. Take control when needed.",
    description:
      "Each worker has its own Linux desktop, with a browser and terminal. They share files in one workspace on your server.",
    detail:
      "Watch the live screen, take over to sign in or complete a step, then return control to the worker.",
    demo: ComputerDemo,
  },
  {
    id: "memory",
    label: "Memory",
    icon: HardDrive,
    heading: "Keep your instructions between tasks.",
    description:
      "Workers save notes about your preferences and projects, then reuse them in later conversations. Shared memory keeps the team informed.",
    detail:
      "The notes are Markdown files on your server. Read, correct, or edit them yourself. Try changing this sample file.",
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
];

export function WorkerCapabilities() {
  const [selected, setSelected] = useState("computer");
  const [direction, setDirection] = useState("forward");
  const stage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = stage.current;
    const panel = element?.querySelector<HTMLElement>(`[data-capability="${selected}"]`);
    if (!element || !panel) return;
    const panelHeight = () => {
      const floor = matchMedia("(min-width: 851px)").matches ? 500 : 0;
      return `${Math.max(floor, panel.offsetHeight)}px`;
    };
    // Animate tab changes once. In-panel transitions already animate their own
    // height, so track those directly instead of trailing them with a second ease.
    element.style.transition = "";
    element.style.height = panelHeight();
    const resize = () => {
      const height = panelHeight();
      if (element.style.height === height) return;
      element.style.transition = "none";
      element.style.height = height;
    };
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
