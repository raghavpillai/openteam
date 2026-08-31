import type { BotView, SubagentActivityView } from "@openbot/contracts";
import { Bot, Clock3, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { asyncTaskElapsed } from "../../lib/async-tasks";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

const PANEL_WIDTH = 336;
const PANEL_HEIGHT = 360;
const PANEL_MARGIN = 16;

type Point = { x: number; y: number };

const initialPosition = (): Point => ({
  x: Math.max(PANEL_MARGIN, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN),
  y: 58,
});

const clampPosition = ({ x, y }: Point): Point => ({
  x: Math.min(
    Math.max(PANEL_MARGIN, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN),
    Math.max(PANEL_MARGIN, x)
  ),
  y: Math.min(
    Math.max(PANEL_MARGIN, window.innerHeight - PANEL_HEIGHT - PANEL_MARGIN),
    Math.max(PANEL_MARGIN, y)
  ),
});

const taskStartedAt = (task: SubagentActivityView) => task.startedAt ?? task.createdAt;

export function AsyncTasksPanel({
  bot,
  tasks,
  onClose,
}: {
  bot: BotView;
  tasks: readonly SubagentActivityView[];
  onClose: () => void;
}) {
  const [position, setPosition] = useState(initialPosition);
  const [nowMs, setNowMs] = useState(Date.now);
  const dragRef = useRef<{
    pointerId: number;
    origin: Point;
    start: Point;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onClose();
    };
    const onResize = () => setPosition((current) => clampPosition(current));
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  return (
    <aside
      aria-label={`Async tasks: ${bot.name}`}
      className="electron-no-drag fixed z-[80] flex h-[360px] w-[336px] flex-col overflow-hidden rounded-[18px] border border-border/80 bg-popover text-popover-foreground shadow-[0_20px_60px_rgba(0,0,0,0.24),0_2px_12px_rgba(0,0,0,0.08)]"
      data-async-tasks-panel=""
      role="dialog"
      style={{ left: position.x, top: position.y }}
    >
      <header
        className="flex h-[58px] shrink-0 touch-none cursor-grab items-center gap-2 border-b border-border/70 px-3 active:cursor-grabbing"
        data-async-tasks-drag-handle=""
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            origin: { x: event.clientX, y: event.clientY },
            start: position,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setPosition(
            clampPosition({
              x: drag.start.x + event.clientX - drag.origin.x,
              y: drag.start.y + event.clientY - drag.origin.y,
            })
          );
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      >
        <Clock3 aria-hidden="true" className="size-4 shrink-0 text-foreground-secondary" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[13px] font-medium">Async tasks</div>
          <div className="truncate text-[11px] text-foreground-secondary">{bot.name}</div>
        </div>
        <Button
          aria-label="Close async tasks"
          className="size-7 rounded-full"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          size="icon-sm"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="grok-scrollbar min-h-0 flex-1 overflow-y-auto p-2" role="list">
        {tasks.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-[13px] text-foreground-tertiary">
            No async tasks in progress.
          </div>
        ) : (
          tasks.map((task) => (
            <div
              className="flex min-h-[58px] items-center gap-2.5 rounded-[11px] px-2.5 py-2"
              data-async-task-id={task.subagentId}
              data-kind="subagent"
              key={task.subagentId}
              role="listitem"
              title={`${task.subagentId} · started ${new Date(taskStartedAt(task)).toLocaleString()}`}
            >
              <span
                aria-label="Running"
                className={cn(
                  "size-2 shrink-0 rounded-full bg-emerald-500",
                  task.status !== "queued" &&
                    task.status !== "provisioning" &&
                    "motion-safe:animate-pulse"
                )}
                role="status"
              />
              <Bot aria-hidden="true" className="size-4 shrink-0 text-foreground-secondary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {task.description || "Background task"}
                </span>
                <span className="block truncate text-[11px] text-foreground-secondary">
                  Subagent · {task.subagentType}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-foreground-tertiary">
                {asyncTaskElapsed(task, nowMs)}
              </span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
