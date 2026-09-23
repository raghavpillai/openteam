export type BotCompactionReason =
  | "approaching_token_limit"
  | "approaching_image_limit"
  | "fallback_on_limit_error"
  | "input_token_limit_error"
  | "pending_summary_adopted"
  | "significantly_over_token_limit"
  | "self_summary_completed";

export interface BotMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  providerOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BotSummaryUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface BotSummaryResult {
  text: string;
  usage?: BotSummaryUsage;
  generation?: {
    completedAt: string;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface BotCompactionMetrics {
  generationCompletedAt: string;
  generationDurationMs: number;
  summaryInputTokens: number | null;
  summaryOutputTokens: number | null;
  retainedTailMessages: number;
  estimatedRetainedTailTokens: number;
  tokensAfterSource: "estimate";
}

export interface BotSummaryRetryDirective {
  retry: boolean;
  delay: boolean;
  reduceInputs: boolean;
  shorter: boolean;
}

export interface BotArchiveRecord {
  id: string;
  sequence: number;
  reason: BotCompactionReason;
  prefixDigest: string;
  summaryDigest: string;
  summaryBlob: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
  imageCount: number;
  turnCount: number;
  startedAt: string;
  completedAt: string;
}

export interface BotArchiveBlob {
  version: 1;
  id: string;
  sequence: number;
  reason: BotCompactionReason;
  summary: string;
  prefixDigest: string;
  summaryDigest: string;
  piBaseMessageCount: number;
  userInfoMessage: BotMessage | null;
  lastUserMessage: BotMessage;
  preservedTailMessages: BotMessage[];
  durableBlocks?: string[];
  summarizedMessages?: BotMessage[];
  selfSummaryCount: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  imageCount: number;
  turnCount: number;
  usage: BotSummaryUsage | null;
  metrics?: BotCompactionMetrics;
  startedAt: string;
  completedAt: string;
}

export type BotArchiveCommitInput = Omit<
  BotArchiveBlob,
  "version" | "sequence" | "selfSummaryCount" | "summaryDigest"
>;

export type BotArchiveIntentInput = Omit<BotArchiveCommitInput, "piBaseMessageCount">;

export interface BotArchiveIntent {
  version: 1;
  contextSessionId: string;
  archive: BotArchiveIntentInput;
}

export interface BotArchiveManifest {
  version: 1;
  epoch: number;
  selfSummaryCount: number;
  latestArchiveId: string | null;
  archives: BotArchiveRecord[];
}

export interface BotCompactionEvent extends BotArchiveRecord {
  contextSessionId: string;
  compactionId: string;
  epoch: number;
  metrics?: BotCompactionMetrics;
}

export interface BotPartition {
  userInfoMessage: BotMessage | null;
  lastUserMessage: BotMessage;
  messagesToSummarize: BotMessage[];
}

export interface BotSummaryRequest {
  systemPrompt: string;
  userInfoMessage: BotMessage | null;
  messagesToSummarize: BotMessage[];
  shorter: boolean;
  tools?: readonly BotSummaryTool[];
}

export interface BotSummaryTool {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: unknown;
}
