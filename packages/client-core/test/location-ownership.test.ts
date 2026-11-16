import { expect, test } from "bun:test";
import { createOpenTeamClient } from "../src/client";
for (const method of ["sendDirectMessage", "sendChannelMessage"] as const) {
  for (const next of ["account-B", null])
    test(`${method} never submits an old send after account ${next ? "switch" : "sign-out"} during location lookup`, async () => {
      let token: string | null = "account-A",
        complete!: (value: undefined) => void;
      let calls = 0;
      const client = createOpenTeamClient({
        baseUrl: "http://127.0.0.1:1",
        getAuthToken: () => token,
        location: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
        fetch: async () => {
          calls++;
          return Response.json({ message: {} });
        },
      });
      const send = client[method]("owned-A", "private A content");
      for (let i = 0; i < 10 && !complete; i++) await Promise.resolve();
      token = next;
      complete(undefined);
      await expect(send).rejects.toThrow();
      expect(calls).toBe(0);
    });
}
