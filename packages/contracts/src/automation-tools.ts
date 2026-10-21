/** Automation runs hand communication to their parent: these tools reach the user or the
 * chat, or add plugins and accounts that need the user's sign-in. */
export const AUTOMATION_PARENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "SendToUser",
  "ReactToMessage",
  "SendToAgent",
  "request_box_help",
  "RequestUserForm",
  "RemapUserFormTargets",
  "DraftExternalMessage",
  "CreateBotShareJson",
  "InstallPlugin",
  "AddMcpServer",
  "AuthenticateMcpServer",
]);

/** What a routine run hears when it calls one of those tools. */
export const AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED =
  "Automation runs cannot mutate the visible transcript. Continue autonomously when the result can wait; if the saved instruction requires user-visible communication, use WakeParent because a normal final response does not wake the parent or reach the user. If an old instruction names SendMessage or SendToUser, those tools are deprecated and unavailable here: do not discover or retry them; pass the complete payload or handoff to WakeParent.";
