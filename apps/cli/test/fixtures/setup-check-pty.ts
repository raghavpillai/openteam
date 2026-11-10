import { createEnvironment, parseEnvironment } from "../../src/config";
import { runSetupSession } from "../../src/setup-session";
import { SETUP_STAGES } from "../../src/setup-values";

// The first start attempt hits a busy port; the second succeeds with the same answers.
const attempts: string[] = [];
const result = await runSetupSession({
  version: "1.2.3",
  stages: SETUP_STAGES,
  current: parseEnvironment(createEnvironment({ version: "1.2.3" })),
  ownerConfigured: true,
  currentOwnerUsername: "existing.owner",
  check: async (configuration) => {
    attempts.push(configuration.apiPort);
    return attempts.length === 1
      ? "OpenTeam cannot start because port 8787 is already in use by another process on this machine."
      : null;
  },
});
console.log(`Applied ${JSON.stringify({ attempts, apiPort: result?.apiPort })}`);
