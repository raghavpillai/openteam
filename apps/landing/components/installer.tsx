"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The installer's stages, typed out once it scrolls into view. Without the
 * motion flag every line is simply shown.
 */
const LINES: Array<{ kind: "cmd" | "ok" | "next"; text: string }> = [
  { kind: "cmd", text: "curl -fsSL https://openteam.so/install | sh" },
  { kind: "ok", text: "Docker and Compose found" },
  { kind: "ok", text: "Downloaded the openteam CLI" },
  { kind: "ok", text: "Generated installation secrets" },
  { kind: "ok", text: "Verified release checksum and signature" },
  { kind: "ok", text: "Pulled server, worker, computer, and database images" },
  { kind: "ok", text: "Started the stack in the background" },
  { kind: "ok", text: "Server is healthy" },
  { kind: "next", text: "Next: create your owner account and sign in to a model" },
];

export function Installer({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(LINES.length);

  useEffect(() => {
    const el = ref.current;
    if (!el || !document.documentElement.hasAttribute("data-motion")) return;
    setShown(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        let i = 0;
        const tick = () => {
          i += 1;
          setShown(i);
          if (i < LINES.length) timer = setTimeout(tick, i === 1 ? 900 : 420);
        };
        timer = setTimeout(tick, 300);
      },
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const done = shown >= LINES.length;
  return (
    <div
      ref={ref}
      role="img"
      aria-label="The installer checking Docker, verifying the release, pulling images, and starting the stack"
      className={cn(
        "overflow-hidden rounded-[14px] bg-[#0f1115] text-left shadow-window",
        className
      )}
    >
      <div className="flex h-9 items-center gap-1.5 border-b border-white/10 px-3.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="ml-2 font-mono text-[11px] text-white/45">Terminal</span>
      </div>
      <ol className="min-h-[236px] space-y-1.5 px-4 py-4 font-mono text-[12.5px] leading-[1.5]">
        {LINES.slice(0, Math.max(shown, 1)).map((line, i) => {
          const typing = i === shown - 1 && !done;
          const cmd = line.kind === "cmd";
          return (
            <li
              key={line.text}
              className={cn(
                "flex items-start gap-2",
                cmd ? "text-white" : line.kind === "next" ? "text-[#8ab4ff]" : "text-white/70",
                i === 0 && shown === 0 && "opacity-0"
              )}
            >
              <span
                className={cn(
                  "w-3.5 shrink-0",
                  cmd ? "text-white/45" : line.kind === "ok" ? "text-[#5fe0a6]" : "text-[#8ab4ff]"
                )}
              >
                {cmd ? "$" : line.kind === "ok" ? "✓" : "→"}
              </span>
              <span className={cn(typing && i === 0 && "caret")}>{line.text}</span>
            </li>
          );
        })}
        {!done && shown > 0 ? (
          <li className="flex items-start gap-2 text-white/40">
            <span className="w-3.5 shrink-0" />
            <span className="caret" />
          </li>
        ) : null}
      </ol>
    </div>
  );
}
