import type { OpenTeamAuthMode, OpenTeamAuthUser } from "../client/auth";

export interface AccountPresentation {
  name: string;
  detail: string;
  initials: string;
  copyValue: string | null;
}

const initialsFor = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "OB";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() || "OB";
  return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase() || "OB";
};

export const accountPresentation = (
  user: OpenTeamAuthUser | null,
  mode: OpenTeamAuthMode
): AccountPresentation => {
  if (!user) {
    return {
      name: "OpenTeam owner",
      detail: mode === "disabled" ? "Authentication disabled" : "Signed in",
      initials: "OB",
      copyValue: null,
    };
  }
  const name = user.name || user.username || user.email || "OpenTeam owner";
  const detail = user.username ? `@${user.username}` : user.email;
  return {
    name,
    detail,
    initials: initialsFor(name),
    copyValue: user.username ?? user.email ?? null,
  };
};
