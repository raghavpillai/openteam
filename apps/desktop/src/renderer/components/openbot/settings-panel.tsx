import {
  BarChart3,
  ChevronDown,
  CloudDownload,
  Copy,
  Monitor,
  Pencil,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type SettingsAnchor,
  type SettingsView,
  settingsViewForAnchor,
} from "../../lib/app-deep-links";
import { cn } from "../../lib/cn";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const navigation: Array<{
  id: SettingsView;
  label: string;
  icon: typeof Settings;
  available: boolean;
}> = [
  { id: "general", label: "General", icon: Settings, available: true },
  { id: "computer", label: "Computer", icon: Monitor, available: true },
  { id: "usage", label: "Usage & Billing", icon: BarChart3, available: true },
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

function InteractiveSwitch({
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

function SettingsGroup({ children, className }: { children: React.ReactNode; className?: string }) {
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

function SettingsRow({
  title,
  description,
  control,
  className,
  anchors,
}: {
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-7 px-2 text-[11.5px] font-normal leading-4 text-foreground-tertiary first:mt-0">
      {children}
    </div>
  );
}

function GeneralSettings() {
  const [permissions, setPermissions] = useState<OpenBotPermissionSettings | null>(null);
  const [ruleKind, setRuleKind] = useState<"allow" | "block">("allow");
  const [rule, setRule] = useState("");
  const [editingRule, setEditingRule] = useState<{
    kind: "allow" | "block";
    instruction: string;
  } | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.openbot?.permissions
      .get()
      .then((value) => active && setPermissions(value))
      .catch((error) => active && setPermissionError(String(error)));
    return () => {
      active = false;
    };
  }, []);

  const updatePermissions = (request: {
    localToolPermission?: OpenBotPermissionSettings["localToolPermission"];
    autoReviewEnabled?: boolean;
  }) => {
    setPermissionError(null);
    void window.openbot?.permissions
      .update(request)
      .then(setPermissions)
      .catch((error) => setPermissionError(String(error)));
  };

  const addRule = () => {
    const instruction = rule.trim();
    if (!instruction) return;
    if (editingRule?.kind === ruleKind && editingRule.instruction === instruction) {
      setEditingRule(null);
      setRule("");
      return;
    }
    setPermissionError(null);
    void (async () => {
      if (!window.openbot) throw new Error("OpenBot permission settings are unavailable");
      let value = await window.openbot.permissions.addRule({
        kind: ruleKind,
        instruction,
      });
      if (editingRule) {
        value = await window.openbot.permissions.removeRule(editingRule);
      }
      return value;
    })()
      .then((value) => {
        setPermissions(value);
        setEditingRule(null);
        setRule("");
      })
      .catch((error) => setPermissionError(String(error)));
  };

  const removeRule = (kind: "allow" | "block", instruction: string) => {
    setPermissionError(null);
    if (editingRule?.kind === kind && editingRule.instruction === instruction) {
      setEditingRule(null);
      setRule("");
    }
    void window.openbot?.permissions
      .removeRule({ kind, instruction })
      .then(setPermissions)
      .catch((error) => setPermissionError(String(error)));
  };

  const editRule = (kind: "allow" | "block", instruction: string) => {
    setEditingRule({ kind, instruction });
    setRuleKind(kind);
    setRule(instruction);
  };

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
        <SettingsRow
          anchors={["theme"]}
          control={<StaticSelect>Follow System</StaticSelect>}
          title="Theme"
        />
        <SettingsRow
          anchors={["language"]}
          control={<StaticSelect>Follow System</StaticSelect>}
          title="Language"
        />
      </SettingsGroup>

      <SectionLabel>System</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["microphone"]}
          className="min-h-12"
          control={<StaticSelect>System Default</StaticSelect>}
          title="Microphone"
        />
        <SettingsRow
          anchors={["hardware-acceleration", "hardware-acceleration-restart"]}
          className="min-h-12"
          control={<StaticSwitch />}
          title="Use hardware acceleration"
        />
      </SettingsGroup>

      <SectionLabel>Bot</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["timezone"]}
          control={<StaticSelect>Auto-detect (Asia/Jerusalem)</StaticSelect>}
          title="Timezone"
        />
        <SettingsRow
          anchors={["auto-review"]}
          control={
            <InteractiveSwitch
              checked={permissions?.autoReview.isEnabled ?? true}
              disabled={!permissions}
              onChange={(autoReviewEnabled) => updatePermissions({ autoReviewEnabled })}
            />
          }
          description="OpenBot checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically."
          title="Auto-review"
        />
        <div className="border-t border-black/[0.065] py-3.5 dark:border-white/[0.07]">
          <div className="text-[13px] leading-[18px]">Auto-review Rules</div>
          <div className="mb-4 text-[12.5px] leading-[17px] text-foreground-secondary">
            Write one short, natural-language rule for each action. "Ask first" takes priority if
            rules conflict.
          </div>
          <label className="block text-[12.5px] leading-[18px]" htmlFor="settings-rule-action">
            When OpenBot wants to:
          </label>
          <input
            className="mt-1 h-9 w-full rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-tertiary dark:border-white/[0.1]"
            id="settings-rule-action"
            placeholder="e.g. reply to emails for me"
            maxLength={1000}
            onChange={(event) => setRule(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addRule();
            }}
            value={rule}
          />
          <div className="mt-2.5 text-[12.5px] leading-[18px]">It should:</div>
          <div className="mt-1 flex items-center justify-between gap-4">
            <Select
              onValueChange={(value) => setRuleKind(value as "allow" | "block")}
              value={ruleKind}
            >
              <SelectTrigger
                aria-label="Rule behavior"
                className="h-8 rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Allow automatically</SelectItem>
                <SelectItem value="block">Ask first</SelectItem>
              </SelectContent>
            </Select>
            <button
              className="inline-flex h-8 items-center rounded-[9px] bg-black/[0.08] px-3 text-[13px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]"
              disabled={!permissions || !rule.trim()}
              onClick={addRule}
              type="button"
            >
              Add rule
            </button>
          </div>
          {permissions &&
          permissions.autoReview.allowInstructions.length +
            permissions.autoReview.blockInstructions.length >
            0 ? (
            <div
              aria-label="Auto-review rules"
              className="mt-4 overflow-hidden rounded-[8px] border border-black/[0.07] bg-background/55 dark:border-white/[0.075]"
              role="table"
            >
              <div
                className="grid grid-cols-[minmax(0,1fr)_112px_58px] px-2.5 py-1.5 text-[10.5px] text-foreground-tertiary"
                role="row"
              >
                <span role="columnheader">Action</span>
                <span role="columnheader">Behavior</span>
                <span aria-hidden="true" />
              </div>
              {[
                ...permissions.autoReview.blockInstructions.map((instruction) => ({
                  kind: "block" as const,
                  instruction,
                })),
                ...permissions.autoReview.allowInstructions.map((instruction) => ({
                  kind: "allow" as const,
                  instruction,
                })),
              ].map(({ instruction, kind }, index) => (
                <div
                  className="grid min-h-9 grid-cols-[minmax(0,1fr)_112px_58px] items-center gap-1 border-t border-black/[0.065] px-2.5 py-1.5 text-[12px] dark:border-white/[0.07]"
                  key={`${kind}:${instruction}`}
                  role="row"
                >
                  <span className="min-w-0 break-words pr-2" role="cell">
                    {instruction}
                  </span>
                  <span className="text-foreground-secondary" role="cell">
                    {kind === "block" ? "Ask first" : "Allow automatically"}
                  </span>
                  <span className="flex justify-end gap-0.5" role="cell">
                    <button
                      aria-label={`Edit rule ${index + 1}`}
                      className="grid size-6 place-items-center rounded-[6px] text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                      onClick={() => editRule(kind, instruction)}
                      type="button"
                    >
                      <Pencil className="size-3" strokeWidth={1.8} />
                    </button>
                    <button
                      aria-label={`Delete rule ${index + 1}`}
                      className="grid size-6 place-items-center rounded-[6px] text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                      onClick={() => removeRule(kind, instruction)}
                      type="button"
                    >
                      <Trash2 className="size-3" strokeWidth={1.8} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {permissionError ? (
            <div className="mt-3 text-[12px] text-red-600 dark:text-red-400">{permissionError}</div>
          ) : null}
          <div className="mt-5 text-[12.5px] leading-[17px] text-foreground-secondary">
            These rules apply only to you. Built-in safety checks always apply.
          </div>
        </div>
      </SettingsGroup>

      <SectionLabel>Security Key</SectionLabel>
      <SettingsGroup className="mb-3">
        <SettingsRow
          anchors={["security-keys"]}
          control={<StaticSwitch />}
          description="Allow OpenBot to use a security key (such as a YubiKey) connected to your computer. You’ll be asked to approve each use."
          title="Use hardware security keys"
        />
      </SettingsGroup>
    </>
  );
}

function ComputerSettings() {
  const [permissions, setPermissions] = useState<OpenBotPermissionSettings | null>(null);
  const [machineLabel, setMachineLabel] = useState("");
  const [permissionError, setPermissionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.openbot?.permissions
      .get()
      .then((value) => {
        if (!active) return;
        setPermissions(value);
        setMachineLabel(value.machine.label);
      })
      .catch((error) => active && setPermissionError(String(error)));
    return () => {
      active = false;
    };
  }, []);

  const updatePermission = (
    localToolPermission: OpenBotPermissionSettings["localToolPermission"]
  ) => {
    setPermissionError(null);
    void window.openbot?.permissions
      .update({ localToolPermission })
      .then(setPermissions)
      .catch((error) => setPermissionError(String(error)));
  };

  const saveMachineLabel = () => {
    const label = machineLabel.trim();
    if (!permissions || !label || label === permissions.machine.label) return;
    setPermissionError(null);
    void window.openbot?.permissions
      .update({ machineLabel: label })
      .then((value) => {
        setPermissions(value);
        setMachineLabel(value.machine.label);
      })
      .catch((error) => setPermissionError(String(error)));
  };

  return (
    <>
      <SectionLabel>Computers</SectionLabel>
      <SettingsGroup>
        <div
          className="flex min-h-[52px] items-center gap-5 py-1.5"
          data-settings-anchor="computers"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-[17px] text-foreground">Current computer</div>
            <div className="mt-px text-[12px] leading-4 text-foreground-secondary">
              This is the computer you are using now
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <input
              aria-label="Computer label"
              className="h-8 w-[184px] rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/[0.1]"
              maxLength={80}
              onChange={(event) => setMachineLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveMachineLabel();
              }}
              value={machineLabel}
            />
            <button
              className="inline-flex h-8 items-center rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]"
              disabled={
                !permissions ||
                !machineLabel.trim() ||
                machineLabel.trim() === permissions.machine.label
              }
              onClick={saveMachineLabel}
              type="button"
            >
              Save
            </button>
          </div>
        </div>
        <SettingsRow
          anchors={["local-execution"]}
          control={
            <Select
              disabled={!permissions}
              onValueChange={(value) =>
                updatePermission(value as OpenBotPermissionSettings["localToolPermission"])
              }
              value={permissions?.localToolPermission ?? "ask"}
            >
              <SelectTrigger
                aria-label="Execution on this computer"
                className="h-7 rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask every time</SelectItem>
                <SelectItem value="always">Always allow</SelectItem>
                <SelectItem value="never">Never allow</SelectItem>
              </SelectContent>
            </Select>
          }
          description="Let OpenBot open files and run tasks on your computer. Auto-review still checks everything first."
          title="Execution on this computer"
        />
      </SettingsGroup>
      {permissionError ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400">
          {permissionError}
        </div>
      ) : null}
    </>
  );
}

function UsageSettings() {
  return (
    <>
      <SectionLabel>Usage</SectionLabel>
      <SettingsGroup className="px-3.5 py-3">
        <div data-settings-anchor="plan cancel-trial">
          <div className="flex items-center justify-between text-[12.5px] leading-[17px]">
            <span>Weekly usage</span>
            <span className="text-foreground-secondary">—</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/[0.1] dark:bg-white/[0.12]">
            <div className="h-full w-0 rounded-full bg-blue-500" />
          </div>
          <div className="mt-2 text-[11.5px] text-foreground-secondary">
            Not metered by self-hosted OpenBot
          </div>
        </div>
        <div className="mt-3 border-t border-black/[0.065] pt-3 dark:border-white/[0.07]">
          <div className="flex items-center justify-between text-[12.5px] leading-[17px]">
            <span>On-demand usage</span>
            <span className="text-foreground-secondary">Provider managed</span>
          </div>
          <div className="mt-1 text-[11.5px] text-foreground-secondary">
            Billed by the model provider configured for this deployment
          </div>
        </div>
      </SettingsGroup>

      <SectionLabel>On-Demand</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["on-demand", "egress"]}
          control={
            <span className="inline-flex h-7 items-center rounded-full bg-black/[0.055] px-3 text-[11.5px] dark:bg-[#2f2f2f]">
              Provider managed
            </span>
          }
          description="Model, storage, and network charges are managed by your configured providers."
          title="On-Demand"
        />
      </SettingsGroup>

      <SectionLabel>Manage Plan</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          control={
            <span className="inline-flex h-7 items-center rounded-full bg-black px-3 text-[11.5px] font-medium text-white dark:bg-white dark:text-black">
              Self-hosted
            </span>
          }
          description="OpenBot does not meter a separate hosted plan."
          title="OpenBot Plan"
        />
      </SettingsGroup>
    </>
  );
}

function UpdatesSettings() {
  const [update, setUpdate] = useState<OpenBotUpdateStatus | null>(null);

  useEffect(() => {
    let active = true;
    window.openbot?.updates
      .status()
      .then((value) => active && setUpdate(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const check = () => {
    setUpdate((current) => (current ? { ...current, status: "checking", message: null } : current));
    void window.openbot?.updates.check().then(setUpdate);
  };

  return (
    <>
      <SectionLabel>OpenBot Updates</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["update-channel"]}
          control={<StaticSelect>Stable</StaticSelect>}
          description="Stable is the safe default. Other tracks ship new builds earlier and more often. Switching checks for updates right away."
          title="Update Track"
        />
        <SettingsRow
          anchors={["update-status", "automatic-updates"]}
          control={
            update?.status === "available" ? (
              <button
                className="inline-flex h-9 items-center rounded-[9px] bg-black px-3 text-[13px] text-white hover:opacity-80 dark:bg-white dark:text-black"
                onClick={() => void window.openbot?.updates.openDownload()}
                type="button"
              >
                Download {update.latestVersion}
              </button>
            ) : (
              <button
                className="inline-flex h-9 items-center rounded-[9px] bg-black/[0.04] px-3 text-[13px] hover:bg-black/[0.07] disabled:opacity-50 dark:bg-white/[0.07] dark:hover:bg-white/[0.1]"
                disabled={update?.status === "checking"}
                onClick={check}
                type="button"
              >
                {update?.status === "checking" ? "Checking…" : "Check for Updates"}
              </button>
            )
          }
          description={
            <>
              Updates follow the Stable track
              <br />
              {update?.status === "available"
                ? `Version ${update.latestVersion} is available`
                : update?.status === "error"
                  ? update.message
                  : (update?.message ?? "You’re up to date")}
            </>
          }
          title={`Version ${update?.currentVersion ?? "0.1.0"}`}
        />
      </SettingsGroup>

      <SectionLabel>OpenBot&apos;s Computer</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["update-computer"]}
          control={
            <span className="inline-flex h-9 items-center rounded-[9px] bg-black/[0.04] px-3 text-[13px] dark:bg-white/[0.07]">
              Update
            </span>
          }
          description="Updates the computer your assistants share. Your files and logins stay, but installed apps and packages are removed. All assistants update together."
          title="Update OpenBot's Computer"
        />
        <SettingsRow
          anchors={["reset-computer"]}
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
  onOpenChange,
  open,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: { anchor: SettingsAnchor; nonce: number } | null;
}) {
  const [view, setView] = useState<SettingsView>("general");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !target) setView("general");
  }, [open, target]);

  useEffect(() => {
    if (!open || !target) return;
    const nextView = settingsViewForAnchor(target.anchor);
    setView(nextView);
    const frame = window.requestAnimationFrame(() => {
      const row = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>("[data-settings-anchor]") ?? []
      ).find((candidate) => candidate.dataset.settingsAnchor?.split(" ").includes(target.anchor));
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.classList.remove("settings-anchor-target");
      window.requestAnimationFrame(() => row.classList.add("settings-anchor-target"));
      window.setTimeout(() => row.classList.remove("settings-anchor-target"), 1_800);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, target]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(700px,calc(100vh-96px))] w-[min(1000px,calc(100vw-40px))] max-w-none grid-cols-[198px_minmax(0,1fr)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-[#fcfcfc] p-0 shadow-[0_22px_70px_rgba(0,0,0,0.20)] dark:border-[#303030] dark:bg-[#070707] max-sm:grid-cols-[160px_minmax(0,1fr)]"
        showCloseButton={false}
        surface="transparent"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure OpenBot and application updates.
        </DialogDescription>
        <aside className="border-r-[0.5px] border-black/[0.07] bg-[#f7f7f7] px-3 pb-4 pt-4 dark:border-white/[0.07] dark:bg-[#111111]">
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
          <div
            className="grok-scrollbar h-full overflow-y-auto px-8 pb-8 pt-8 max-sm:px-6"
            ref={scrollRef}
          >
            <h2 className="mb-7 px-2 text-[17px] font-medium leading-6 tracking-[-0.018em]">
              {view === "updates"
                ? "Updates"
                : view === "computer"
                  ? "Computer"
                  : view === "usage"
                    ? "Usage & Billing"
                    : "General"}
            </h2>
            {view === "updates" ? (
              <UpdatesSettings />
            ) : view === "computer" ? (
              <ComputerSettings />
            ) : view === "usage" ? (
              <UsageSettings />
            ) : (
              <GeneralSettings />
            )}
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
      className="size-16 rounded-[16px] shadow-[0_12px_24px_rgba(0,0,0,0.18)]"
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
  const version = window.openbot?.versions.app ?? "0.1.0";
  const copyVersion = () =>
    void navigator.clipboard?.writeText(
      `OpenBot ${version}\nElectron ${window.openbot?.versions.electron ?? "unknown"}\nChrome ${window.openbot?.versions.chrome ?? "unknown"}`
    );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[272px] w-[360px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-background p-0 shadow-[0_22px_70px_rgba(0,0,0,0.2)]"
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
          <h2 className="mt-3 text-[20px] font-semibold leading-6 tracking-[-0.02em]">OpenBot</h2>
          <div className="mt-0.5 text-[12px] leading-4 text-foreground-tertiary">
            Version {version}
          </div>
          <div className="mt-3 text-[12px] leading-4 text-foreground-tertiary">
            Copyright © 2026 OpenBot contributors
          </div>
          <button
            className="mt-6 inline-flex h-8 items-center rounded-[8px] border border-black/[0.055] bg-black/[0.035] px-3 text-[12px] shadow-[0_1px_1px_rgba(0,0,0,0.02)] hover:bg-black/[0.06] dark:border-white/[0.07] dark:bg-white/[0.07] dark:hover:bg-white/[0.1]"
            onClick={copyVersion}
            type="button"
          >
            Copy version info
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
