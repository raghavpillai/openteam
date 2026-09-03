import type { BotView, ChannelView, UpdateBotInput } from "@openbot/contracts";
import { Plus } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOT_TEMPLATE_SHARING_ENABLED } from "../../lib/bot-template";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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

const AvatarPicker = lazy(() =>
  import("./avatar-picker").then((module) => ({ default: module.AvatarPicker }))
);
const BotScreen = lazy(() =>
  import("./bot-screen").then((module) => ({ default: module.BotScreen }))
);
const RoutineEditor = lazy(() =>
  import("./routine-panel").then((module) => ({ default: module.RoutineEditor }))
);
const RoutinesSummary = lazy(() =>
  import("./routine-summary").then((module) => ({ default: module.RoutinesSummary }))
);
const BotTemplateSettingsFooter = lazy(() =>
  import("./bot-template-share").then((module) => ({
    default: module.BotTemplateSettingsFooter,
  }))
);
const GroupAvatarEditor = lazy(() =>
  import("./group-avatar-editor").then((module) => ({ default: module.GroupAvatarEditor }))
);

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
  onShareAsTemplate,
  onUpdate,
}: {
  bot: BotView;
  onShareAsTemplate: () => void;
  onUpdate: (input: UpdateBotInput) => Promise<BotView>;
}) {
  const [draft, setDraft] = useState(() => draftOf(bot));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const draftRef = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

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
      else {
        timer.current = setTimeout(() => {
          timer.current = null;
          void persist(draftRef.current);
        }, 400);
      }
    },
    [persist]
  );

  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    void persist(draftRef.current);
  };

  useEffect(
    () => () => {
      revision.current += 1;
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      const next = draftRef.current;
      void updateRef
        .current({
          name: next.name.trim() || "New Bot",
          title: next.title,
          description: next.description,
          notificationsEnabled: next.notificationsEnabled,
        })
        .catch(() => undefined);
    },
    []
  );

  return (
    <div className="flex size-full flex-col overflow-y-auto px-4 pb-5 pt-[70px]">
      <div className="flex justify-center">
        <Suspense
          fallback={
            <div aria-label="Loading avatar options" className="size-[76px]" role="status" />
          }
        >
          <AvatarPicker
            botId={bot.id}
            color={draft.color}
            icon={draft.icon}
            onChange={(next) => queue({ ...draft, ...next }, true, true)}
          />
        </Suspense>
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
            aria-label="Bot name"
            className="h-9 rounded-[7px] border-[#d9d9d9] px-2.5 text-[14px] shadow-none focus-visible:ring-0 dark:border-[#393939] dark:bg-[#181818]"
            id={`settings-name-${bot.id}`}
            maxLength={80}
            onBlur={flush}
            onChange={(event) => queue({ ...draft, name: event.target.value })}
            placeholder="Bob"
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
            aria-label="Bot label"
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
            aria-label="Bot description"
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
            aria-label="Notifications"
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
        <Suspense fallback={<div className="mt-auto h-10 pt-6" />}>
          <div className="mt-auto pt-6">
            <BotTemplateSettingsFooter bot={bot} onShare={onShareAsTemplate} />
          </div>
        </Suspense>
      )}
    </div>
  );
}

function GroupSettings({
  botById,
  channel,
  onSetAvatar,
  onUpdate,
}: {
  botById: ReadonlyMap<string, BotView>;
  channel: ChannelView;
  onSetAvatar: (pngBase64: string | null) => Promise<void>;
  onUpdate: (name: string, description: string) => Promise<ChannelView>;
}) {
  const [draft, setDraft] = useState(() => ({
    name: channel.name,
    description: channel.description,
  }));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const draftRef = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

  useEffect(() => {
    const next = { name: channel.name, description: channel.description };
    draftRef.current = next;
    setDraft(next);
    setSaveState("idle");
  }, [channel.description, channel.name]);

  const persist = useCallback(
    async (next: typeof draft) => {
      const requestRevision = ++revision.current;
      setSaveState("saving");
      try {
        await onUpdate(next.name.trim() || "New Group", next.description);
        if (requestRevision === revision.current) setSaveState("idle");
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
      timer.current = setTimeout(() => {
        timer.current = null;
        void persist(draftRef.current);
      }, 400);
    },
    [persist]
  );
  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    void persist(draftRef.current);
  };

  useEffect(
    () => () => {
      revision.current += 1;
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      const next = draftRef.current;
      void updateRef
        .current(next.name.trim() || "New Group", next.description)
        .catch(() => undefined);
    },
    []
  );

  return (
    <div className="flex size-full flex-col overflow-y-auto px-4 pb-5 pt-[70px]">
      <Suspense fallback={<div aria-label="Loading group avatar" className="h-[76px]" />}>
        <GroupAvatarEditor botById={botById} channel={channel} onSave={onSetAvatar} />
      </Suspense>
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
            placeholder="What this conversation is for"
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
  computerHandoff,
  botById,
  active,
  screenEnabled,
  mode,
  onEnableScreen,
  onFinishComputerHandoff,
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
  computerHandoff?: { botId: string; messageId: string } | null;
  botById: ReadonlyMap<string, BotView>;
  active: boolean;
  screenEnabled: boolean;
  mode: InspectorMode;
  onEnableScreen: (botId: string) => void;
  onFinishComputerHandoff?: () => void;
  onModeChange: (mode: InspectorMode) => void;
  onUpdateBot: (botId: string, input: UpdateBotInput) => Promise<BotView>;
  onRetryBot: (botId: string) => Promise<void>;
  onShareAsTemplate: (bot: BotView) => void;
  onOpenBot: (botId: string) => void;
  onSetGroupAvatar: (channelId: string, pngBase64: string | null) => Promise<void>;
  onSetMembers: (channelId: string, botIds: string[]) => Promise<void>;
  onUpdateGroupProfile: (
    channelId: string,
    name: string,
    description: string
  ) => Promise<ChannelView>;
  routineOpenRequest?: { routineId: string; nonce: number } | null;
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
  const [memberMutationPending, setMemberMutationPending] = useState(false);
  const [memberMutationError, setMemberMutationError] = useState<string | null>(null);
  const [removeMemberTarget, setRemoveMemberTarget] = useState<BotView | null>(null);
  const memberIds = useMemo(() => members.map((member) => member.id), [members]);
  const memberIdSet = useMemo(() => new Set(memberIds), [memberIds]);
  const addableMembers = useMemo(
    () =>
      [...botById.values()].filter(
        (candidate) => candidate.status === "active" && !memberIdSet.has(candidate.id)
      ),
    [botById, memberIdSet]
  );
  const setMembers = useCallback(
    async (nextMemberIds: string[], failureMessage: string) => {
      setMemberMutationPending(true);
      setMemberMutationError(null);
      try {
        await onSetMembers(channel.id, nextMemberIds);
        return true;
      } catch {
        setMemberMutationError(failureMessage);
        return false;
      } finally {
        setMemberMutationPending(false);
      }
    },
    [channel.id, onSetMembers]
  );
  useEffect(() => {
    setMemberMutationPending(false);
    setMemberMutationError(null);
    setRemoveMemberTarget(null);
  }, [channel.id]);
  useEffect(() => {
    if (routineOpenRequest) setSelectedRoutineId(routineOpenRequest.routineId);
  }, [routineOpenRequest]);

  if (bot && mode === "settings") {
    return (
      <aside aria-label="Settings" className="size-full bg-background">
        <BotSettings
          bot={bot}
          onShareAsTemplate={() => onShareAsTemplate(bot)}
          onUpdate={(input) => onUpdateBot(bot.id, input)}
        />
      </aside>
    );
  }

  if (!bot && mode === "settings") {
    return (
      <aside aria-label="Settings" className="size-full bg-background">
        <GroupSettings
          botById={botById}
          channel={channel}
          key={channel.id}
          onSetAvatar={(pngBase64) => onSetGroupAvatar(channel.id, pngBase64)}
          onUpdate={(name, description) => onUpdateGroupProfile(channel.id, name, description)}
        />
      </aside>
    );
  }

  if (mode === "routine") {
    return (
      <aside className="size-full bg-background">
        <Suspense
          fallback={<div aria-label="Loading routine editor" className="size-full" role="status" />}
        >
          <RoutineEditor
            active={active}
            ownerId={bot?.id ?? channel.id}
            ownerKind={bot ? "bot" : "group"}
            onDeleted={() => {
              setSelectedRoutineId(null);
              onModeChange("summary");
            }}
            routineId={selectedRoutineId}
          />
        </Suspense>
      </aside>
    );
  }

  return (
    <aside className="flex size-full flex-col bg-background px-3 pb-5 pt-[41px]">
      {bot ? (
        <Suspense
          fallback={<div aria-label="Loading bot details" className="size-full" role="status" />}
        >
          <section aria-label="Computer preview">
            <BotScreen
              active={active}
              bot={bot}
              enabled={screenEnabled}
              handoff={computerHandoff}
              onEnable={() => onEnableScreen(bot.id)}
              onHandoffFinished={onFinishComputerHandoff}
              onRetry={() => onRetryBot(bot.id)}
            />
            <div className="mt-2 text-center text-[12px] leading-4 text-muted-foreground">
              {bot.status === "provisioning"
                ? `Starting ${bot.name}'s screen…`
                : `${bot.name}'s screen`}
            </div>
          </section>
          <RoutinesSummary
            active={active}
            ownerId={bot.id}
            ownerKind="bot"
            onOpen={(routineId) => {
              setSelectedRoutineId(routineId);
              onModeChange("routine");
            }}
          />
        </Suspense>
      ) : (
        <>
          <section aria-label="Members" className="sand-group-members-section">
            <div className="px-2 text-[12px] leading-5 text-foreground-secondary">Members</div>
            <div className="mt-1">
              {members.map((member) => (
                <div
                  className="sand-group-member-row group flex h-10 items-center rounded-[9px] px-1 hover:bg-accent"
                  key={member.id}
                >
                  <button
                    aria-label={`Open ${member.name}'s chat`}
                    className="sand-group-member-open flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                    onClick={() => onOpenBot(member.id)}
                    type="button"
                  >
                    <BotAvatar bot={member} size="sm" />
                    <span className="sand-group-member-name min-w-0 flex-1 truncate text-[13px]">
                      {member.name}
                    </span>
                  </button>
                  <button
                    className="mr-1 rounded-[7px] px-2 py-1 text-[11px] text-foreground-secondary opacity-0 outline-none transition-opacity hover:bg-black/[0.055] hover:text-foreground focus:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/35 group-hover:opacity-100 disabled:pointer-events-none dark:hover:bg-white/[0.08]"
                    disabled={members.length <= 1 || memberMutationPending}
                    onClick={() => setRemoveMemberTarget(member)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="sand-group-member-add-row sand-group-member-add mt-0.5 flex h-9 w-full items-center gap-2 rounded-[9px] px-2 text-left text-[13px] text-foreground-secondary outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-45"
                    disabled={
                      members.length >= 6 || addableMembers.length === 0 || memberMutationPending
                    }
                    type="button"
                  >
                    <Plus className="size-4" strokeWidth={1.7} />
                    <span>Add Member</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-[300px] w-[260px] overflow-y-auto rounded-[12px] p-1.5"
                >
                  {addableMembers.map((candidate) => (
                    <DropdownMenuItem
                      className="h-10 gap-2.5 rounded-[9px] px-2 text-[13px]"
                      disabled={memberMutationPending}
                      key={candidate.id}
                      onSelect={() =>
                        void setMembers(
                          [...memberIds, candidate.id],
                          "Adding failed. Check your connection and try again."
                        )
                      }
                    >
                      <BotAvatar bot={candidate} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {memberMutationError && (
              <p className="mt-1 px-2 text-[11px] text-destructive">{memberMutationError}</p>
            )}
          </section>
          <Suspense fallback={<div aria-label="Loading group routines" className="mt-4 h-16" />}>
            <RoutinesSummary
              active={active}
              ownerId={channel.id}
              ownerKind="group"
              onOpen={(routineId) => {
                setSelectedRoutineId(routineId);
                onModeChange("routine");
              }}
            />
          </Suspense>
          <AlertDialog
            onOpenChange={(open) => !open && setRemoveMemberTarget(null)}
            open={Boolean(removeMemberTarget)}
          >
            <AlertDialogContent aria-describedby={undefined}>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove {removeMemberTarget?.name} from this conversation?
                </AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={memberMutationPending}
                  onClick={(event) => {
                    event.preventDefault();
                    const targetId = removeMemberTarget?.id;
                    if (!targetId || memberIds.length <= 1) return;
                    void setMembers(
                      memberIds.filter((id) => id !== targetId),
                      "Removing failed. Check your connection and try again."
                    ).then((updated) => {
                      if (updated) setRemoveMemberTarget(null);
                    });
                  }}
                >
                  {memberMutationPending ? "Removing..." : "Remove"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </aside>
  );
});
