import type { BotView, ChannelRoundView, ChannelView, UpdateBotInput } from "@openbot/contracts";
import { FolderOpen } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Progress } from "../ui/progress";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { BotAvatar } from "./avatar";
import { AvatarPicker } from "./avatar-picker";
import { BotScreen } from "./bot-screen";

type InspectorMode = "summary" | "settings";

interface ProfileDraft {
  name: string;
  title: string;
  description: string;
  icon: string;
  color: string;
  notificationsEnabled: boolean;
}

const draftOf = (bot: BotView): ProfileDraft => ({
  name: bot.name,
  title: bot.title,
  description: bot.description,
  icon: bot.icon,
  color: bot.color,
  notificationsEnabled: bot.notificationsEnabled,
});

function BotSettings({
  bot,
  onBack,
  onUpdate,
}: {
  bot: BotView;
  onBack: () => void;
  onUpdate: (input: UpdateBotInput) => Promise<BotView>;
}) {
  const [draft, setDraft] = useState(() => draftOf(bot));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const draftRef = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);

  const persist = useCallback(
    async (next: ProfileDraft, includeAvatar = false) => {
      const requestRevision = ++revision.current;
      setSaveState("saving");
      try {
        await onUpdate({
          name: next.name.trim() || "New Bot",
          title: next.title,
          description: next.description,
          ...(includeAvatar ? { icon: next.icon, color: next.color } : {}),
          notificationsEnabled: next.notificationsEnabled,
        });
        if (requestRevision === revision.current) setSaveState("saved");
      } catch {
        if (requestRevision === revision.current) setSaveState("error");
      }
    },
    [onUpdate]
  );

  const queue = useCallback(
    (next: ProfileDraft, immediate = false, includeAvatar = false) => {
      draftRef.current = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (immediate) void persist(next, includeAvatar);
      else timer.current = setTimeout(() => void persist(draftRef.current), 400);
    },
    [persist]
  );

  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    void persist(draftRef.current);
  };

  return (
    <div className="flex size-full flex-col overflow-y-auto px-4 pb-5 pt-[70px]">
      <button className="sr-only" onClick={onBack} type="button">
        Back to bot details
      </button>
      <div className="flex justify-center">
        <AvatarPicker
          botId={bot.id}
          color={draft.color}
          icon={draft.icon}
          onChange={(next) => queue({ ...draft, ...next }, true, true)}
        />
      </div>
      <div className="mt-8 grid gap-2">
        <div className="grid gap-[2px]">
          <Label
            className="pl-2 text-[12px] font-normal leading-[18px] text-muted-foreground"
            htmlFor={`settings-name-${bot.id}`}
          >
            Name
          </Label>
          <Input
            className="h-9 rounded-[7px] border-[#d9d9d9] px-2.5 text-[14px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id={`settings-name-${bot.id}`}
            maxLength={80}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, name: event.target.value })}
            value={draft.name}
          />
        </div>
        <div className="grid gap-[2px]">
          <Label
            className="pl-2 text-[12px] font-normal leading-[18px] text-muted-foreground"
            htmlFor={`settings-title-${bot.id}`}
          >
            Label (optional)
          </Label>
          <Input
            className="h-9 rounded-[7px] border-[#d9d9d9] px-2.5 text-[14px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id={`settings-title-${bot.id}`}
            maxLength={120}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, title: event.target.value })}
            placeholder="Research, marketing, admin"
            value={draft.title}
          />
        </div>
        <div className="grid gap-[2px]">
          <Label
            className="pl-2 text-[12px] font-normal leading-[18px] text-muted-foreground"
            htmlFor={`settings-description-${bot.id}`}
          >
            Description
          </Label>
          <Textarea
            className="min-h-20 resize-none rounded-[7px] border-[#d9d9d9] px-2.5 py-2 text-[14px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id={`settings-description-${bot.id}`}
            maxLength={2_000}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, description: event.target.value })}
            placeholder="What this Bot is for"
            value={draft.description}
          />
        </div>
        <div className="mt-1 flex h-[76px] items-center gap-3 rounded-xl bg-[#f0f0f0] p-3 dark:bg-[#181818]">
          <div className="relative left-0.5 min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-[18px]">Notifications</div>
            <div className="mt-0.5 text-[12px] leading-[15px] text-foreground-secondary">
              Get notified when this Bot finishes or needs input
            </div>
          </div>
          <Switch
            aria-label="Bot notifications"
            checked={draft.notificationsEnabled}
            className="-mr-1 data-[state=checked]:bg-[#070707] dark:data-[state=checked]:bg-[#626262]"
            onCheckedChange={(checked) => queue({ ...draft, notificationsEnabled: checked }, true)}
          />
        </div>
        {saveState === "error" && (
          <p className="text-xs text-destructive">Could not save. Your draft is still here.</p>
        )}
        <div className="h-3 text-center text-[10px] text-muted-foreground">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
        </div>
      </div>
    </div>
  );
}

export const Inspector = memo(function Inspector({
  channel,
  workspaceRoot,
  botById,
  rounds,
  active,
  screenEnabled,
  mode,
  onEnableScreen,
  onModeChange,
  onUpdateBot,
  onRetryBot,
}: {
  channel: ChannelView;
  workspaceRoot: string;
  botById: ReadonlyMap<string, BotView>;
  rounds: ChannelRoundView[];
  active: boolean;
  screenEnabled: boolean;
  mode: InspectorMode;
  onEnableScreen: (botId: string) => void;
  onModeChange: (mode: InspectorMode) => void;
  onUpdateBot: (botId: string, input: UpdateBotInput) => Promise<BotView>;
  onRetryBot: (botId: string) => Promise<void>;
}) {
  const members = useMemo(
    () =>
      channel.members
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((member) => botById.get(member.botId))
        .filter((bot): bot is BotView => Boolean(bot)),
    [botById, channel.members]
  );
  const bot = channel.kind === "bot_dm" ? members[0] : undefined;
  const latestRound = rounds.at(-1);
  const progress = latestRound
    ? latestRound.status === "completed"
      ? 100
      : ((latestRound.currentOrdinal + 1) / Math.max(1, members.length)) * 100
    : 0;

  if (bot && mode === "settings") {
    return (
      <aside className="size-full bg-background">
        <BotSettings
          bot={bot}
          onBack={() => onModeChange("summary")}
          onUpdate={(input) => onUpdateBot(bot.id, input)}
        />
      </aside>
    );
  }

  return (
    <aside className="flex size-full flex-col bg-background px-4 pb-5 pt-[41px]">
      {bot ? (
        <>
          <BotScreen
            active={active}
            bot={bot}
            enabled={screenEnabled}
            onEnable={() => onEnableScreen(bot.id)}
            onRetry={() => onRetryBot(bot.id)}
          />
          <div className="mt-2 text-center text-[12px] leading-4 text-muted-foreground">
            {bot.status === "provisioning"
              ? `Starting ${bot.name}'s screen…`
              : `${bot.name}'s screen`}
          </div>
        </>
      ) : (
        <>
          <div className="text-sm font-medium">Members</div>
          <div className="mt-3 space-y-2">
            {members.map((member, index) => (
              <div className="flex items-center gap-3 rounded-xl px-2 py-2" key={member.id}>
                <BotAvatar bot={member} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.name}</span>
                <Badge variant="secondary">#{index + 1}</Badge>
              </div>
            ))}
          </div>
          {channel.workingDirectory && (
            <div className="mt-5 rounded-xl border px-3 py-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                <FolderOpen className="size-3.5" /> Shared project
              </div>
              <div className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                {channel.workingDirectory}
              </div>
            </div>
          )}
          {latestRound && (
            <div className="mt-4 rounded-xl border p-3 text-xs">
              <div className="mb-2 flex justify-between">
                <span className="text-muted-foreground">Latest round</span>
                <span className="capitalize">{latestRound.status}</span>
              </div>
              <Progress value={progress} />
            </div>
          )}
        </>
      )}
      <div className="mt-auto pb-[38vh] text-center">
        <p className="mx-auto max-w-[220px] text-[13px] leading-[17px] text-muted-foreground">
          Routines are recurring tasks this Bot runs on a schedule.
        </p>
        <Button
          className="relative top-0.5 mt-3 h-8 w-[117px] rounded-[7px] border border-[#d9d9d9] bg-[#f0f0f0] px-3 text-[14px] font-normal text-foreground shadow-none disabled:opacity-100 dark:border-[#393939] dark:bg-[#282828] dark:text-[#eeeeee]"
          disabled
          variant="secondary"
        >
          Create Routine
        </Button>
      </div>
      <div className="sr-only">Workspace root: {workspaceRoot}</div>
    </aside>
  );
});
