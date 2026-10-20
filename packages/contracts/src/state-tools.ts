import type { UpdateStateInput } from "./index";

/** Which durable-state target each state tool changes through the shared handler. */
export const STATE_TOOL_TARGETS = {
  UpdateMemory: "memory",
  UpdateRoutine: "routine",
  UpdateSkill: "skill",
  UpdateProfile: "profile",
  UpdateAvatar: "avatar",
  DisconnectChannel: "channel",
  UpdateProject: "project",
} as const satisfies Record<string, UpdateStateInput["target"]>;

export type StateToolName = keyof typeof STATE_TOOL_TARGETS;

export const isStateTool = (name: string): name is StateToolName =>
  Object.hasOwn(STATE_TOOL_TARGETS, name);
