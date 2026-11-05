import { useSyncExternalStore } from "react";
import { isWindowActive, subscribeWindowActivity } from "../lib/window-visibility";

export const useWindowActive = () =>
  useSyncExternalStore(subscribeWindowActivity, isWindowActive, () => true);
