import { createPrismaClient } from "@openbot/db/client";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { bearer, username } from "better-auth/plugins";

const secret = process.env.OPENBOT_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET;

if (!secret || secret.length < 32) {
  throw new Error("OPENBOT_AUTH_SECRET must contain at least 32 characters");
}

export const authPrisma = createPrismaClient();

export const auth = betterAuth({
  appName: "OpenBot",
  secret,
  baseURL: process.env.OPENBOT_AUTH_URL || "http://127.0.0.1:8787",
  basePath: "/api/auth",
  database: prismaAdapter(authPrisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  disabledPaths: [
    "/sign-up/email",
    "/sign-in/email",
    "/request-password-reset",
    "/reset-password",
    "/change-password",
    "/set-password",
    "/change-email",
    "/delete-user",
    "/update-user",
    "/is-username-available",
  ],
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      displayUsername: false,
    }),
    bearer({ requireSignature: true }),
  ],
});

export type OpenBotSession = typeof auth.$Infer.Session;
