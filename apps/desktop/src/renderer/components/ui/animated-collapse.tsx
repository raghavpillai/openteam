import { Collapsible } from "radix-ui";
import type { ReactNode } from "react";

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
  return (
    <Collapsible.Root open={open} asChild>
      <div className="contents">
        <Collapsible.Content id={id} className="animated-collapse" inert={!open} aria-hidden={!open}>
          <div className="flow-root">{children}</div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}
