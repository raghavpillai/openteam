import { parseGroupMentions } from "@openteam/messaging";
import { metadataRecord } from "../service-utils";

export type ReplyTarget = {
  id: string;
  sequence: bigint;
  sender: "user" | "agent" | "system";
  content: string;
  metadata: unknown;
};

export const messageAddress = (message: ReplyTarget): string => {
  if (message.sender === "user") return `t${message.sequence}u`;
  const metadata = metadataRecord(message.metadata);
  return typeof metadata.address === "string" ? metadata.address : `t${message.sequence}a0`;
};

export const formatUserPrompt = (sequence: bigint, content: string, reply?: ReplyTarget | null) => {
  if (!reply) return content ? `[t${sequence}u] ${content}` : `[t${sequence}u]`;
  return [
    `[t${sequence}u]`,
    `[In reply to ${messageAddress(reply)}: ${JSON.stringify(reply.content)}]`,
    ...(content ? [content] : []),
  ].join("\n");
};

export const formatDirectMentionContext = (
  content: string,
  peers: readonly { id: string; name: string }[]
): string => {
  const mentionedIds = new Set(parseGroupMentions(content, peers).memberIds);
  const mentioned = peers.filter((peer) => mentionedIds.has(peer.id));
  if (mentioned.length === 0) return content;
  return [
    "[Agents mentioned in this message — you can reach them with SendToAgent using their id:]",
    ...mentioned.map((peer) => `- ${peer.name} (id: ${peer.id})`),
    "",
    content,
  ].join("\n");
};

export const reactionQuote = (content: string): string => {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
};

export const formatUserReactionPrompt = (emoji: string, content: string) =>
  `[SAND_HIDDEN_PROMPT][The user reacted ${emoji} to your message: ` +
  `${JSON.stringify(reactionQuote(content))}. You don't need to reply; ` +
  `act on it only if it's useful (e.g. acknowledge, adjust, or continue).][SAND_HIDDEN_PROMPT]`;

export const xmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const formatChannelRenamePrompt = (input: { name: string; description: string }): string => {
  const profile = JSON.stringify({ name: input.name, description: input.description });
  const token = Buffer.from(profile, "utf8").toString("base64");
  return [
    `[SAND_HIDDEN_PROMPT][SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:${token}>>`,
    "<agent_profile_update>",
    "Your agent profile changed. This full update is authoritative and supersedes the Agent profile section in the system prompt and every earlier profile update in this conversation.",
    `Current name: ${xmlText(input.name)}`,
    `Current description: ${input.description ? xmlText(input.description) : "(no description)"}`,
    "Use this identity until a future conversation summary folds it into the Agent profile section.",
    "</agent_profile_update>",
    "",
    "[event] Something about this conversation just changed.",
    "This is a system event recorded in your timeline, not the user typing in this app, and possibly something you did yourself.",
    `- Renamed to ${input.name}`,
    "If it is worth acknowledging to the user, reply with SendToUser; otherwise it is fine to stay silent.",
  ].join("\n");
};
