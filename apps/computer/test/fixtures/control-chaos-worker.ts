import { createInterface } from "node:readline";
import { ScreenBroker } from "../../src/screen-broker";
import type { ScreenSession } from "../../src/screen/types";
const broker = new ScreenBroker(process.argv[2]!);
Object.assign(broker, {
  startSession: async (s: ScreenSession) => {
    s.state = "ready";
    s.lastHealthCheckAt = Date.now();
  },
});
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  try {
    if (request.preparePause)
      Object.assign(broker, {
        interruptAgentInput: async () => {
          output({ event: "prepared" });
          await Bun.sleep(30000);
        },
      });
    const status =
      request.op === "status"
        ? await broker.status("bot", "/workspace")
        : await broker.takeover("bot", "/workspace", request.active, request.control);
    if (request.commitPause) {
      output({ event: "committed", control: status.controlSession });
      await Bun.sleep(30000);
    }
    output({
      id: request.id,
      control: status.controlSession,
      human: status.humanTakeover,
      pending: status.controlPending,
    });
  } catch (error) {
    output({ id: request.id, error: String(error) });
  }
}
