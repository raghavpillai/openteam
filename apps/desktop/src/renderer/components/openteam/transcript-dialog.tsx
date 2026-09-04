import type { BotTranscriptView } from "@openteam/contracts";
import { useCallback, useRef } from "react";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

function TranscriptEvents({ events }: { events: BotTranscriptView["events"] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const estimateSize = useCallback(
    (index: number) => {
      const contentLength = events[index]?.content?.length ?? 0;
      return Math.min(360, 68 + Math.ceil(contentLength / 90) * 18);
    },
    [events]
  );
  const getKey = useCallback((index: number) => events[index]?.id ?? `missing:${index}`, [events]);
  const { measureElement, totalSize, virtualItems } = useVirtualWindow({
    count: events.length,
    estimateSize,
    getKey,
    initialViewportSize: 600,
    maxItems: 80,
    overscan: 500,
    scrollRef,
  });

  return (
    <div
      aria-label={`${events.length} transcript events`}
      className="bot-scrollbar max-h-[60vh] min-h-0 overflow-auto rounded-xl border bg-muted/25 p-3"
      data-virtual-transcript-count={events.length}
      ref={scrollRef}
      role="list"
    >
      <div className="relative w-full" style={{ height: totalSize }}>
        {virtualItems.map((virtualItem) => {
          const event = events[virtualItem.index];
          if (!event) return null;
          return (
            <div
              aria-posinset={virtualItem.index + 1}
              aria-setsize={events.length}
              className="absolute inset-x-0 top-0 pb-2"
              key={virtualItem.key}
              ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
              role="listitem"
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <div className="rounded-lg border bg-background p-3 text-xs">
                <div className="flex gap-2 text-muted-foreground">
                  <span>{event.sender?.name ?? event.type}</span>
                  <span>·</span>
                  <span>{new Date(event.at).toLocaleString()}</span>
                </div>
                {event.content && (
                  <div className="mt-1.5 whitespace-pre-wrap text-sm">{event.content}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
        {transcript && <TranscriptEvents events={transcript.events} />}
      </DialogContent>
    </Dialog>
  );
}
