import {
  createLiveSyncController,
  type LiveSyncControllerOptions,
  shouldRefreshForEvent,
} from "@openteam/client-core";
import { openTeamClient } from "./openteam-api";
import { refreshMemoryViews } from "../lib/memory-events";

export { shouldRefreshForEvent };

export const createDesktopLiveSyncController = (
  options: Omit<LiveSyncControllerOptions, "listen">
) =>
  createLiveSyncController({
    ...options,
    listen: (cursor, eventHandlers, signal) =>
      openTeamClient.listenForEvents(cursor, {
        ...eventHandlers,
        onOpen: () => { eventHandlers.onOpen?.(); refreshMemoryViews(); },
        onEvent: (event) => {
          if (event.topic === "notification.presence.changed") window.dispatchEvent(new Event("openteam:notification-preferences-changed"));
          eventHandlers.onEvent(event); refreshMemoryViews(event);
        },
      }, signal),
  });
