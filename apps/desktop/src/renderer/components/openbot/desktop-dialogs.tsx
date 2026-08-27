import type { BotTranscriptView, BotView } from "@openbot/contracts";
import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { TranscriptDialog } from "./transcript-dialog";

const GroupForm = lazy(() => import("./forms").then((module) => ({ default: module.GroupForm })));

export function DesktopDialogs({
  activeBots,
  deleteBotTarget,
  newGroupOpen,
  rowTranscript,
  onConfirmDeleteBot,
  onCreateGroup,
  onDeleteBotOpenChange,
  onNewGroupOpenChange,
  onTranscriptOpenChange,
}: {
  activeBots: BotView[];
  deleteBotTarget: BotView | null;
  newGroupOpen: boolean;
  rowTranscript: { bot: BotView; transcript: BotTranscriptView | null } | null;
  onConfirmDeleteBot: () => void;
  onCreateGroup: (name: string, botIds: string[]) => Promise<void>;
  onDeleteBotOpenChange: (open: boolean) => void;
  onNewGroupOpenChange: (open: boolean) => void;
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
      <Dialog onOpenChange={onNewGroupOpenChange} open={newGroupOpen}>
        <DialogContent className="max-w-[640px] gap-0 overflow-hidden rounded-[14px] p-0">
          <Suspense
            fallback={
              <div className="grid min-h-72 place-items-center">
                <DialogTitle className="sr-only">New channel</DialogTitle>
                <DialogDescription className="sr-only">
                  Loading channel creation form.
                </DialogDescription>
                <LoaderCircle aria-label="Loading" className="size-5 animate-spin" />
              </div>
            }
          >
            <GroupForm bots={activeBots} onSubmit={onCreateGroup} />
          </Suspense>
        </DialogContent>
      </Dialog>
      <TranscriptDialog
        botName={rowTranscript?.bot.name ?? "Bot"}
        onOpenChange={onTranscriptOpenChange}
        transcript={rowTranscript?.transcript ?? null}
      />
    </>
  );
}
