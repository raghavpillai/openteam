import type { BotView, ChannelView } from "@openteam/contracts";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import { BotAvatar, ChannelAvatar } from "../avatar";

export function HiddenAgentsDialog({
  botById,
  hiddenBots,
  hiddenGroups,
  onOpenChange,
  onOpenChannel,
  onUnhideBot,
  onUnhideGroup,
  open,
}: {
  botById: ReadonlyMap<string, BotView>;
  hiddenBots: BotView[];
  hiddenGroups: ChannelView[];
  onOpenChange: (open: boolean) => void;
  onOpenChannel: (channelId: string) => void;
  onUnhideBot: (bot: BotView) => Promise<void>;
  onUnhideGroup: (group: ChannelView) => Promise<void>;
  open: boolean;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const hiddenAgentCount = hiddenBots.length + hiddenGroups.length;
  const unhide = async (id: string, request: () => Promise<void>) => {
    setPendingId(id);
    setError(false);
    try {
      await request();
    } catch {
      setError(true);
    } finally {
      setPendingId(null);
    }
  };

  const row = (
    id: string,
    avatar: React.ReactNode,
    name: string,
    open: () => void,
    show: () => Promise<void>
  ) => (
    <div className="flex h-11 items-center gap-2 rounded-lg px-2 hover:bg-hover" key={id}>
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => {
          onOpenChange(false);
          open();
        }}
        type="button"
      >
        {avatar}
        <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
      </button>
      <Button
        disabled={pendingId !== null}
        onClick={() => void unhide(id, show)}
        size="xs"
        variant="secondary"
      >
        {pendingId === id ? "Showing…" : "Show in sidebar"}
      </Button>
    </div>
  );

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setError(false);
      }}
      open={open}
    >
      <DialogContent className="w-[440px] gap-0 p-0" showCloseButton>
        <div className="px-5 pb-3 pt-5">
          <DialogTitle>Hidden bots</DialogTitle>
          <DialogDescription className="mt-1.5">
            Hidden bots keep working and keep their history. They just don't show in the sidebar.
          </DialogDescription>
        </div>
        <div className="ob-scrollbar max-h-[420px] min-h-[96px] overflow-y-auto px-3 pb-3">
          {error ? (
            <p className="px-2 py-2 text-[13px] text-danger">
              Couldn't update the sidebar. Check your connection and try again.
            </p>
          ) : null}
          {hiddenAgentCount === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-ink-2">Nothing is hidden.</p>
          ) : (
            <div className="space-y-0.5">
              {hiddenBots.map((bot) =>
                row(
                  bot.id,
                  <BotAvatar bot={bot} size="sm" />,
                  bot.name,
                  () => onOpenChannel(bot.dmChannelId),
                  () => onUnhideBot(bot)
                )
              )}
              {hiddenGroups.map((group) =>
                row(
                  group.id,
                  <ChannelAvatar botById={botById} channel={group} size="sm" />,
                  group.name,
                  () => onOpenChannel(group.id),
                  () => onUnhideGroup(group)
                )
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
