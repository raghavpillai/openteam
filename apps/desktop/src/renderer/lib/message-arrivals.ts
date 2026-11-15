/**
 * The newest message of a transcript its reader was watching: the chat was
 * open, at its live edge, and its history had loaded. `latestMessageId` is null
 * when that transcript was empty.
 */
export type WatchedTranscript = {
  channelId: string;
  latestMessageId: string | null;
};

const NO_ARRIVALS: ReadonlySet<string> = new Set();

/**
 * Messages that arrived while their reader watched: the ones appended below
 * the newest message they were already looking at. These, and only these, play
 * the arrival entrance.
 *
 * A transcript nobody was watching has no arrivals, whatever it holds now.
 * Opening a chat, returning to one, and a history page landing all show
 * messages that already existed; they appear in place. The same holds when the
 * watched message is no longer in the transcript, because the page was replaced
 * and nothing can be said about what is new.
 */
export const arrivedMessageIds = (
  messages: readonly { id: string }[],
  channelId: string,
  watched: WatchedTranscript | null
): ReadonlySet<string> => {
  if (!watched || watched.channelId !== channelId || messages.length === 0) return NO_ARRIVALS;
  if (watched.latestMessageId === null) return new Set(messages.map((message) => message.id));
  // Arrivals are few and at the end, so look for the watched message from there.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.id !== watched.latestMessageId) continue;
    if (index === messages.length - 1) return NO_ARRIVALS;
    return new Set(messages.slice(index + 1).map((message) => message.id));
  }
  return NO_ARRIVALS;
};

/**
 * The transcript its reader is watching once this render is on screen.
 *
 * Watching starts when the chat is open at its live edge and the transcript
 * holds everything the app already knows was sent. A chat opened while it is
 * still `behind` (a reply the sidebar already shows has not been read into the
 * transcript yet) is not being watched: that reply was there before the reader
 * was, so it appears in place. Once watching has started, a reply the app hears
 * about before it reads it is an arrival like any other.
 */
export const nextWatchedTranscript = ({
  watching,
  behind,
  previous,
  channelId,
  messages,
}: {
  watching: boolean;
  behind: boolean;
  previous: WatchedTranscript | null;
  channelId: string;
  messages: readonly { id: string }[];
}): WatchedTranscript | null => {
  if (!watching) return null;
  if (behind && previous?.channelId !== channelId) return null;
  return { channelId, latestMessageId: messages.at(-1)?.id ?? null };
};
