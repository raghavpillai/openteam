import { expect, test } from "bun:test";
import { isUpdateBusyMessage, stillWorking, updateBusyMessage, serverUpdateProgress } from "../src/server-updates";

test("progress follows actual host milestones, including recovery and unknown phases", () => {
  expect(["checking", "downloading", "pulling", "backing-up", "restarting", "verifying", "updating-cli", "complete"].map(phase=>serverUpdateProgress(phase).step)).toEqual([0,1,1,2,3,4,4,5]);
  expect(serverUpdateProgress("backing-up").title).toBe("Protecting your data");
  expect(serverUpdateProgress("rolling-back")).toEqual({step:null,title:"Restoring the previous version",rollingBack:true});
  expect(serverUpdateProgress("future-phase").step).toBeNull();
});

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
