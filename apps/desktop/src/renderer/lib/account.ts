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
  const name = user.name.trim() || accountName(user);
  const words = name.split(/\s+/u);
  const initials =
    words.length > 1
      ? `${Array.from(words[0]!)[0]}${Array.from(words.at(-1)!)[0]}`.toLocaleUpperCase()
      : Array.from(name.toLocaleUpperCase()).slice(0, 2).join("");
  const detail = "Username and password";
  return {
    name,
    detail,
    initials,
    copyValue: user.username?.trim() || null,
  };
};
