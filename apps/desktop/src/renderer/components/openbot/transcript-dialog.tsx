import type { BotTranscriptView } from "@openbot/contracts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

export function TranscriptDialog({
  botName,
  transcript,
  onOpenChange,
}: {
  botName: string;
  transcript: BotTranscriptView | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(transcript)}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
        <DialogTitle>{botName} transcript</DialogTitle>
        <DialogDescription>
          Safe visible-message and run projection. Internal reasoning and raw tool data are
          excluded.
        </DialogDescription>
        <div className="grok-scrollbar max-h-[60vh] space-y-2 overflow-auto rounded-xl border bg-muted/25 p-3">
          {transcript?.events.map((event) => (
            <div className="rounded-lg border bg-background p-3 text-xs" key={event.id}>
              <div className="flex gap-2 text-muted-foreground">
                <span>{event.sender?.name ?? event.type}</span>
                <span>·</span>
                <span>{new Date(event.at).toLocaleString()}</span>
              </div>
              {event.content && (
                <div className="mt-1.5 whitespace-pre-wrap text-sm">{event.content}</div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
