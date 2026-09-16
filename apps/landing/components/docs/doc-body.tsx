"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/copy-text";

/** Keep the prebuilt article intact and handle its small copy controls in one place. */
export function DocBody({ html }: { html: string }) {
  const timers = useRef(new Map<HTMLButtonElement, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of pending.values()) window.clearTimeout(timer); };
  }, []);

  async function onClick(event: MouseEvent<HTMLDivElement>) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-copy-code]") : null;
    const container = event.currentTarget;
    if (!button || !container.contains(button)) return;
    const code = button.closest(".docs-code")?.querySelector("pre code")?.textContent;
    if (code === undefined || code === null) return;
    try {
      await copyText(code);
      if (!container.isConnected) return;
      window.clearTimeout(timers.current.get(button));
      button.dataset.copied = "true";
      button.setAttribute("aria-label", "Code copied");
      button.title = "Copied";
      toast.success("Code copied");
      timers.current.set(button, window.setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute("aria-label", "Copy code");
        button.title = "Copy code";
        timers.current.delete(button);
      }, 2000));
    } catch {
      toast.error("Couldn't copy code. Please try again.");
    }
  }

  return <div className="docs-prose docs-article-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
