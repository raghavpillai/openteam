import type { PrismaClient } from "@openteam/db";
import { definitionFromManifest } from "./plugin/values";

/** The reference's connectorDraftCard reminder, appended to the connector result. */
export const connectorDraftCardReminder = (mailbox: string) =>
  `\n\n<system_reminder>\nThis saved a draft in the user's ${mailbox} mailbox. If it is for a file you are about to attach with UploadFile, or the user asked you to save the draft in their mailbox, carry on. Otherwise the user expects the in-app draft card: show the same message with DraftExternalMessage, and tell the user a ${mailbox} draft was also saved. Leave that draft as it is.\n</system_reminder>`;

/**
 * A mailbox create_draft is not the review card the user expects. When the calling agent can
 * post DraftExternalMessage cards and the connector's drafts are reviewed email, a successful
 * create_draft carries the reminder.
 */
export async function withConnectorDraftCardReminder(
  prisma: Pick<PrismaClient, "pluginConnection">,
  call: { connectionId: string; toolName: string },
  draftCardAvailable: boolean,
  result: unknown
): Promise<unknown> {
  if (!draftCardAvailable || call.toolName !== "create_draft") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const value = result as { isError?: unknown; content?: unknown };
  if (value.isError || !Array.isArray(value.content)) return result;
  const connection = await prisma.pluginConnection.findUnique({
    where: { id: call.connectionId },
    select: { connectorKey: true, installation: { select: { name: true, manifest: true } } },
  });
  const connector = definitionFromManifest(connection?.installation.manifest)?.connections.find(
    (candidate) => candidate.key === connection?.connectorKey
  );
  if (!connection || connector?.drafts?.platform !== "email") return result;
  const mailbox = connector.name || connection.installation.name;
  return { ...value, content: [...value.content, { type: "text", text: connectorDraftCardReminder(mailbox) }] };
}
