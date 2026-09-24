import { expect, test } from "bun:test";
import { Effect } from "effect";
import { BotService } from "../src/services/bot-service";

test("direct bot service rejects blank names before touching database or files", async () => {
  const service = new BotService({} as never, {} as never, "/unused", async () => { throw new Error("unexpected computer call"); }, {} as never);
  for (const name of ["", "  ", "\t\n", "\u00a0"]) {
    const result = await Effect.runPromise(Effect.either(service.update("fixture", { name })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({ status: 400, code: "invalid_bot_name" });
  }
});
