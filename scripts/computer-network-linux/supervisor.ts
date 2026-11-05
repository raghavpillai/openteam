import { startBrowserNetwork } from "../../apps/computer/src/browser-network";
import { writeFileSync } from "node:fs";

// Exercises the production supervisor/worker lifecycle in an isolated computer.
const network = await startBrowserNetwork(
  process.env.FIXTURE_SERVER!,
  "integration-not-a-credential"
);
const status = setInterval(
  () => writeFileSync("/run/network-supervisor.json", JSON.stringify(network.status())),
  100
);
const shutdown = async () => {
  clearInterval(status);
  await network.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.on("SIGUSR1", () => {
  void network
    .egress()
    .then((result) => writeFileSync("/run/network-egress.json", JSON.stringify(result)))
    .catch(() => writeFileSync("/run/network-egress.json", JSON.stringify({ error: true })));
});
