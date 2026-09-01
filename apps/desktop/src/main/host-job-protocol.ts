export interface HostReadInput {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

export interface HostShellInput {
  command?: unknown;
  working_directory?: unknown;
  block_until_ms?: unknown;
}

export type HostJobPayload =
  | { kind: "read"; input: HostReadInput }
  | { kind: "shell"; input: HostShellInput; terminalDir: string };

export interface HostJobRequest {
  type: "run";
  id: string;
  payload: HostJobPayload;
}

export interface HostJobCancel {
  type: "cancel";
  id: string;
}

export interface HostUtilityShutdown {
  type: "shutdown";
}

export type HostUtilityRequest = HostJobRequest | HostJobCancel | HostUtilityShutdown;

export type HostJobResponse =
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string };
