import { expect, test } from "bun:test";
import { GoogleApi } from "../_shared/google";

test("Google API errors surface actionable messages and redact tokens", async () => {
  const api = new GoogleApi("https://www.googleapis.com", "secret-token", async () =>
    Response.json({ error: { message: "Denied secret-token" } }, { status: 403 })
  );
  await expect(api.request("/drive/v3/files")).rejects.toThrow("Google API 403: Denied [redacted]");
});
