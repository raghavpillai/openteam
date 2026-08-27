import type { ScreenStatusView } from "@openbot/contracts";

export function enableScreenForSession(current: ReadonlySet<string>, botId: string) {
  if (current.has(botId)) return current;
  const next = new Set(current);
  next.add(botId);
  return next;
}

export function shouldLoadScreenStatus(enabled: boolean, inspectorActive: boolean) {
  return enabled && inspectorActive;
}

export function shouldPollScreenStatus(
  enabled: boolean,
  inspectorActive: boolean,
  state: ScreenStatusView["state"] | undefined
) {
  return enabled && inspectorActive && state !== "ready";
}

export function shouldRefreshScreenFrame({
  enabled,
  inspectorActive,
  documentVisible,
  viewerOpen,
  state,
}: {
  enabled: boolean;
  inspectorActive: boolean;
  documentVisible: boolean;
  viewerOpen: boolean;
  state: ScreenStatusView["state"] | undefined;
}) {
  return enabled && inspectorActive && documentVisible && !viewerOpen && state === "ready";
}
