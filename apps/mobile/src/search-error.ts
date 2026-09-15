import { networkFailureMessage } from "./network-error";

export const searchFailureMessage = (cause: unknown): string => {
  return networkFailureMessage(cause) ?? "Search couldn't be completed. Try again.";
};
