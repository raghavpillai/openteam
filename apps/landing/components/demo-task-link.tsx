"use client";

import type { ReactNode } from "react";

export const DEMO_TASK_EVENT = "openteam:demo-task";

export type DemoTask = "research" | "operations" | "engineering";
export type DemoTaskEventDetail = { task: DemoTask };

export function DemoTaskLink({
  task,
  children,
  className,
}: {
  task: DemoTask;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href="#product"
      className={className}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) return;

        window.dispatchEvent(
          new CustomEvent<DemoTaskEventDetail>(DEMO_TASK_EVENT, { detail: { task } }),
        );
      }}
    >
      {children}
    </a>
  );
}
