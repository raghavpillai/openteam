export const GROUP_MAX_MEMBERS = 6;
export const GROUP_MAX_ROUNDS = 3;
export const GROUP_MAX_MEMBER_TURNS = 10;
export const GROUP_MAX_MESSAGES_PER_TURN = 3;
export const EVERYONE_MENTION_ID = "__everyone__";

export interface GroupMentionMember {
  id: string;
  name: string;
}

export interface GroupRoutingMessage {
  sender: "user" | "agent" | "system";
  content: string;
}

export interface GroupVisibilityWindow {
  rootSequence: bigint;
  triggerSequence: bigint;
  lastTargetSequence: bigint | null;
  earlierRunIds: readonly string[];
}

/**
 * Keep the round's original room snapshot frozen at the trigger while admitting
 * only outputs authored by members that have already held this round's baton.
 */
export const groupVisibilityClauses = ({
  rootSequence,
  triggerSequence,
  lastTargetSequence,
  earlierRunIds,
}: GroupVisibilityWindow) => [
  {
    sequence: {
      ...(lastTargetSequence === null ? { gte: rootSequence } : { gt: lastTargetSequence }),
      lte: triggerSequence,
    },
  },
  ...(earlierRunIds.length > 0
    ? [
        {
          sender: "agent" as const,
          sourceRunId: { in: [...new Set(earlierRunIds)] },
          sequence: { gt: triggerSequence },
        },
      ]
    : []),
];

const normalizeHandle = (value: string) => value.toLocaleLowerCase("en-US");

export const groupMemberMentionHandles = (name: string): string[] => {
  const normalized = normalizeHandle(name.trim());
  if (!normalized) return [];
  const compact = normalized.replace(/\s+/g, "");
  const first = normalized.split(/\s+/)[0] ?? "";
  return [...new Set([compact, first].filter(Boolean))];
};

const mentionHandles = (text: string): string[] => {
  const handles: string[] = [];
  const matcher = /(?:^|[^a-z0-9])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/giu;
  for (const match of text.matchAll(matcher)) {
    if (match[1]) handles.push(normalizeHandle(match[1]));
  }
  return handles;
};

export const parseGroupMentions = (
  text: string,
  members: readonly GroupMentionMember[]
): { isEveryone: boolean; memberIds: string[] } => {
  const handles = new Set(mentionHandles(text));
  const isEveryone = handles.has("everyone") || handles.has("all");
  const memberIds = members
    .filter((member) =>
      groupMemberMentionHandles(member.name).some((handle) => handles.has(handle))
    )
    .map((member) => member.id);
  return { isEveryone, memberIds };
};

export const resolveGroupResponderIds = (
  members: readonly GroupMentionMember[],
  history: readonly GroupRoutingMessage[],
  options: { attachmentOnlyFirstRound?: boolean } = {}
): string[] => {
  if (options.attachmentOnlyFirstRound) return members.map((member) => member.id);
  let lastUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.sender === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const routingText = history
    .slice(lastUserIndex < 0 ? 0 : lastUserIndex)
    .map((message) => message.content)
    .join("\n");
  const mentions = parseGroupMentions(routingText, members);
  if (mentions.isEveryone || mentions.memberIds.length === 0) {
    return members.map((member) => member.id);
  }
  return mentions.memberIds;
};

export const rotateGroupResponders = (
  memberIds: readonly string[],
  roundIndex: number
): string[] => {
  if (memberIds.length < 2) return [...memberIds];
  const offset = ((roundIndex % memberIds.length) + memberIds.length) % memberIds.length;
  return [...memberIds.slice(offset), ...memberIds.slice(0, offset)];
};
