"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/** Prefetch complete guides and begin page navigation at the article's top. */
export function DocsLink({ href, children, className, onNavigate, "aria-current": current }: {
  href: string;
  children: ReactNode;
  className?: string;
  onNavigate?: () => void;
  "aria-current"?: "page";
}) {
  return (
    <Link
      href={href}
      className={className}
      aria-current={current}
      prefetch={true}
      scroll={false}
      onNavigate={() => {
        window.scrollTo({ top: 0, behavior: "instant" });
        onNavigate?.();
      }}
    >
      {children}
    </Link>
  );
}
