import { join } from "node:path";
import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "reaction-order",
  runner: "reaction-order-runner.cjs",
  page: "reaction-order.html",
  env: (dir, url) => ({
    REACTION_TEST_PROFILE: join(dir, "profile"),
    REACTION_TEST_OUTPUT: join(dir, "results.json"),
    REACTION_TEST_URL: url,
  }),
  timeoutMs: 60_000,
});
