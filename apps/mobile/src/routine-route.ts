export const routineIdFromPathname = (pathname: string): string | null => {
  const match = /^\/routine\/[^/]+\/([^/?#]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

export const routineRoute = (channelId: string, routineId: string) => ({
  pathname: "/routine/[channelId]/[routineId]" as const,
  params: { channelId, routineId },
});

const pendingKey = "__openteamPendingRoutineNavigation";

type RoutineNavigationGlobal = typeof globalThis & {
  [pendingKey]?: { channelId: string; routineId: string };
};

const navigationGlobal = globalThis as RoutineNavigationGlobal;

export const stageRoutineNavigation = (channelId: string, routineId: string) => {
  navigationGlobal[pendingKey] = { channelId, routineId };
};

export const pendingRoutineId = (channelId: string): string | null => {
  const pending = navigationGlobal[pendingKey];
  return pending?.channelId === channelId ? pending.routineId : null;
};

export const clearRoutineNavigation = (channelId: string, routineId: string) => {
  const pending = navigationGlobal[pendingKey];
  if (pending?.channelId === channelId && pending.routineId === routineId) {
    delete navigationGlobal[pendingKey];
  }
};
