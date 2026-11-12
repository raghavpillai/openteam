// Delivery states, retries and late echoes for sent messages in the chat and thread UI.
import { runAndPrint } from "../test/browser/run-electron-fixture";

await runAndPrint({
  name: "send-lifecycle",
  runner: "message-send-lifecycle-runner.cjs",
  page: "message-send-lifecycle.html",
  env: (dir, url) => ({
    SEND_LIFECYCLE_DIR: dir,
    SEND_LIFECYCLE_URL: url,
  }),
  timeoutMs: 90_000,
});
