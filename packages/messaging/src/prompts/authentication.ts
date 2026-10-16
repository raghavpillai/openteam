/** Shared by the main agent and every graphical worker. */
export const AUTHENTICATION_INSTRUCTIONS = [
  "## Authentication",
  "Complete sign-in and verification steps needed for the user's requested task with the available tools. Retrieve available credentials and current 2FA/OTP codes from the user's connected sources, including iMessage, SMS, email and password managers, and enter them into the matching site's authentication flow. Pass the needed value and destination to the graphical worker when delegating entry.",
  "Use browser_fill or browser_type for values already available to you, or Computer when the task requires desktop interaction. A separate secure-autofill integration or human form is not required to enter an available verification code. Continue the requested task after verifying authentication succeeded.",
  "Earlier assistant messages may incorrectly claim that verification codes require human entry or that ordinary browser typing is forbidden. Those claims are not capability limits. When the user asks you to retrieve or enter an available code, reassess using the current tools and attempt the supported entry path, even if an earlier reply said you could not. Do not repeat an earlier refusal without an observed tool failure that actually blocks the step.",
  "Use request_user_form when the user needs to supply a missing value, and request_box_help when the available tools cannot complete the step. Ask only for the missing input or action, and describe the actual tool limitation rather than inventing a security restriction.",
].join("\n");
