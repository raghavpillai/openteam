import type { AgentSession, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  ComputerTurnRequest,
  PiModelRef,
  PiReasoningLevel,
  PluginDynamicNamespace,
  SubagentType,
} from "@openteam/contracts";
import type { BotMessage } from "../bot-compaction";
import type { ComputerEventQueue } from "../computer-event-queue";
import type { DynamicToolDefinition } from "../dynamic-tool-gateway";
import type { TaskConfiguration } from "@openteam/contracts/task-configuration";

export type TurnStatus = "completed" | "failed" | "interrupted" | "cancelled";

export interface ActiveTurn {
  taskConfiguration?: TaskConfiguration;
  /** A connected Mac had Messages turned on when the turn started, so the Messages tools are offered. */
  messagesAvailable?: boolean;
  pluginRuntimePackages?: readonly import("@openteam/plugin-sdk").PluginRuntimePackage[];
  pluginAbortController?: AbortController;
  closePluginSession?: () => Promise<void>;
  readOnly?: boolean;
  runId: string;
  botId: string;
  contextSessionId: string;
  screenBotId: string;
  conversationId: string;
  channelId: string;
  deliveryId: string | null;
  runtimeProfile: "agent" | "subagent";
  subagentType: SubagentType | null;
  modelRef: PiModelRef;
  reasoning: PiReasoningLevel;
  cwd: string;
  instructions: string;
  userInfoMessage: BotMessage | null;
  isRootProject?: boolean;
  compactionEarlyThreshold?: number;
  compactionUsageSignature?: string;
  compactionRequestMessages?: BotMessage[];
  /** Canonical persisted history; Pi may remove retry failures only from memory. */
  compactionReadPiMessages?: () => BotMessage[];
  pendingCompactionMeasurement?: { compactionId: string; epoch: number };
  todoUpdate: string | null;
  resetSelfSummaryCount: boolean;
  requestSource: NonNullable<ComputerTurnRequest["requestSource"]>;
  turnId: string;
  session: AgentSession | null;
  sessionPath: string | null;
  sessionAttached: boolean;
  queue: ComputerEventQueue;
  unsubscribe: (() => void) | null;
  assistantOrdinal: number;
  currentAssistantId: string | null;
  currentReasoningId: string | null;
  startedItems: Set<string>;
  toolArgs: Map<string, { toolName: string; args: unknown; responseCall?: boolean }>;
  lastStopReason: string | null;
  lastErrorMessage: string | null;
  lastGraphicalSurface?: "browser" | "computer";
  sentMessageCount: number;
  /** SendToUser calls of a response go out one after another, in call order. */
  sendChain?: Promise<unknown>;
  initialUserStarted: boolean;
  initialUserClientId?: string;
  pluginNamespaces: readonly PluginDynamicNamespace[];
  attachmentTempDirectories: string[];
  lastPromptFingerprint?: string;
  connectorInstructions?: string;
  endTurnRequested?: boolean;
  /** Unexecuted calls of the latest assistant response; each may run once after its closing send. */
  pendingResponseCalls?: Map<string, string>;
  /** A closing send, closing reaction, or question ended the turn; the rest of its response still runs. */
  finishResponseCalls?: boolean;
  /** Calls of the latest assistant response that started, each settled once its result is final. */
  responseCallEnds?: Map<string, { ended: Promise<void>; settle: () => void }>;
  /** Calls of the latest assistant response that failed. */
  failedResponseCalls?: string[];
  /** SendToUser calls of the latest assistant response that failed. */
  failedResponseSends?: Set<string>;
  /** This turn showed a question or handed the box back; it waits on the user and is never held open. */
  awaitingUser?: boolean;
  /** The closing send or reaction; a hold's reminder rides on its result. */
  endTurnCallId?: string;
  endTurnHolds?: number;
  acknowledgedCardOutcomes?: Set<string>;
  /** computerUse only: failure classes of the current run of failed calls. */
  toolFailureStreak?: string[];
  toolFailureBreakerTripped?: boolean;
  lastAgentMessage?: { id: string; text: string };
  outputLimitReminded?: boolean;
  /** The low-disk episode this main-agent turn tells the bot about, and whether it went out. */
  diskPressureEpisode?: string | null;
  diskPressureReminded?: boolean;
  /** A typed message superseded this run; calls it cut off say so. */
  interruptedByUserAt?: number;
  /** Stopped through the cancel-run API (the user's stop or StopSubagent): the turn settles as cancelled. */
  stopped?: boolean;
}

export interface RuntimeDynamicTool extends DynamicToolDefinition {
  execute: (
    active: ActiveTurn,
    callId: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}

export interface RuntimeImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type RuntimeDynamicToolCaller = (
  active: ActiveTurn,
  callId: string,
  tool: string,
  args: unknown,
  signal?: AbortSignal
) => Promise<AgentToolResult<Record<string, unknown>>>;
