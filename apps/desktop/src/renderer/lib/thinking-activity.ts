import type { RunItemView } from "@openteam/contracts";
import { botActivityKind, type BotActivityKind } from "@openteam/product-core/bot-avatar";

const ACTIVITY_LABELS: Readonly<Record<BotActivityKind, string>> = {
  thinking: "Thinking",
  typing: "Typing",
  searching: "Searching the web",
  "reading-web": "Reading the web",
  browsing: "Browsing the web",
  "reading-file": "Reading file",
  "running-commands": "Running commands",
  "waiting-command": "Waiting on a command",
  "waiting-you": "Waiting for you",
  connecting: "Connecting to an app",
  computer: "On its computer",
  messaging: "Sending a message",
  delegating: "Waiting on another Bot",
  generating: "Generating a photo",
  drafting: "Drafting the file",
  organizing: "Organizing context",
  working: "Working",
};

/** Project only active runtime items; never display tool arguments or reasoning text. */
export function thinkingActivity(items: readonly RunItemView[] = []): string {
  return ACTIVITY_LABELS[botActivityKind(items)];
}

export type HeldActivity = { text: string; since: number; previous: string | null };
/** Coalesce rapid updates to the newest caption, without restarting equal captions. */
export function advanceActivity(
  current: HeldActivity,
  text: string,
  now: number,
  hold: number
): HeldActivity {
  return text === current.text || now - current.since < hold
    ? current
    : { text, since: now, previous: current.text };
}
export function activityElapsedLabel(since: number, now: number): string | null {
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
