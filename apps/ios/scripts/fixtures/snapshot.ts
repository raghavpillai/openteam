import type { ClientSnapshot } from "@openteam/contracts";
import bootstrap from "../../Tests/CoreTests/Fixtures/bootstrap.json";

/** Synthetic Research, Ops and Build Bots with their direct chats. The rows are the Swift core
 * tests' `client-bootstrap` fixture, so native, desktop and benchmark fixtures stay identical. */
export const mobileFixture = {
  cursor: "fixture-14",
  workspace: { root: "/workspace", sharedDirectory: "/workspace/shared", botsDirectory: "/workspace/bots" },
  bots: bootstrap.bots,
  channels: bootstrap.channels,
  channelMessages: bootstrap.latestMessages,
  channelRounds: [],
  runs: bootstrap.activeRuns,
  runItems: [],
  subagents: [],
  runtime: bootstrap.runtime,
} as unknown as ClientSnapshot;
