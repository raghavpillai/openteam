import { expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { ScreenService } from "../src/services/screen-service";
import { formPreparationFailureMessage } from "@openteam/contracts";

const service = (body: unknown) => new ScreenService({ bot: { findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace" }) } } as unknown as PrismaClient,
  "/data", "localhost", async () => Response.json(body, { status: 400 }));

test("preparation returns allowlisted reasons and discards all raw driver text", async () => {
  const error = await service({ error: "form_preflight_failed", failureKinds: ["target_unavailable", "SECRET-246810", "__proto__"], message: "SECRET-246810" })
    .userFormAction("bot", "form", "prepare", {}).catch(error => error);
  expect(error.code).toBe("form_preflight_failed");
  expect(error.message).toContain("enabled editable");
  expect(error.message).not.toContain("SECRET-246810");
  expect(formPreparationFailureMessage({ error: "form_preflight_failed", failureKinds: ["__proto__", "SECRET-246810"] })).toBeUndefined();
});

test("submit failures never pass even allowlisted preparation diagnostics through", async () => {
  const error = await service({ error: "form_preflight_failed", failureKinds: ["target_missing"], message: "SECRET-246810" })
    .userFormAction("bot", "form", "submit", {}).catch(error => error);
  expect(error.code).toBe("form_host_unavailable");
  expect(error.message).not.toContain("SECRET-246810");
  expect(error.message).not.toContain("ambiguous");
});
