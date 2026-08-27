// Source-owned adaptation of the AI Elements tool presentation.
// Upstream: vercel/ai-elements@6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
import { Check, ChevronDown, Circle, LoaderCircle, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { cn } from "../../lib/cn";

export function Tool({
  title,
  kind,
  status,
  content,
}: {
  title?: string | null;
  kind: string;
  status: string;
  content: unknown;
}) {
  const defaultOpen = status === "failed" || status === "waiting_approval";
  const Icon =
    status === "completed"
      ? Check
      : status === "failed" || status === "cancelled"
        ? X
        : status === "running"
          ? LoaderCircle
          : Circle;
  return (
    <Collapsible.Root
      className="group/tool w-full overflow-hidden rounded-xl border bg-card/70 text-xs"
      defaultOpen={defaultOpen}
    >
      <Collapsible.Trigger className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent/60">
        <Icon
          className={cn(
            "size-3.5 text-muted-foreground",
            status === "running" && "animate-spin",
            status === "failed" && "text-red-500",
            status === "completed" && "text-emerald-500"
          )}
        />
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
          {kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {title ?? kind.replaceAll("_", " ")}
        </span>
        <ChevronDown className="size-3.5 transition group-data-[state=open]/tool:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <pre className="max-h-64 overflow-auto border-t bg-muted/45 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap">
          {JSON.stringify(content, null, 2)}
        </pre>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
