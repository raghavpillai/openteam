import { useSyncExternalStore } from "react";
import { getAuthSnapshot, type OpenBotAuthSnapshot, subscribeAuthSnapshot } from "../client/auth";

export const useAuthSession = (): OpenBotAuthSnapshot =>
  useSyncExternalStore(subscribeAuthSnapshot, getAuthSnapshot, getAuthSnapshot);
