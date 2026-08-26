import type { BotTranscriptView, BotView, CreateBotInput } from "@openbot/contracts";
import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { TranscriptDialog } from "./transcript-dialog";

const loadForms = () => import("./forms");
const NewBotForm = lazy(() => loadForms().then((module) => ({ default: module.NewBotForm })));
const GroupForm = lazy(() => loadForms().then((module) => ({ default: module.GroupForm })));

export const preloadDesktopForms = () => void loadForms();

function DialogLoading({ title }: { title: string }) {
  return (
    <>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogDescription className="sr-only">Loading dialog content.</DialogDescription>
      <LoaderCircle aria-label="Loading" className="mx-auto size-5 animate-spin" />
    </>
  );
}

export function DesktopDialogs({
  activeBots,
  newBotOpen,
  newGroupOpen,
  rowTranscript,
  onCreateBot,
  onCreateGroup,
  onNewBotOpenChange,
  onNewGroupOpenChange,
  onTranscriptOpenChange,
}: {
  activeBots: BotView[];
  newBotOpen: boolean;
  newGroupOpen: boolean;
  rowTranscript: { bot: BotView; transcript: BotTranscriptView | null } | null;
  onCreateBot: (value: CreateBotInput) => Promise<void>;
  onCreateGroup: (name: string, botIds: string[]) => Promise<void>;
  onNewBotOpenChange: (open: boolean) => void;
  onNewGroupOpenChange: (open: boolean) => void;
  onTranscriptOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <Dialog onOpenChange={onNewBotOpenChange} open={newBotOpen}>
        <DialogContent>
          <Suspense fallback={<DialogLoading title="New bot" />}>
            <NewBotForm onCancel={() => onNewBotOpenChange(false)} onSubmit={onCreateBot} />
          </Suspense>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={onNewGroupOpenChange} open={newGroupOpen}>
        <DialogContent>
          <Suspense fallback={<DialogLoading title="New channel" />}>
            <GroupForm
              bots={activeBots}
              onCancel={() => onNewGroupOpenChange(false)}
              onSubmit={onCreateGroup}
            />
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
