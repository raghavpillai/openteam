const DEFAULT_AGENT_UID = 1001;
const DEFAULT_AGENT_GID = 1000;

const numericIdentity = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export interface AgentProcessIdentity {
  uid?: number;
  gid?: number;
}

export const agentProcessIdentity = (): AgentProcessIdentity => {
  if (process.getuid?.() !== 0) return {};
  return {
    uid: numericIdentity(process.env.OPENBOT_AGENT_UID, DEFAULT_AGENT_UID),
    gid: numericIdentity(process.env.OPENBOT_AGENT_GID, DEFAULT_AGENT_GID),
  };
};

const ALWAYS_PRIVATE_ENVIRONMENT_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "BASH_ENV",
  "DATABASE_URL",
  "ENV",
  "NODE_OPTIONS",
  "OPENBOT_PI_AGENT_DIR",
  "PYTHONSTARTUP",
  "RUBYOPT",
]);

const SECRET_ENVIRONMENT_KEY =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)(?:$|_)/i;

export const sanitizedAgentEnvironment = (
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...source, ...overrides };
  for (const key of Object.keys(environment)) {
    if (ALWAYS_PRIVATE_ENVIRONMENT_KEYS.has(key) || SECRET_ENVIRONMENT_KEY.test(key)) {
      delete environment[key];
    }
  }
  return environment;
};
