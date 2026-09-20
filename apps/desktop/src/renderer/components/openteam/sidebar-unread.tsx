import type { ReactNode } from "react";

/** Grok's normal/pinned markers are 8/10px; their cutout is outside the disc. */
export function SidebarUnreadDot({
  corner = false,
  pinned = false,
}: {
  corner?: boolean;
  pinned?: boolean;
}) {
  return (
    <span
      aria-label="Unread activity"
      className={`sidebar-status-reveal pointer-events-none block shrink-0 rounded-full bg-[#0c64c1] dark:bg-[#459ffe] ${pinned ? "size-2.5" : "size-2"}${corner ? " absolute bottom-0.5 right-0.5 z-20" : ""}`}
      data-unread-indicator="true"
      role="status"
    />
  );
}

export function SidebarUnreadAvatar({
  children,
  unread,
  pinned = false,
}: {
  children: ReactNode;
  unread: boolean;
  pinned?: boolean;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className="inline-flex"
        style={
          unread
            ? {
                // A transparent 2px gap reveals the actual tile background,
                // including its hover/selection transition, in either theme.
                maskImage: pinned
                  ? "radial-gradient(circle at calc(100% - 7px) calc(100% - 7px), transparent 7px, #000 7px)"
                  : "radial-gradient(circle at calc(100% - 6px) calc(100% - 6px), transparent 6px, #000 6px)",
              }
            : undefined
        }
      >
        {children}
      </span>
      {unread ? <SidebarUnreadDot corner pinned={pinned} /> : null}
    </span>
  );
}
