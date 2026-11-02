import type { SystemActivityView } from "@openteam/contracts";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { isWindowVisible, WINDOW_VISIBILITY_EVENT } from "../../../lib/window-visibility";
import { SettingsGroup } from "./ui";

function ResourceGauge({ label, value }: { label: string; value: number | null }) {
  const percent =
    value === null || !Number.isFinite(value)
      ? null
      : Math.round(Math.max(0, Math.min(100, value)));
  const color =
    percent === null
      ? "text-foreground-tertiary"
      : percent < 70
        ? "text-emerald-600 dark:text-emerald-400"
        : percent < 90
          ? "text-amber-600 dark:text-amber-400"
          : "text-red-600 dark:text-red-400";
  return (
    <div
      className="min-w-0 text-center"
      role="img"
      aria-label={`${label}: ${percent === null ? "unavailable" : `${percent}% used`}`}
    >
      <div className={`mx-auto w-full max-w-[80px] ${color}`}>
        <svg viewBox="0 0 160 112" className="w-full" aria-hidden="true">
          <path
            d="M 22 103 A 64 64 0 1 1 138 103"
            pathLength="100"
            fill="none"
            stroke="currentColor"
            strokeWidth="9"
            className="text-black/[0.07] dark:text-white/[0.09]"
            strokeLinecap="round"
          />
          {percent !== null && percent > 0 && (
            <path
              d="M 22 103 A 64 64 0 1 1 138 103"
              pathLength="100"
              fill="none"
              stroke="currentColor"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={`${percent} 100`}
            />
          )}
          <text
            x="80"
            y="84"
            textAnchor="middle"
            fill="currentColor"
            className="text-[34px] font-semibold tabular-nums"
          >
            {percent === null ? "—" : `${percent}%`}
          </text>
        </svg>
      </div>
      <p className="text-[11px] font-medium">{label}</p>
    </div>
  );
}

export function ServerActivity() {
  const [activity, setActivity] = useState<SystemActivityView | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(isWindowVisible);
  useEffect(() => {
    const update = () => setVisible(isWindowVisible());
    window.addEventListener(WINDOW_VISIBILITY_EVENT, update);
    update();
    return () => window.removeEventListener(WINDOW_VISIBILITY_EVENT, update);
  }, []);
  useEffect(() => {
    if (!visible) return;
    setActivity(null);
    setFailed(false);
    let disposed = false;
    let pending = false;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 4_500);
      try {
        const next = await api.systemActivity(controller.signal);
        if (!disposed) {
          setActivity(next);
          setFailed(false);
        }
      } catch {
        if (!disposed) {
          setActivity(null);
          setFailed(true);
        }
      } finally {
        window.clearTimeout(timeout);
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [visible]);

  return (
    <section aria-label="Live server activity" className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-3 px-2">
        {/* Same style as the other section labels (SectionLabel). */}
        <h3 className="text-[12px] font-normal leading-4 text-foreground-tertiary">Live activity</h3>
        <span
          className="flex items-center gap-1.5 text-[11px] text-foreground-tertiary"
          role="status"
        >
          <span
            className={`size-1.5 rounded-full ${failed || !activity || !visible ? "bg-foreground-tertiary" : "bg-emerald-500"}`}
          />
          {!visible
            ? "Paused"
            : failed
              ? "Unavailable · retrying"
              : activity
                ? "Every 5 seconds"
                : "Connecting…"}
        </span>
      </div>
      <SettingsGroup className="py-2">
        <div className="grid grid-cols-3 gap-3">
          <ResourceGauge label="CPU" value={activity?.cpuPercent ?? null} />
          <ResourceGauge label="RAM" value={activity?.memoryPercent ?? null} />
          <ResourceGauge label="Disk" value={activity?.diskPercent ?? null} />
        </div>
      </SettingsGroup>
      <p className="mt-1.5 px-2 text-[10px] leading-relaxed text-foreground-tertiary">
        Host/VM CPU &amp; RAM · OpenTeam data disk
      </p>
    </section>
  );
}
