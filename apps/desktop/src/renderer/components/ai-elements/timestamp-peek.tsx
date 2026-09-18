import { useEffect, type ReactNode } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { attachTimestampPeek } from "../../lib/timestamp-peek";

export function ConversationTimestampPeek() {
  const { scrollRef } = useStickToBottomContext();
  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) return attachTimestampPeek(viewport);
  }, [scrollRef]);
  return null;
}

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const accessibleTimeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function TimestampedEntry({ createdAt, from, children }: {
  createdAt?: string;
  from: "user" | "other";
  children: ReactNode;
}) {
  const timestamp = createdAt ? Date.parse(createdAt) : NaN;
  return (
    <div className="timestamp-peek-entry" data-from={from}>
      <div className="timestamp-peek-content">{children}</div>
      {Number.isFinite(timestamp) && (
        <time className="message-timestamp" dateTime={createdAt} aria-label={accessibleTimeFormat.format(timestamp)}>
          {timeFormat.format(timestamp)}
        </time>
      )}
    </div>
  );
}
