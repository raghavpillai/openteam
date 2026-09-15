import type { OpenTeamAuthMode, OpenTeamAuthUser } from "../client/auth";
import { accountInitials, accountName } from "@openteam/client-core/account";

export interface AccountPresentation {
  name: string;
  detail: string;
  initials: string;
  copyValue: string | null;
}

export const accountPresentation = (
  user: OpenTeamAuthUser | null,
  mode: OpenTeamAuthMode
): AccountPresentation => {
  if (!user) {
    return {
      name: accountName(null),
      detail: mode === "disabled" ? "No sign-in required" : "Account settings",
      initials: accountInitials(null),
      copyValue: null,
    };
  }
  const name = accountName(user);
  const detail = "Username and password";
  return {
    name,
    detail,
    initials: accountInitials(user),
    copyValue: user.username?.trim() || null,
  };
};
