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

export type TurnStatus = "completed" | "failed" | "interrupted";

export interface ActiveTurn {
  runtimeStartedAt?: number;
  taskConfiguration?: TaskConfiguration;
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
  automationTrigger: string | null;
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
  toolArgs: Map<string, { toolName: string; args: unknown; deliveryCleanup?: boolean }>;
  lastStopReason: string | null;
  lastErrorMessage: string | null;
  lastGraphicalSurface?: "browser" | "computer";
  sentMessageCount: number;
  toolActivityAfterLastSend: boolean;
  initialUserStarted: boolean;
  initialUserClientId?: string;
  pendingSteers: Array<{
    inboxId: string;
    clientMessageId: string;
    content: string;
  }>;
  acceptedSteerIds: Set<string>;
  discoveredDynamicTools: Set<string>;
  /** Exact projection sent to the current model call, before result fencing. */
  dynamicDiscoveryMessages?: readonly BotMessage[];
  pluginNamespaces: readonly PluginDynamicNamespace[];
  attachmentTempDirectories: string[];
  lastPromptFingerprint?: string;
  connectorInstructions?: string;
  endTurnRequested?: boolean;
  /** Remaining attachment calls from the already-produced assistant response. */
  pendingDeliveryAttachments?: Map<string, string>;
  finishDeliveryAttachments?: boolean;
  /** Exact stop calls already emitted alongside a closing response. */
  pendingDeliveryCleanup?: Map<string, string>;
  acknowledgedCardOutcomes?: Set<string>;
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
