import { runInteractiveSession } from "../../src/interactive-session";
import { connectionFixture, authView } from "./provider-connection";
const mode = process.argv[2];
const f = connectionFixture(mode === "key" ? "api_key" : "oauth", 30);
if (mode === "slow")
  f.api.start = () => new Promise((resolve) => setTimeout(() => resolve(authView()), 300));
if (mode === "missing")
  f.api.importLogin = async () => {
    throw new Error("No reusable Claude Code login found. Choose Browser sign-in.");
  };
try {
  const result = await runInteractiveSession(f.session);
  console.log(result === "connected" ? "CONNECTED: CONTINUE TO MODELS" : "BACK TO PROVIDERS");
  console.log("REMOTE CANCELLATIONS: " + f.calls.cancel.length);
  console.log("SUBMITTED VALUES: " + f.calls.responses.length);
} finally {
  await f.session.dispose();
}
