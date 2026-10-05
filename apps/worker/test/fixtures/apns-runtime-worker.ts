import { createInterface } from "node:readline";
import { verify } from "node:crypto";
import { createPrismaClient } from "@openteam/db";
import { ApnsSettingsStore } from "@openteam/db/apns-settings";
import { ApnsClient } from "../../src/apns";

const prisma = createPrismaClient();
const settings = new ApnsSettingsStore(prisma);
let publicKey = "";
let result: unknown;
const client = new ApnsClient(
  async () => (await settings.load()).config,
  async (authority, headers) => {
    const jwt = headers.authorization!.slice(7).split(".");
    result = {
      pid: process.pid,
      keyId: JSON.parse(Buffer.from(jwt[0]!, "base64url").toString()).kid,
      teamId: JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss,
      topic: headers["apns-topic"],
      authority,
      verified: verify(
        "sha256",
        Buffer.from(jwt.slice(0, 2).join(".")),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(jwt[2]!, "base64url")
      ),
    };
    return { status: 200 };
  }
);
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.stop) break;
  publicKey = input.publicKey;
  try {
    await client.send(
      {
        pushToken: "a".repeat(64),
        apnsTopic: input.topic,
        apnsEnvironment: "production",
        notificationScope: "b".repeat(64),
      },
      {
        schemaVersion: 1,
        kind: "message",
        title: "Runtime configuration test",
        body: "Test",
        channelId: "test",
        botId: "test",
        runId: "test",
        deepLink: "openteam:///chat/test",
        badgeCount: 1,
        messageSequence: "1",
        notificationSequence: "1",
      },
      1,
      "test"
    );
    console.log(JSON.stringify(result));
  } catch {
    console.log(JSON.stringify({ failed: true, pid: process.pid }));
  }
}
client.close();
await prisma.$disconnect();
