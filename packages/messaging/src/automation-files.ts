import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@openbot/db";
import {
  fileTimes,
  jsonFile,
  listDirectories,
  readText,
  uniqueSlug,
  atomicWrite,
} from "./file-state";
import { nextRoutineRun, normalizeRoutineSchedule } from "./routines";

const MAX_AUTOMATION_NAME = 80;
const MAX_AUTOMATION_PROMPT = 240_000;
const MAX_GROUP_TRIGGERS = 8;
const EVENT_TYPES = new Set([
  "slack",
  "github",
  "origin",
  "microsoftTeams",
  "linear",
  "sentry",
  "pagerduty",
  "webhook",
]);
const ORIGIN_EXCLUSIONS = new Set(["microsoftTeams", "linear", "sentry", "pagerduty", "webhook"]);

export interface AutomationRun {
  id: string;
  trigger: "schedule" | "manual" | "event";
  startedAt: number;
  finishedAt?: number | null;
  status: "ok" | "error" | "running";
  [key: string]: unknown;
}

export interface ParsedAutomation {
  name: string;
  prompt: string;
  trigger: Record<string, unknown>;
  triggerPresentation: Record<string, unknown> | null;
  schedule: ReturnType<typeof normalizeRoutineSchedule> | null;
  enabled: boolean;
  provenance: "user" | "untrusted";
  createdAt: Date;
  lastRunAt: Date | null;
  pendingNotices: Prisma.InputJsonValue;
  raisedNotices: Prisma.InputJsonValue;
  runs: AutomationRun[];
  nextRunAt: Date | null;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const required = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return text;
};

const finiteMilliseconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const validateTrigger = (input: unknown): Record<string, unknown> => {
  if (Array.isArray(input)) {
    if (input.length === 0 || input.length > MAX_GROUP_TRIGGERS)
      throw new Error(`group trigger must contain 1-${MAX_GROUP_TRIGGERS} listeners`);
    const listeners = input.map(validateTrigger);
    if (listeners.some((listener) => listener.type === "group"))
      throw new Error("group triggers may not contain another group");
    return listeners.length === 1 ? listeners[0]! : validateTriggerGroup(listeners);
  }
  const trigger = object(input, "trigger");
  const type = required(trigger.type, "trigger.type", 80);
  if (type === "cron") {
    return {
      ...trigger,
      type,
      schedule: required(trigger.schedule, "trigger.schedule", 500),
    };
  }
  if (type === "group") {
    const rawListeners = trigger.listeners ?? trigger.triggers;
    if (
      !Array.isArray(rawListeners) ||
      rawListeners.length === 0 ||
      rawListeners.length > MAX_GROUP_TRIGGERS
    ) {
      throw new Error(`group trigger must contain 1-${MAX_GROUP_TRIGGERS} listeners`);
    }
    const listeners = rawListeners.map(validateTrigger);
    if (listeners.some((listener) => listener.type === "group"))
      throw new Error("group triggers may not contain another group");
    return listeners.length === 1 ? listeners[0]! : validateTriggerGroup(listeners);
  }
  if (!EVENT_TYPES.has(type)) throw new Error(`unsupported automation trigger type: ${type}`);
  return { ...trigger, type };
};

const validateTriggerGroup = (
  listeners: Array<Record<string, unknown>>
): Record<string, unknown> => {
  const types = new Set(listeners.map((entry) => entry.type));
  if (
    types.has("origin") &&
    [...types].some((candidate) => ORIGIN_EXCLUSIONS.has(String(candidate)))
  ) {
    throw new Error(
      "origin cannot be grouped with Teams, Linear, Sentry, PagerDuty, or webhook triggers"
    );
  }
  return { type: "group", listeners };
};

const firstCronSchedule = (trigger: Record<string, unknown>): string | null => {
  if (trigger.type === "cron" && typeof trigger.schedule === "string") return trigger.schedule;
  if (trigger.type !== "group" || !Array.isArray(trigger.listeners)) return null;
  const cron = trigger.listeners.find(
    (listener) =>
      Boolean(listener) &&
      typeof listener === "object" &&
      !Array.isArray(listener) &&
      (listener as { type?: unknown }).type === "cron"
  ) as { schedule?: unknown } | undefined;
  return typeof cron?.schedule === "string" ? cron.schedule : null;
};

export const parseAutomationRuns = (text: string | null): AutomationRun[] => {
  if (text === null) return [];
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("runs.json must contain an array");
  const result: AutomationRun[] = [];
  for (const entry of parsed) {
    const run = object(entry, "run");
    const finishedAt =
      run.finishedAt === undefined || run.finishedAt === null
        ? run.finishedAt
        : finiteMilliseconds(run.finishedAt);
    if (
      typeof run.id !== "string" ||
      !run.id ||
      finiteMilliseconds(run.startedAt) === null ||
      (run.finishedAt !== undefined && run.finishedAt !== null && finishedAt === null)
    ) {
      throw new Error("runs.json contains an invalid run");
    }
    if (run.requestId !== undefined && typeof run.requestId !== "string")
      throw new Error("runs.json requestId must be a string");
    if (run.detail !== undefined && (typeof run.detail !== "string" || run.detail.length > 300))
      throw new Error("runs.json detail must be at most 300 characters");
    if (
      run.coalescedRunIds !== undefined &&
      (!Array.isArray(run.coalescedRunIds) ||
        run.coalescedRunIds.length > 25 ||
        run.coalescedRunIds.some((id) => typeof id !== "string"))
    )
      throw new Error("runs.json coalescedRunIds must contain at most 25 strings");
    result.push({
      ...run,
      trigger: ["schedule", "manual", "event"].includes(String(run.trigger))
        ? (run.trigger as AutomationRun["trigger"])
        : "schedule",
      status: ["ok", "error", "running"].includes(String(run.status))
        ? (run.status as AutomationRun["status"])
        : "ok",
    } as AutomationRun);
  }
  return result.sort((left, right) => left.startedAt - right.startedAt).slice(-20);
};

export const parseAutomationFile = async (
  automationPath: string,
  text: string,
  installationZone: string
): Promise<ParsedAutomation> => {
  const value = object(JSON.parse(text), "automation.json");
  const name = required(value.name, "automation name", MAX_AUTOMATION_NAME);
  const prompt = required(value.prompt, "automation prompt", MAX_AUTOMATION_PROMPT);
  let trigger: Record<string, unknown>;
  try {
    trigger = validateTrigger(value.trigger);
  } catch (triggerError) {
    if (typeof value.schedule !== "string" || !value.schedule.trim()) throw triggerError;
    trigger = validateTrigger({
      type: "cron",
      schedule: required(value.schedule, "schedule", 500),
    });
  }
  const cronSchedule = firstCronSchedule(trigger);
  const schedule =
    cronSchedule !== null
      ? normalizeRoutineSchedule(cronSchedule, installationZone, {
          enforceMinimum: process.env.OPENBOT_ENFORCE_AUTOMATION_MINIMUM === "true",
        })
      : null;
  const triggerPresentation =
    value.triggerPresentation === undefined || value.triggerPresentation === null
      ? null
      : object(value.triggerPresentation, "triggerPresentation");
  if (triggerPresentation && triggerPresentation.version !== 1) {
    throw new Error("triggerPresentation.version must be 1");
  }
  const enabled = value.enabled !== false;
  const provenance = value.provenance === "user" ? "user" : "untrusted";
  const times = await fileTimes(automationPath);
  const fileCreatedAt = Math.min(times.birthtimeMs || times.mtimeMs, times.mtimeMs);
  const suppliedCreatedAt = finiteMilliseconds(value.createdAt);
  const createdAt = new Date(Math.min(suppliedCreatedAt ?? fileCreatedAt, fileCreatedAt));
  const lastRunMs = finiteMilliseconds(value.lastRunAt);
  const lastRunAt = lastRunMs === null ? null : new Date(lastRunMs);
  const pendingNotices = (
    Array.isArray(value.pendingNotices) ? value.pendingNotices : []
  ) as Prisma.InputJsonValue;
  const raisedNotices = (
    Array.isArray(value.raisedNotices) ? value.raisedNotices : []
  ) as Prisma.InputJsonValue;
  const runs = parseAutomationRuns(
    await readText(join(automationPath, "..", "runs.json"), 1_000_000)
  );
  const anchor = lastRunAt ?? createdAt;
  return {
    name,
    prompt,
    trigger,
    triggerPresentation,
    schedule,
    enabled,
    provenance,
    createdAt,
    lastRunAt,
    pendingNotices,
    raisedNotices,
    runs,
    nextRunAt: enabled && schedule ? nextRoutineRun(schedule, anchor) : null,
  };
};

export const renderAutomationFile = (routine: {
  name: string;
  prompt: string;
  trigger: Prisma.JsonValue;
  triggerPresentation: Prisma.JsonValue | null;
  scheduleText: string;
  enabled: boolean;
  provenance: string;
  createdAt: Date;
  lastRunAt: Date | null;
  pendingNotices: Prisma.JsonValue;
  raisedNotices: Prisma.JsonValue;
}): string => {
  const trigger = routine.trigger as Record<string, unknown>;
  const cron = trigger?.type === "cron";
  const groupCron =
    trigger?.type === "group" && Array.isArray(trigger.listeners)
      ? trigger.listeners.find(
          (candidate) =>
            Boolean(candidate) &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as { type?: unknown }).type === "cron"
        )
      : undefined;
  const groupSchedule =
    groupCron && typeof (groupCron as { schedule?: unknown }).schedule === "string"
      ? String((groupCron as { schedule: string }).schedule)
      : null;
  return jsonFile({
    name: routine.name,
    prompt: routine.prompt,
    ...(cron
      ? { schedule: routine.scheduleText }
      : {
          trigger,
          ...(groupSchedule ? { schedule: groupSchedule } : {}),
        }),
    ...(routine.triggerPresentation ? { triggerPresentation: routine.triggerPresentation } : {}),
    enabled: routine.enabled,
    provenance: routine.provenance === "user" ? "user" : "untrusted",
    createdAt: routine.createdAt.getTime(),
    lastRunAt: routine.lastRunAt?.getTime() ?? null,
    ...(Array.isArray(routine.pendingNotices) && routine.pendingNotices.length > 0
      ? { pendingNotices: routine.pendingNotices }
      : {}),
    ...(Array.isArray(routine.raisedNotices) && routine.raisedNotices.length > 0
      ? { raisedNotices: routine.raisedNotices }
      : {}),
  });
};

export const renderRunsFile = (runs: unknown): string => jsonFile(Array.isArray(runs) ? runs : []);

export const writeAutomationFiles = async (
  botDirectory: string,
  input: Parameters<typeof renderAutomationFile>[0] & {
    slug?: string;
    runLedger?: unknown;
  }
): Promise<{ slug: string; directory: string }> => {
  const root = join(botDirectory, "automations");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const occupied = new Set(await listDirectories(root));
  const slug = input.slug ?? uniqueSlug(input.name, "automation", occupied);
  const directory = join(root, slug);
  await atomicWrite(join(directory, "automation.json"), renderAutomationFile(input));
  await atomicWrite(join(directory, "runs.json"), renderRunsFile(input.runLedger ?? []));
  return { slug, directory };
};

export const deleteAutomationFolder = async (botDirectory: string, slug: string): Promise<void> => {
  await rm(join(botDirectory, "automations", slug), {
    recursive: true,
    force: true,
  });
};
