import { SERVER_UPDATE_STEPS, serverUpdateProgress } from "@openteam/contracts/server-updates";
import { Check, LoaderCircle, ShieldCheck, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../../lib/cn";

export function ServerUpdateProgressPanel({
  phase,
  message,
  reconnecting,
  safeToClose,
  startedAt,
  observedAt,
}: {
  phase: string | null;
  message: string | null;
  reconnecting: boolean;
  safeToClose: boolean;
  startedAt: number | null;
  observedAt: number | null;
}) {
  const progress = serverUpdateProgress(phase);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div
      className={cn(
        "mt-3 border-t pt-3",
        progress.rollingBack
          ? "border-amber-500/20"
          : "border-black/[0.07] dark:border-white/[0.09]"
      )}
      data-server-update-progress=""
      aria-live="polite"
    >
      <div className="mb-2.5 flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
        <span
          className={
            progress.rollingBack
              ? "text-amber-600 dark:text-amber-300"
              : "text-blue-600 dark:text-blue-300"
          }
        >
          {progress.rollingBack
            ? "Recovering safely"
            : progress.step === null
              ? "Live progress"
              : `Step ${Math.min(progress.step + 1, 5)} of 5`}
        </span>
        {elapsed === null ? null : (
          <span className="tabular-nums" aria-live="off" aria-label="Time since update started">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} elapsed
          </span>
        )}
      </div>
      <div className="mb-3 flex gap-1" aria-hidden="true">
        {SERVER_UPDATE_STEPS.map((step, index) => (
          <div
            key={step}
            className={cn(
              "h-1 flex-1 rounded-full",
              progress.step !== null && index <= progress.step
                ? "bg-blue-500 dark:bg-blue-400"
                : "bg-black/[0.08] dark:bg-white/10",
              progress.step === index && "animate-pulse motion-reduce:animate-none"
            )}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <LoaderCircle
          className={cn(
            "size-3.5 shrink-0 animate-spin motion-reduce:animate-none",
            progress.rollingBack ? "text-amber-600" : "text-blue-500"
          )}
        />
        {reconnecting ? "Reconnecting to the server…" : progress.title}
      </div>
      {reconnecting || message ? (
        <p className="mt-1 text-[12px] leading-4 text-foreground-secondary">
          {reconnecting ? `Last seen: ${progress.title}` : message}
        </p>
      ) : null}
      {progress.step !== null && !progress.rollingBack ? (
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px]" aria-label="Update stages">
          {SERVER_UPDATE_STEPS.map((title, index) => (
            <li
              key={title}
              aria-current={index === progress.step ? "step" : undefined}
              className={cn(
                "flex items-center gap-1",
                index === progress.step
                  ? "font-medium text-blue-600 dark:text-blue-300"
                  : "text-muted-foreground"
              )}
            >
              {index < (progress.step ?? 0) ? (
                <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <span className="size-1.5 rounded-full bg-current opacity-40" />
              )}
              {title}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
        {reconnecting ? (
          <Wifi className="mt-px size-3 shrink-0" />
        ) : (
          <ShieldCheck className="mt-px size-3 shrink-0" />
        )}
        {reconnecting
          ? `Reconnecting automatically.${observedAt === null ? "" : ` Last checked at ${new Date(observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}`
          : safeToClose
            ? "You can close the app. The update will keep going."
            : "Keep this screen open while the update starts."}
      </p>
    </div>
  );
}
