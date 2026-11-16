export interface MentionOption {
  id: string;
  label: string;
  handle: string;
  color?: string;
  icon?: string;
  hasAvatar?: boolean;
  updatedAt?: string;
  trigger?: "@" | "/";
  kind?: "bot" | "connection" | "skill";
  status?: string;
}

export const mentionHandleFor = (label: string): string =>
  label.trim().replace(/\s+/g, "").toLocaleLowerCase("en-US");
