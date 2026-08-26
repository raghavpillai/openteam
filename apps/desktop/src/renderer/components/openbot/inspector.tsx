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
import { BotScreen } from "./bot-screen";

type InspectorMode = "summary" | "settings";

interface ProfileDraft {
  name: string;
  title: string;
  description: string;
  notificationsEnabled: boolean;
}

const draftOf = (bot: BotView): ProfileDraft => ({
  name: bot.name,
  title: bot.title,
  description: bot.description,
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
    async (next: ProfileDraft) => {
      const requestRevision = ++revision.current;
      setSaveState("saving");
      try {
        await onUpdate({
          name: next.name.trim() || "New Bot",
          title: next.title,
          description: next.description,
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
    (next: ProfileDraft, immediate = false) => {
      draftRef.current = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (immediate) void persist(next);
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
    <div className="flex size-full flex-col overflow-y-auto pb-5 pl-[15px] pr-4 pt-[26px]">
      <button className="sr-only" onClick={onBack} type="button">
        Back to bot details
      </button>
      <div className="flex justify-center">
        <BotAvatar bot={bot} size="lg" />
      </div>
      <div className="mt-8 grid gap-2">
        <div className="grid gap-1">
          <Label
            className="pl-2 text-[11px] font-normal text-[#5e5e5e]"
            htmlFor={`settings-name-${bot.id}`}
          >
            Name
          </Label>
          <Input
            className="h-9 rounded-[7px] px-2.5 text-[13px] shadow-none focus-visible:ring-0"
            id={`settings-name-${bot.id}`}
            maxLength={80}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, name: event.target.value })}
            value={draft.name}
          />
        </div>
        <div className="grid gap-1">
          <Label
            className="pl-2 text-[11px] font-normal text-[#5e5e5e]"
            htmlFor={`settings-title-${bot.id}`}
          >
            Title
          </Label>
          <Input
            className="h-9 rounded-[7px] px-2.5 text-[13px] shadow-none focus-visible:ring-0"
            id={`settings-title-${bot.id}`}
            maxLength={120}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, title: event.target.value })}
            placeholder="Describe what your Bot does"
            value={draft.title}
          />
        </div>
        <div className="grid gap-1">
          <Label
            className="pl-2 text-[11px] font-normal text-[#5e5e5e]"
            htmlFor={`settings-description-${bot.id}`}
          >
            Description
          </Label>
          <Textarea
            className="relative -top-px min-h-20 resize-none rounded-[7px] px-2.5 py-2 text-[13px] shadow-none focus-visible:ring-0"
            id={`settings-description-${bot.id}`}
            maxLength={2_000}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, description: event.target.value })}
            placeholder="What this Bot is for"
            value={draft.description}
          />
        </div>
        <div className="mt-[3px] flex h-[76px] items-center gap-3 rounded-xl bg-[#ececec] p-3">
          <div className="relative -top-px left-0.5 min-w-0 flex-1">
            <div className="text-[12px] font-medium">Notifications</div>
            <div className="mt-0.5 text-[11px] leading-[14px] text-[#595959]">
              Get notified when this Bot finishes or needs input
            </div>
          </div>
          <Switch
            aria-label="Bot notifications"
            checked={draft.notificationsEnabled}
            className="-mr-1"
            onCheckedChange={(checked) => queue({ ...draft, notificationsEnabled: checked }, true)}
          />
        </div>
        {saveState === "error" && (
          <p className="text-xs text-destructive">Could not save. Your draft is still here.</p>
        )}
        <div className="h-3 text-center text-[10px] text-[#999]">
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
  mode,
  onModeChange,
  onUpdateBot,
  onRetryBot,
}: {
  channel: ChannelView;
  workspaceRoot: string;
  botById: ReadonlyMap<string, BotView>;
  rounds: ChannelRoundView[];
  active: boolean;
  mode: InspectorMode;
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
      <aside className="size-full border-l bg-background">
        <BotSettings
          bot={bot}
          onBack={() => onModeChange("summary")}
          onUpdate={(input) => onUpdateBot(bot.id, input)}
        />
      </aside>
    );
  }

  return (
    <aside className="flex size-full flex-col border-l bg-background pb-5 pl-[15px] pr-4">
      {bot ? (
        <>
          <BotScreen active={active} bot={bot} onRetry={() => onRetryBot(bot.id)} />
          <div className="mt-2 text-center text-[11px] text-[#5b5b5b]">
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
      <div className="mt-auto pb-[37.4vh] text-center">
        <p className="mx-auto max-w-[220px] text-[12px] leading-4 text-[#5b5b5b]">
          Routines are recurring tasks this Bot runs on a schedule.
        </p>
        <Button
          className="relative top-0.5 mt-3 h-8 w-[117px] rounded-[7px] bg-[#ececec] px-3 text-[14px] font-normal text-[#3d3d3d] disabled:opacity-100"
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
