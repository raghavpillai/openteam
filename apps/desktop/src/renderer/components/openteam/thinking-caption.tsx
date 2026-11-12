import { useEffect, useState } from "react";
import { useVisibleNow } from "../../hooks/use-visible-now";
import {
  activityElapsedLabel,
  advanceActivity,
  type HeldActivity,
} from "../../lib/thinking-activity";

export function ThinkingCaption({ text, group = false }: { text: string; group?: boolean }) {
  const [held, setHeld] = useState<HeldActivity>(() => ({
    text,
    since: Date.now(),
    previous: null,
  }));
  const now = useVisibleNow(60_000, !group);
  const hold = group ? 1_200 : 800;
  useEffect(() => {
    if (held.text === text) return;
    const update = () => setHeld((value) => advanceActivity(value, text, Date.now(), hold));
    const remaining = held.since + hold - Date.now();
    if (remaining <= 0) {
      update();
      return;
    }
    const timer = window.setTimeout(update, remaining);
    return () => window.clearTimeout(timer);
  }, [held, hold, text]);
  const elapsed = group ? null : activityElapsedLabel(held.since, now);
  return (
    <span
      className="bot-thinking-label min-w-0 truncate whitespace-nowrap text-[14px] leading-5"
      data-group={group || undefined}
    >
      <span
        className="bot-activity-caption"
        key={held.since}
        data-changed={held.previous !== null || undefined}
      >
        {group && held.previous && (
          <span aria-hidden="true" className="bot-activity-previous">
            {held.previous}
          </span>
        )}
        <span className="bot-activity-current">
          <span className="bot-activity-shimmer">{held.text}</span>
        </span>
      </span>
      {elapsed && <span className="ml-1.5 text-foreground-tertiary">{elapsed}</span>}
    </span>
  );
}
