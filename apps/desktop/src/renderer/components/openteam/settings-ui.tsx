import type { ReactNode } from "react";
import type { SettingsAnchor } from "../../lib/app-deep-links";
import { cn } from "../../lib/cn";

export function InteractiveSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={checked ? "On" : "Off"}
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
        checked ? "bg-black dark:bg-white" : "bg-black/15 dark:bg-white/20"
      )}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "absolute top-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.22)] transition-transform dark:bg-[#d9d9d9]",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

export function SettingsGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[12px] bg-black/[0.045] px-3.5 dark:bg-[#1b1b1b]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  className,
  anchors,
}: {
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  className?: string;
  anchors?: readonly SettingsAnchor[];
}) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center gap-5 border-t border-black/[0.065] py-1.5 first:border-t-0 dark:border-white/[0.07]",
        className
      )}
      data-settings-anchor={anchors?.join(" ")}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-normal leading-[17px] text-foreground">{title}</div>
        {description ? (
          <div className="mt-px max-w-[640px] text-[12px] leading-4 text-foreground-secondary">
            {description}
          </div>
        ) : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 mt-7 px-2 text-[11.5px] font-normal leading-4 text-foreground-tertiary first:mt-0">
      {children}
    </div>
  );
}
