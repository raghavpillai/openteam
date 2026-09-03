import type { ClientSnapshot } from "@openteam/contracts";
import { cn } from "../../lib/cn";

export function RuntimeStatus({
  runtime,
  compact = false,
}: {
  runtime: ClientSnapshot["runtime"];
  compact?: boolean;
}) {
  const ready = Object.values(runtime).every((status) => status === "ready");
  const label = runtime.inference === "ready" ? "Pi ready" : `Pi ${runtime.inference}`;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", ready ? "bg-emerald-500" : "bg-amber-500")} />
      {!compact && label}
    </div>
  );
}
