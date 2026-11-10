import type { BotTranscriptView, BotView, ChannelView } from "@openteam/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { TranscriptDialog } from "./transcript-dialog";

export function DesktopDialogs({
  deleteBotTarget,
  deleteGroupTarget,
  rowTranscript,
  onConfirmDeleteBot,
  onConfirmDeleteGroup,
  onDeleteBotOpenChange,
  onDeleteGroupOpenChange,
  onTranscriptOpenChange,
}: {
  deleteBotTarget: BotView | null;
  deleteGroupTarget: ChannelView | null;
  rowTranscript: { bot: BotView; transcript: BotTranscriptView | null } | null;
  onConfirmDeleteBot: () => void;
  onConfirmDeleteGroup: () => void;
  onDeleteBotOpenChange: (open: boolean) => void;
  onDeleteGroupOpenChange: (open: boolean) => void;
  onTranscriptOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <AlertDialog onOpenChange={onDeleteBotOpenChange} open={Boolean(deleteBotTarget)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteBotTarget?.name}”</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the Bot and its chat history.
              <br />
              This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteBot}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={onDeleteGroupOpenChange} open={Boolean(deleteGroupTarget)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteGroupTarget?.name}”</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the group and its chat history. The Bots in it are not
              deleted and remain available individually. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteGroup}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <TranscriptDialog
        botName={rowTranscript?.bot.name ?? "Bot"}
        onOpenChange={onTranscriptOpenChange}
        transcript={rowTranscript?.transcript ?? null}
      />
    </>
  );
}
