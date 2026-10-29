import { expect, test } from "bun:test";
import { isUpdateBusyMessage, stillWorking, updateBusyMessage } from "../src/server-updates";

test("an update refused for working bots names them", () => {
  expect(updateBusyMessage(["Orion"])).toBe("Orion is still working. Nothing changed; try again when it's done.");
  expect(updateBusyMessage(["Orion", "Nova"])).toBe(
    "Orion and Nova are still working. Nothing changed; try again when they're done."
  );
  expect(stillWorking(["Scout", "Orion", "Nova"])).toBe("Scout, Orion and Nova are still working");
  expect(updateBusyMessage(["", " "])).toBe("An agent is still working. Nothing changed; try again when it's done.");
});

test("the refusal is told apart from a failed update", () => {
  expect(isUpdateBusyMessage(updateBusyMessage(["Orion", "Nova"]))).toBe(true);
  expect(isUpdateBusyMessage("Could not download https://example.test/SHA256SUMS (HTTP 404)")).toBe(false);
  expect(isUpdateBusyMessage(null)).toBe(false);
});
