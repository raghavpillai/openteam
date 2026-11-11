import type { ChannelMessageView, ReactToChannelMessageView } from "@openteam/contracts";
import { messageMetadata, ownReactionEmojiSet } from "@openteam/product-core/messages";

const ownEmoji = (message: ChannelMessageView) =>
  ownReactionEmojiSet(message).values().next().value ?? null;

// Only the current user's reaction is optimistic. Concurrent message edits and
// other actors' reactions must survive an acknowledgement or rollback.
const withOwnEmoji = (message: ChannelMessageView, emoji: string | null): ChannelMessageView => {
  const own = ownReactionEmojiSet(message);
  if (own.size === (emoji === null ? 0 : 1) && (emoji === null || own.has(emoji))) return message;
  const metadata = messageMetadata(message);
  const reactions = Array.isArray(metadata.reactions) ? metadata.reactions : [];
  return {
    ...message,
    metadata: {
      ...metadata,
      reactions: [
        ...reactions.filter(
          (reaction) => !reaction || typeof reaction !== "object" || reaction.by !== "me"
        ),
        ...(emoji === null ? [] : [{ by: "me", emoji }]),
      ],
    },
  };
};

interface PendingReaction {
  confirmed: string | null;
  desired: string | null;
  task: Promise<ReactToChannelMessageView>;
}

/** Coalesce taps into the latest desired state, with one toggle RPC per message. */
export function createReactionController(options: {
  message: (id: string) => ChannelMessageView | undefined;
  patch: (message: ChannelMessageView) => void;
  send: (id: string, emoji: string) => Promise<ReactToChannelMessageView>;
  error: (cause: unknown) => void;
}) {
  const pending = new Map<string, PendingReaction>();
  let active = true;
  let revision = 0;
  const current = (id: string, entry: PendingReaction) => active && pending.get(id) === entry;
  const patchOwn = (id: string, emoji: string | null) => {
    const message = options.message(id);
    if (message) options.patch(withOwnEmoji(message, emoji));
  };
  return {
    async read<T>(operation: () => Promise<T>): Promise<T> {
      // A response captured before a completed toggle can contain the old
      // selection. Repeat only the read, never the uncertain mutation.
      while (true) {
        const startedAt = revision;
        const result = await operation();
        if (!active || startedAt === revision) return result;
      }
    },
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      pending.clear();
    },
    project(message: ChannelMessageView) {
      const entry = pending.get(message.id);
      return entry ? withOwnEmoji(message, entry.desired) : message;
    },
    toggle(id: string, emoji: string): Promise<ReactToChannelMessageView> {
      if (!active) return Promise.reject(new Error("This conversation is no longer open"));
      const existing = pending.get(id);
      if (existing) {
        existing.desired = existing.desired === emoji ? null : emoji;
        patchOwn(id, existing.desired);
        return existing.task;
      }
      const message = options.message(id);
      if (!message) {
        return options.send(id, emoji).then(
          (result) => {
            if (active) {
              revision += 1;
              patchOwn(id, ownEmoji(result.message));
            }
            return result;
          },
          (cause) => {
            if (active) options.error(cause);
            throw cause;
          }
        );
      }
      const confirmed = ownEmoji(message);
      const entry = { confirmed, desired: confirmed === emoji ? null : emoji } as PendingReaction;
      pending.set(id, entry);
      patchOwn(id, entry.desired);
      entry.task = (async () => {
        let result: ReactToChannelMessageView;
        try {
          do {
            // Clearing a toggle API requires sending the confirmed emoji again.
            const sentDesired = entry.desired;
            result = await options.send(id, sentDesired ?? entry.confirmed ?? emoji);
            if (!current(id, entry)) return result;
            if (result.message.id !== id || ownEmoji(result.message) !== sentDesired) {
              throw new Error("The reaction could not be confirmed. Please refresh and try again.");
            }
            revision += 1;
            entry.confirmed = ownEmoji(result.message);
            patchOwn(id, entry.desired);
          } while (entry.confirmed !== entry.desired);
          pending.delete(id);
          return result;
        } catch (cause) {
          if (current(id, entry)) {
            pending.delete(id);
            revision += 1;
            // A transport error may follow a committed mutation. Never replay
            // this toggle automatically; roll back visibly and surface it.
            patchOwn(id, entry.confirmed);
            options.error(cause);
          }
          throw cause;
        }
      })();
      return entry.task;
    },
  };
}
