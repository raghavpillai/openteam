import { ApiError, AssetRef, type ChannelLibraryPage } from "@openteam/contracts";
import { Prisma, type PrismaClient } from "@openteam/db";
import { Option, Schema } from "effect";
import { serviceEffect } from "./service-utils";

const decodeAttachment = Schema.decodeUnknownOption(AssetRef);

const PAGE_SIZE = 50;
type LibraryRow = {
  messageId: string;
  sequence: bigint;
  ordinal: bigint;
  attachment: unknown;
  createdAt: Date;
};

export const parseLibraryCursor = (cursor: string | null) => {
  if (cursor === null) return null;
  const match = /^(\d{1,19})\.(\d{1,6})$/.exec(cursor);
  if (
    !match ||
    BigInt(match[1]!) > 9223372036854775807n ||
    BigInt(match[1]!) < 1n ||
    Number(match[2]) < 1
  )
    throw new ApiError(400, "invalid_library_cursor", "Invalid Library page cursor");
  return { sequence: BigInt(match[1]!), ordinal: BigInt(match[2]!) };
};

export class ChannelLibraryService {
  constructor(private readonly prisma: PrismaClient) {}

  list = (channelId: string, cursor: string | null = null) =>
    serviceEffect(async (): Promise<ChannelLibraryPage> => {
      const before = parseLibraryCursor(cursor);
      const channel = await this.prisma.channel.findFirst({
        where: {
          id: channelId,
          archivedAt: null,
          members: {
            some: { bot: { status: { not: "archived" }, subagentIdentity: { is: null } } },
          },
        },
        select: { id: true },
      });
      if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");
      // Keyset pagination reads the whole conversation, independently of the
      // bounded transcript retained by a client. Each attachment has its own key.
      const rows = await this.prisma.$queryRaw<LibraryRow[]>(Prisma.sql`
      SELECT message."id" AS "messageId", message."sequence", asset.ordinality AS ordinal,
             asset.value AS attachment, message."createdAt"
      FROM "ChannelMessage" AS message
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(message.metadata->'attachments') = 'array'
             THEN message.metadata->'attachments' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS asset(value, ordinality)
      WHERE message."channelId" = ${channelId}::uuid AND message.sender = 'agent'
        ${before ? Prisma.sql`AND (message."sequence", asset.ordinality) < (${before.sequence}, ${before.ordinal})` : Prisma.empty}
      ORDER BY message."sequence" DESC, asset.ordinality DESC
      LIMIT ${PAGE_SIZE + 1}
    `);
      const page = rows.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      return {
        items: page.flatMap((row) => {
          const attachment = Option.getOrNull(decodeAttachment(row.attachment));
          return attachment
            ? [
                {
                  id: attachment.assetId,
                  messageId: row.messageId,
                  attachment,
                  createdAt: row.createdAt.toISOString(),
                },
              ]
            : [];
        }),
        // Advance past malformed old metadata too, so it cannot trap a client.
        nextCursor: rows.length > PAGE_SIZE && last ? `${last.sequence}.${last.ordinal}` : null,
      };
    });
}
