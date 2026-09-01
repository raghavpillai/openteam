export type AuthMode = "required" | "disabled";

export const parseAuthMode = (value: string | undefined): AuthMode => {
  if (value === undefined) return "required";
  if (value === "required" || value === "disabled") return value;

  throw new Error('OPENBOT_AUTH_MODE must be either "required" or "disabled"');
};
