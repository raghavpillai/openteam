import { startHostBridgeDiscovery } from "../../apps/computer/src/computer-network-host-bridge";

const watcher = startHostBridgeDiscovery("http://127.0.0.1:8787", {
  intervalMs: 50,
  helper: "/tmp/computer-network.py",
});
const timer = setInterval(() => {}, 1000);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    watcher.stop();
    clearInterval(timer);
  });
}
