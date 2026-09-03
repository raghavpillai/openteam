import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { authPrisma } from "./auth";

export type OwnerCredentialOperation = "setup" | "update" | "reset";

export interface OwnerCredentialInput {
  operation: OwnerCredentialOperation;
  username?: string;
  password?: string;
}

const validUsername = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Username is required");
  const username = value.trim().toLowerCase();
  if (username.length < 3 || username.length > 30 || !/^[a-z0-9_.]+$/.test(username)) {
    throw new Error(
      "Username must be 3-30 characters and use only letters, numbers, underscores, or dots"
    );
  }
  return username;
};

const validPassword = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new Error("Password must be between 8 and 128 characters");
  }
  return value;
};

export const setOwnerCredentials = async (
  input: OwnerCredentialInput
): Promise<{ username: string }> => {
  const existing = await authPrisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if ((input.operation === "reset" || input.operation === "update") && !existing) {
    throw new Error("OpenTeam owner credentials have not been set up yet");
  }
  if (
    input.operation === "update" &&
    input.username === undefined &&
    input.password === undefined
  ) {
    throw new Error("Owner credential update requires a username or password");
  }
  const username =
    input.operation === "setup" || input.username !== undefined
      ? validUsername(input.username)
      : validUsername(existing?.username);
  const password =
    input.operation === "setup" || input.operation === "reset" || input.password !== undefined
      ? validPassword(input.password)
      : undefined;
  const userId = existing?.id ?? randomUUID();
  const passwordHash = password === undefined ? undefined : await hashPassword(password);

  await authPrisma.$transaction(async (database) => {
    // A credential change invalidates every previously issued session.
    await database.session.deleteMany();
    await database.verification.deleteMany();

    if (existing) {
      await database.user.update({
        where: { id: userId },
        data: {
          name: username,
          username,
          email: `${username}@openteam.invalid`,
          emailVerified: true,
        },
      });
      await database.user.deleteMany({ where: { id: { not: userId } } });
    } else {
      await database.user.create({
        data: {
          id: userId,
          name: username,
          username,
          email: `${username}@openteam.invalid`,
          emailVerified: true,
        },
      });
    }

    if (passwordHash !== undefined) {
      await database.account.deleteMany();
      await database.account.create({
        data: {
          id: randomUUID(),
          issuer: "local:credential",
          accountId: userId,
          providerId: "credential",
          userId,
          password: passwordHash,
        },
      });
    }
  });

  return { username };
};

export const runOwnerCredentialCommand = async (): Promise<void> => {
  let input: OwnerCredentialInput;
  try {
    input = JSON.parse(await Bun.stdin.text()) as OwnerCredentialInput;
  } catch {
    throw new Error("Owner credential command expects JSON on stdin");
  }
  if (input.operation !== "setup" && input.operation !== "update" && input.operation !== "reset") {
    throw new Error("Owner credential operation must be setup, update, or reset");
  }
  const result = await setOwnerCredentials(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};
