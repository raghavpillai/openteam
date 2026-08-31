import type { BotView, ChannelView, UpdateBotInput } from "@openbot/contracts";
import { Plus, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOT_TEMPLATE_SHARING_ENABLED } from "../../lib/bot-template";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { BotAvatar } from "./avatar";
import { AvatarPicker } from "./avatar-picker";
import { BotScreen } from "./bot-screen";
import { BotTemplateSettingsFooter } from "./bot-template-share";
import { GroupAvatarEditor } from "./group-avatar-editor";
import { RoutineEditor, RoutinesSummary } from "./routine-panel";

type InspectorMode = "summary" | "settings" | "routine";

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
  onShareAsTemplate,
  onUpdate,
}: {
  bot: BotView;
  onBack: () => void;
  onShareAsTemplate: () => void;
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
    <div className="flex size-full flex-col overflow-y-auto px-4 pb-3 pt-[70px]">
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
      </div>
      {BOT_TEMPLATE_SHARING_ENABLED && (
        <div className="mt-auto pt-6">
          <BotTemplateSettingsFooter bot={bot} onShare={onShareAsTemplate} />
        </div>
      )}
    </div>
  );
}

function GroupSettings({
  botById,
  channel,
  onBack,
  onSetAvatar,
  onUpdate,
}: {
  botById: ReadonlyMap<string, BotView>;
  channel: ChannelView;
  onBack: () => void;
  onSetAvatar: (pngBase64: string | null) => Promise<void>;
  onUpdate: (name: string, description: string) => Promise<ChannelView>;
}) {
  const [draft, setDraft] = useState(() => ({
    name: channel.name,
    description: channel.description,
  }));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const draftRef = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    const next = { name: channel.name, description: channel.description };
    draftRef.current = next;
    setDraft(next);
    setSaveState("idle");
  }, [channel.name, channel.description]);

  const persist = useCallback(
    async (next: typeof draft) => {
      const requestRevision = ++revision.current;
      setSaveState("saving");
      try {
        await onUpdate(next.name.trim() || "New Group", next.description);
        if (requestRevision === revision.current) setSaveState("saved");
      } catch {
        if (requestRevision === revision.current) setSaveState("error");
      }
    },
    [onUpdate]
  );

  const queue = useCallback(
    (next: typeof draft) => {
      draftRef.current = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(draftRef.current), 400);
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
        Back to conversation details
      </button>
      <GroupAvatarEditor botById={botById} channel={channel} onSave={onSetAvatar} />
      <div className="mt-8 grid gap-2">
        <div className="grid gap-[2px]">
          <Label
            className="pl-2 text-[12px] font-normal leading-[18px] text-muted-foreground"
            htmlFor={`group-settings-name-${channel.id}`}
          >
            Name
          </Label>
          <Input
            className="h-9 rounded-[7px] border-[#d9d9d9] px-2.5 text-[14px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id={`group-settings-name-${channel.id}`}
            maxLength={80}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, name: event.target.value })}
            value={draft.name}
          />
        </div>
        <div className="grid gap-[2px]">
          <Label
            className="pl-2 text-[12px] font-normal leading-[18px] text-muted-foreground"
            htmlFor={`group-settings-description-${channel.id}`}
          >
            Description
          </Label>
          <Textarea
            className="min-h-20 resize-none rounded-[7px] border-[#d9d9d9] px-2.5 py-2 text-[14px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id={`group-settings-description-${channel.id}`}
            maxLength={2_000}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, description: event.target.value })}
            placeholder="what this channel for"
            value={draft.description}
          />
        </div>
        {saveState === "error" && (
          <p className="text-xs text-destructive">Could not save. Your draft is still here.</p>
        )}
      </div>
    </div>
  );
}

export const Inspector = memo(function Inspector({
  channel,
  workspaceRoot,
  botById,
  active,
  screenEnabled,
  mode,
  onEnableScreen,
  onModeChange,
  onUpdateBot,
  onRetryBot,
  onShareAsTemplate,
  onOpenBot,
  onSetGroupAvatar,
  onSetMembers,
  onUpdateGroupProfile,
  routineOpenRequest,
}: {
  channel: ChannelView;
  workspaceRoot: string;
  botById: ReadonlyMap<string, BotView>;
  active: boolean;
  screenEnabled: boolean;
  mode: InspectorMode;
  onEnableScreen: (botId: string) => void;
  onModeChange: (mode: InspectorMode) => void;
  onUpdateBot: (botId: string, input: UpdateBotInput) => Promise<BotView>;
  onRetryBot: (botId: string) => Promise<void>;
  onShareAsTemplate: (bot: BotView) => void;
  onOpenBot: (botId: string) => void;
  onSetGroupAvatar: (channelId: string, pngBase64: string | null) => Promise<void>;
  onSetMembers: (channelId: string, botIds: string[]) => Promise<void>;
  routineOpenRequest?: { routineId: string; nonce: number } | null;
  onUpdateGroupProfile: (
    channelId: string,
    name: string,
    description: string
  ) => Promise<ChannelView>;
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
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [memberSaveState, setMemberSaveState] = useState<"idle" | "saving" | "error">("idle");
  useEffect(() => {
    if (routineOpenRequest) setSelectedRoutineId(routineOpenRequest.routineId);
  }, [routineOpenRequest]);
  useEffect(() => {
    setMemberSaveState("idle");
  }, [channel.id]);

  if (bot && mode === "settings") {
    return (
      <aside className="size-full bg-background">
        <BotSettings
          bot={bot}
          onBack={() => onModeChange("summary")}
          onShareAsTemplate={() => onShareAsTemplate(bot)}
          onUpdate={(input) => onUpdateBot(bot.id, input)}
        />
      </aside>
    );
  }

  if (bot && mode === "routine") {
    return (
      <aside className="size-full bg-background">
        <RoutineEditor
          ownerId={bot.id}
          ownerKind="bot"
          onDeleted={() => {
            setSelectedRoutineId(null);
            onModeChange("summary");
          }}
          routineId={selectedRoutineId}
        />
      </aside>
    );
  }

  if (!bot && mode === "routine") {
    return (
      <aside className="size-full bg-background">
        <RoutineEditor
          ownerId={channel.id}
          ownerKind="group"
          onDeleted={() => {
            setSelectedRoutineId(null);
            onModeChange("summary");
          }}
          routineId={selectedRoutineId}
        />
      </aside>
    );
  }

  if (!bot && mode === "settings") {
    return (
      <aside className="size-full bg-background">
        <GroupSettings
          botById={botById}
          channel={channel}
          key={channel.id}
          onBack={() => onModeChange("summary")}
          onSetAvatar={(pngBase64) => onSetGroupAvatar(channel.id, pngBase64)}
          onUpdate={(name, description) => onUpdateGroupProfile(channel.id, name, description)}
        />
      </aside>
    );
  }

  return (
    <aside className="flex size-full flex-col bg-background px-3 pb-5 pt-[41px]">
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
          <RoutinesSummary
            ownerId={bot.id}
            ownerKind="bot"
            onOpen={(routineId) => {
              setSelectedRoutineId(routineId);
              onModeChange("routine");
            }}
          />
        </>
      ) : (
        <>
          <div className="text-sm font-medium">Members</div>
          <ul aria-label="Members" className="mt-2 space-y-1">
            {members.map((member) => (
              <li className="group flex h-9 items-center" key={member.id}>
                <button
                  aria-label={`Open ${member.name}'s chat`}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => onOpenBot(member.id)}
                  type="button"
                >
                  <BotAvatar bot={member} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.name}</span>
                </button>
                <Button
                  aria-label={`Remove ${member.name}`}
                  className="size-7 shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  disabled={members.length <= 1 || memberSaveState === "saving"}
                  onClick={() => {
                    if (!window.confirm(`Remove ${member.name} from this conversation?`)) return;
                    setMemberSaveState("saving");
                    void onSetMembers(
                      channel.id,
                      members.filter((candidate) => candidate.id !== member.id).map(({ id }) => id)
                    ).then(
                      () => setMemberSaveState("idle"),
                      () => setMemberSaveState("error")
                    );
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
            <li>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Add Member"
                    className="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                    disabled={
                      members.length >= 6 ||
                      memberSaveState === "saving" ||
                      ![...botById.values()].some(
                        (candidate) =>
                          candidate.status === "active" &&
                          !members.some((member) => member.id === candidate.id)
                      )
                    }
                    type="button"
                  >
                    <span className="grid size-[22px] place-items-center">
                      <Plus className="size-3.5" />
                    </span>
                    <span>Add Member</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" aria-label="Add Member" className="w-[216px]">
                  {[...botById.values()]
                    .filter(
                      (candidate) =>
                        candidate.status === "active" &&
                        !members.some((member) => member.id === candidate.id)
                    )
                    .map((candidate) => (
                      <DropdownMenuItem
                        key={candidate.id}
                        onSelect={() => {
                          setMemberSaveState("saving");
                          void onSetMembers(channel.id, [
                            ...members.map(({ id }) => id),
                            candidate.id,
                          ]).then(
                            () => setMemberSaveState("idle"),
                            () => setMemberSaveState("error")
                          );
                        }}
                      >
                        <BotAvatar bot={candidate} size="sm" />
                        <span className="truncate">{candidate.name}</span>
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          </ul>
          {memberSaveState === "error" && (
            <p className="mt-2 text-[11px] text-destructive">Could not update members.</p>
          )}
          <RoutinesSummary
            ownerId={channel.id}
            ownerKind="group"
            onOpen={(routineId) => {
              setSelectedRoutineId(routineId);
              onModeChange("routine");
            }}
          />
        </>
      )}
      <div className="sr-only">Workspace root: {workspaceRoot}</div>
    </aside>
  );
});
