import { BarChart3, ChevronDown, CloudDownload, Copy, Monitor, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

type SettingsView = "general" | "computer" | "usage" | "updates";

const navigation: Array<{
  id: SettingsView;
  label: string;
  icon: typeof Settings;
  available: boolean;
}> = [
  { id: "general", label: "General", icon: Settings, available: true },
  { id: "computer", label: "Computer", icon: Monitor, available: false },
  { id: "usage", label: "Usage & Billing", icon: BarChart3, available: false },
  { id: "updates", label: "Updates", icon: CloudDownload, available: true },
];

function StaticSelect({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] border border-black/[0.055] bg-black/[0.035] px-2 text-[12px] text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.02)] dark:border-white/[0.07] dark:bg-white/[0.07]">
      {children}
      <ChevronDown className="size-3 text-foreground-tertiary" strokeWidth={1.75} />
    </span>
  );
}

function StaticSwitch({ checked = true }: { checked?: boolean }) {
  return (
    <span
      aria-label={checked ? "On" : "Off"}
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 rounded-full",
        checked ? "bg-black dark:bg-white" : "bg-black/15 dark:bg-white/20"
      )}
      role="img"
    >
      <span
        className={cn(
          "absolute top-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.22)] transition-transform dark:bg-[#d9d9d9]",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </span>
  );
}

function SettingsGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[14px] bg-black/[0.045] px-3.5 dark:bg-white/[0.055]",
        className
      )}
    >
      {children}
    </div>
  );
}

function SettingsRow({
  title,
  description,
  control,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center gap-5 border-t border-black/[0.065] py-1.5 first:border-t-0 dark:border-white/[0.07]",
        className
      )}
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-7 px-2 text-[11.5px] font-normal leading-4 text-foreground-tertiary first:mt-0">
      {children}
    </div>
  );
}

function GeneralSettings({ botName }: { botName: string }) {
  return (
    <>
      <SectionLabel>Account</SectionLabel>
      <SettingsGroup className="px-3.5">
        <div className="flex min-h-[72px] items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-black/[0.045] text-[13px] font-medium text-foreground-secondary ring-1 ring-black/[0.035] dark:bg-white/[0.07] dark:ring-white/[0.06]">
            RP
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">Raghav Pillai</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-foreground-secondary">
              <span className="truncate">raghav@zealotlabs.com</span>
              <Copy className="size-3.5 shrink-0" strokeWidth={1.75} />
            </div>
          </div>
          <span className="inline-flex h-8 items-center rounded-full border border-black/[0.04] bg-black/[0.035] px-3.5 text-[12px] dark:border-white/[0.06] dark:bg-white/[0.07]">
            Sign Out
          </span>
        </div>
      </SettingsGroup>

      <SectionLabel>Appearance</SectionLabel>
      <SettingsGroup>
        <SettingsRow control={<StaticSelect>Follow System</StaticSelect>} title="Theme" />
        <SettingsRow control={<StaticSelect>Black</StaticSelect>} title="Accent" />
        <SettingsRow control={<StaticSelect>Follow System</StaticSelect>} title="Language" />
      </SettingsGroup>

      <SectionLabel>System</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          className="min-h-12"
          control={<StaticSelect>System Default</StaticSelect>}
          title="Microphone"
        />
        <SettingsRow
          className="min-h-12"
          control={<StaticSwitch />}
          title="Use hardware acceleration"
        />
      </SettingsGroup>

      <SectionLabel>Bot</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          control={<StaticSelect>Auto-detect (Asia/Jerusalem)</StaticSelect>}
          title="Timezone"
        />
        <SettingsRow
          control={<StaticSelect>Ask every time</StaticSelect>}
          description="Let the assistant open files and run tasks on your computer. Auto-review still checks everything first."
          title="Execution on Local Computer"
        />
        <SettingsRow
          control={<StaticSwitch />}
          description={`${botName} checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically.`}
          title="Auto-review"
        />
        <div className="border-t border-black/[0.065] py-3.5 dark:border-white/[0.07]">
          <div className="text-[13px] leading-[18px]">Auto-review Rules</div>
          <div className="mb-4 text-[12.5px] leading-[17px] text-foreground-secondary">
            Write one short, natural-language rule for each action. “Ask first” takes priority if
            rules conflict.
          </div>
          <label className="block text-[12.5px] leading-[18px]" htmlFor="settings-rule-action">
            When {botName} wants to:
          </label>
          <input
            className="mt-1 h-9 w-full rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-tertiary dark:border-white/[0.1]"
            id="settings-rule-action"
            placeholder="e.g. reply to emails for me"
            readOnly
          />
          <div className="mt-2.5 text-[12.5px] leading-[18px]">It should:</div>
          <div className="mt-1 flex items-center justify-between gap-4">
            <StaticSelect>Allow automatically</StaticSelect>
            <span className="inline-flex h-8 items-center rounded-[9px] bg-black/[0.08] px-3 text-[13px] text-foreground-tertiary dark:bg-white/[0.09]">
              Add Rule
            </span>
          </div>
          <div className="mt-5 text-[12.5px] leading-[17px] text-foreground-secondary">
            These rules apply only to you. Built-in safety checks always apply.
          </div>
        </div>
      </SettingsGroup>

      <SectionLabel>Security Key</SectionLabel>
      <SettingsGroup className="mb-3">
        <SettingsRow
          control={<StaticSwitch />}
          description={`Allow ${botName} to use a security key (such as a YubiKey) connected to your computer. You’ll be asked to approve each use.`}
          title="Use hardware security keys"
        />
      </SettingsGroup>
    </>
  );
}

function UpdatesSettings() {
  return (
    <>
      <SectionLabel>OpenBot Updates</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          control={<StaticSelect>Stable</StaticSelect>}
          description="Stable is the safe default. Other tracks ship new builds earlier and more often. Switching checks for updates right away."
          title="Update Track"
        />
        <SettingsRow
          control={
            <span className="inline-flex h-9 items-center rounded-[9px] bg-black/[0.04] px-3 text-[13px] dark:bg-white/[0.07]">
              Check for Updates
            </span>
          }
          description={
            <>
              Updates follow the Stable track
              <br />
              You’re up to date
            </>
          }
          title="Version 0.1.0"
        />
      </SettingsGroup>

      <SectionLabel>OpenBot&apos;s Computer</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          control={
            <span className="inline-flex h-9 items-center rounded-[9px] bg-black/[0.04] px-3 text-[13px] dark:bg-white/[0.07]">
              Update
            </span>
          }
          description="Updates the computer your assistants share. Your files and logins stay, but installed apps and packages are removed. All assistants update together."
          title="Update OpenBot's Computer"
        />
        <SettingsRow
          control={
            <span className="inline-flex h-9 items-center rounded-[9px] bg-[#ff2d4b] px-3 text-[13px] text-white">
              Reset
            </span>
          }
          description="Start fresh if the computer gets stuck. It’s rebuilt from your last saved snapshot, so very recent changes may be lost."
          title="Reset OpenBot's Computer"
        />
      </SettingsGroup>
    </>
  );
}

export function SettingsPanel({
  botName,
  onOpenChange,
  open,
}: {
  botName: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [view, setView] = useState<SettingsView>("general");

  useEffect(() => {
    if (open) setView("general");
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(700px,calc(100vh-40px))] w-[min(1000px,calc(100vw-40px))] max-w-none grid-cols-[200px_minmax(0,1fr)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-background p-0 shadow-[0_22px_70px_rgba(0,0,0,0.20)] max-sm:grid-cols-[160px_minmax(0,1fr)]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure OpenBot and application updates.
        </DialogDescription>
        <aside className="border-r border-black/[0.07] bg-black/[0.018] px-3 pt-3.5 dark:border-white/[0.07] dark:bg-white/[0.018]">
          <nav aria-label="Settings sections" className="space-y-0.5">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  aria-current={view === item.id ? "page" : undefined}
                  aria-disabled={!item.available}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/35",
                    view === item.id
                      ? "bg-black/[0.1] dark:bg-white/[0.1]"
                      : item.available
                        ? "hover:bg-black/[0.045] dark:hover:bg-white/[0.06]"
                        : "cursor-default"
                  )}
                  key={item.id}
                  onClick={() => item.available && setView(item.id)}
                  type="button"
                >
                  <Icon className="size-[15px] shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="relative min-w-0">
          <DialogClose asChild>
            <button
              aria-label="Close settings"
              className="absolute right-2.5 top-2.5 z-10 grid size-8 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-white/[0.06]"
              type="button"
            >
              <X className="size-4" strokeWidth={1.7} />
            </button>
          </DialogClose>
          <div className="grok-scrollbar h-full overflow-y-auto px-8 pb-8 pt-8 max-sm:px-6">
            <h2 className="mb-7 px-2 text-[17px] font-medium leading-6 tracking-[-0.018em]">
              {view === "updates" ? "Updates" : "General"}
            </h2>
            {view === "updates" ? <UpdatesSettings /> : <GeneralSettings botName={botName} />}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function OpenBotAppIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-[70px] rounded-[18px] shadow-[0_12px_24px_rgba(0,0,0,0.18)]"
      viewBox="0 0 70 70"
    >
      <defs>
        <linearGradient id="openbot-app-icon" x1="13" x2="58" y1="7" y2="66">
          <stop offset="0" stopColor="#f5f5f5" />
          <stop offset="0.5" stopColor="#d9d9d9" />
          <stop offset="1" stopColor="#a7a7a7" />
        </linearGradient>
      </defs>
      <rect fill="url(#openbot-app-icon)" height="70" rx="18" width="70" />
      <circle cx="35" cy="35" fill="#151515" r="19" />
      <circle cx="35" cy="35" fill="#f5f5f5" r="6" />
    </svg>
  );
}

export function AboutPanel({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[294px] w-[390px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-background p-0 shadow-[0_22px_70px_rgba(0,0,0,0.2)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">About OpenBot</DialogTitle>
        <DialogDescription className="sr-only">
          OpenBot version and copyright information.
        </DialogDescription>
        <DialogClose asChild>
          <button
            aria-label="Close About"
            className="absolute right-3.5 top-3.5 z-10 grid size-8 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-white/[0.06]"
            type="button"
          >
            <X className="size-4" strokeWidth={1.7} />
          </button>
        </DialogClose>
        <div className="flex h-full flex-col items-center pt-[34px] text-center">
          <OpenBotAppIcon />
          <h2 className="mt-3.5 text-[23px] font-semibold leading-7 tracking-[-0.025em]">
            OpenBot
          </h2>
          <div className="mt-0.5 text-[12px] leading-4 text-foreground-tertiary">Version 0.1.0</div>
          <div className="mt-3 text-[12px] leading-4 text-foreground-tertiary">
            Copyright © 2026 OpenBot contributors
          </div>
          <span className="mt-8 inline-flex h-9 items-center rounded-[9px] border border-black/[0.055] bg-black/[0.035] px-3 text-[13px] shadow-[0_1px_1px_rgba(0,0,0,0.02)] dark:border-white/[0.07] dark:bg-white/[0.07]">
            Copy version info
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
