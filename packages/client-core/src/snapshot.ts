import type { ClientSnapshot } from "@openteam/contracts";

/**
 * Defensive response normalization for older/interrupted servers. Product
 * projections belong in @openteam/product-core, not in this transport client.
 */
export const normalizeClientSnapshot = (snapshot: ClientSnapshot): ClientSnapshot => ({
  ...snapshot,
  bots: Array.isArray(snapshot.bots) ? snapshot.bots : [],
  channels: Array.isArray(snapshot.channels) ? snapshot.channels : [],
  channelMessages: Array.isArray(snapshot.channelMessages) ? snapshot.channelMessages : [],
  channelRounds: Array.isArray(snapshot.channelRounds) ? snapshot.channelRounds : [],
  runs: Array.isArray(snapshot.runs) ? snapshot.runs : [],
  runItems: Array.isArray(snapshot.runItems) ? snapshot.runItems : [],
  approvals: Array.isArray(snapshot.approvals) ? snapshot.approvals : [],
  subagents: Array.isArray(snapshot.subagents) ? snapshot.subagents : [],
});
