import type { OpenTeamAuthUser } from "./auth";

/** Account chrome is identified by the login username on every client. */
export const accountName = (user: OpenTeamAuthUser | null): string =>
  user?.username?.trim() || user?.name?.trim() || "Account";

export const accountInitials = (user: OpenTeamAuthUser | null): string => {
  const username = user?.username?.trim() || user?.name?.trim();
  return username ? Array.from(username.toLocaleUpperCase()).slice(0, 2).join("") : "OT";
};
