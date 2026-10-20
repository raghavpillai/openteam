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
