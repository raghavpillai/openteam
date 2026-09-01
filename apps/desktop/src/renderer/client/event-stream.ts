import {
  createLiveSyncController,
  type LiveSyncControllerOptions,
  shouldRefreshForEvent,
} from "@openbot/client-core";
import { openBotClient } from "./openbot-api";

export { shouldRefreshForEvent };

export const createDesktopLiveSyncController = (
  options: Omit<LiveSyncControllerOptions, "listen">
) =>
  createLiveSyncController({
    ...options,
    listen: (cursor, eventHandlers, signal) =>
      openBotClient.listenForEvents(cursor, eventHandlers, signal),
  });
