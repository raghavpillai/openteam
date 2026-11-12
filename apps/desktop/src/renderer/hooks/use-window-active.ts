import { useSyncExternalStore } from "react";
import { isWindowActive, isWindowVisible, subscribeWindowActivity, subscribeWindowVisibility } from "../lib/window-visibility";

export const useWindowActive = () =>
  useSyncExternalStore(subscribeWindowActivity, isWindowActive, () => true);

export const useWindowVisible = () =>
  useSyncExternalStore(subscribeWindowVisibility, isWindowVisible, () => true);
