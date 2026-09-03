import {
  createLiveSyncController,
  type LiveSyncControllerOptions,
  shouldRefreshForEvent,
} from "@openteam/client-core";
import { openTeamClient } from "./openteam-api";

export { shouldRefreshForEvent };

export const createDesktopLiveSyncController = (
  options: Omit<LiveSyncControllerOptions, "listen">
) =>
  createLiveSyncController({
    ...options,
    listen: (cursor, eventHandlers, signal) =>
      openTeamClient.listenForEvents(cursor, eventHandlers, signal),
  });
