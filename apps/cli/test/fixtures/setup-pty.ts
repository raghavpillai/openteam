import { createEnvironment, parseEnvironment } from "../../src/config";
import { runSetupSession } from "../../src/setup-session";
import { SETUP_STAGES } from "../../src/setup-values";
const result = await runSetupSession({
  version: "1.2.3",
  stages: SETUP_STAGES,
  current: parseEnvironment(createEnvironment({ version: "1.2.3" })),
  authenticated: false,
  fresh: true,
  detectedLogins: [],
});
if (result !== null) throw new Error("Expected cancellation without configuration");
console.log("Setup cancelled without changes.");
