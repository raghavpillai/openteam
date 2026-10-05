import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Retain content through the closing animation, then unmount it as before. */
export function AnimatedCollapse({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  useLayoutEffect(() => {
    if (open || !present) return;
    const transitions = contentRef.current?.getAnimations() ?? [];
    if (!transitions.length) {
      setPresent(false);
      return;
    }
    let cancelled = false;
    void Promise.allSettled(transitions.map((transition) => transition.finished)).then(() => {
      if (!cancelled) setPresent(false);
    });
    return () => { cancelled = true; };
  }, [open, present]);

  return (
    // A zero-height shell lets CSS reverse from the current height on another click.
    <div ref={contentRef} id={id} className="animated-collapse" data-state={open ? "open" : "closed"} inert={!open} aria-hidden={!open}>
      <div className="flow-root">{present ? children : null}</div>
    </div>
  );
}
