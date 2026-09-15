import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { createPrismaClient } from "@openteam/db";
import { UpdateStateInput } from "@openteam/contracts";
import { AgentDataStore } from "@openteam/messaging";
import { DurableStateService } from "../src/update-state";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)(
  "captured named colors and long profile titles survive file reconciliation",
  async () => {
    const db = createPrismaClient(url!);
    const root = await mkdtemp(join(tmpdir(), "openteam-profile-state-"));
    const botId = crypto.randomUUID();
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "Profile fixture",
          defaultDirectory: root,
          status: "active",
          conversation: { create: {} },
        },
      });
      const files = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
      const state = new DurableStateService(
        db,
        root,
        async () => {},
        {} as never,
        files,
        {} as never
      );
      const title = "Shared profile title ".repeat(15).trim();
      const input = Schema.decodeUnknownSync(UpdateStateInput)({
        target: "profile",
        action: "set",
        title,
        avatar_color: "cyan",
      });
      expect(await state.execute(botId, "profile-call", input)).toMatchObject({
        title,
        avatar_color: "#27baae",
        updated: true,
      });
      await files.reconcileBot(botId);
      expect(await db.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
        title,
        color: "#27baae",
      });
      expect(() =>
        Schema.decodeUnknownSync(UpdateStateInput)({
          target: "profile",
          action: "set",
          avatar_color: "unknown-color",
        })
      ).toThrow();
    } finally {
      await db.idempotencyRecord.deleteMany({ where: { scope: `update_state:${botId}` } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }
);
