export const DESKTOP_MESSAGES_TOOLS = [
  "FindContacts",
  "FindIMessageChats",
  "ChatItems",
  "SearchIMessages",
  "IMessageActivity",
  "FetchIMessageAttachment",
  "SendIMessage",
  "CheckIMessagePermissions",
] as const;

/** Every Messages tool can name the Mac it runs on; the server picks one when it is omitted. */
export const MESSAGES_MACHINE_ID_DESCRIPTION =
  "The Mac to use: a machineId from ListMachines whose `messages` is not `off`. Omit it to use the Mac the user's latest message came from, or the only connected Mac with Messages turned on.";
