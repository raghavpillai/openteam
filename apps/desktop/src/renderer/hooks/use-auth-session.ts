import { useSyncExternalStore } from "react";
import { getAuthSnapshot, type OpenTeamAuthSnapshot, subscribeAuthSnapshot } from "../client/auth";

export const useAuthSession = (): OpenTeamAuthSnapshot =>
  useSyncExternalStore(subscribeAuthSnapshot, getAuthSnapshot, getAuthSnapshot);
