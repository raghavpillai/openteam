import type { DoctorCheck } from "./doctor";
import type { ComposeProject } from "./docker";

// Only aggregate state leaves the server. Never return device tokens, session
// identifiers, message payloads, or arbitrary provider error text.
export const NOTIFICATION_STATE_PROBE = String.raw`
const sql = new Bun.SQL(process.env.DATABASE_URL, { max: 1, connectionTimeout: 4 });
try {
  await sql.unsafe("SET statement_timeout = '4000ms'");
  const auth = process.env.OPENTEAM_AUTH_MODE?.trim().toLowerCase() === "disabled"
    ? 'NOT d."authRequired"' : 'd."authRequired" AND s."expiresAt" > now()';
  const [devices] = await sql.unsafe('WITH devices AS (SELECT d.*, (d.enabled AND (' + auth + ')) IS TRUE AS eligible FROM "PushDevice" d LEFT JOIN "session" s ON s.id = d."authSessionId" WHERE d.provider = \'apns\' AND d.platform = \'ios\') SELECT count(*)::int AS total, count(*) FILTER (WHERE eligible)::int AS eligible, count(*) FILTER (WHERE eligible AND ("apnsTopic" IS NULL OR "apnsEnvironment" IS NULL OR "apnsEnvironment" NOT IN (\'production\', \'development\') OR "notificationScope" IS NULL OR "notificationScope" = \'\' OR "pushToken" !~ \'^([a-fA-F0-9]{2}){32,100}$\'))::int AS invalid, coalesce(json_agg(DISTINCT "apnsTopic") FILTER (WHERE eligible AND "apnsTopic" IS NOT NULL), \'[]\') AS topics FROM devices');
  const [delivery] = await sql.unsafe('SELECT count(*) FILTER (WHERE (o.status = \'failed\' OR o.error IS NOT NULL) AND o."updatedAt" > now() - interval \'24 hours\')::int AS failed, count(*) FILTER (WHERE o.status = \'pending\' AND o."availableAt" < now() - interval \'5 minutes\')::int AS waiting FROM "OutboxDelivery" o JOIN "PushDevice" d ON d.id::text = o.target WHERE o.topic = \'push.notification\' AND d.provider = \'apns\'');
  console.log(JSON.stringify({ ...devices, ...delivery }));
} finally { await sql.close({ timeout: 1 }); }
`;

export const APNS_CONFIGURATION_PROBE = String.raw`
const { createPrivateKey, sign } = require("node:crypto");
const { readFileSync } = require("node:fs");
const keyID = process.env.OPENTEAM_APNS_KEY_ID?.trim();
const teamID = process.env.OPENTEAM_APNS_TEAM_ID?.trim();
const topic = process.env.OPENTEAM_APNS_TOPIC?.trim() || "dev.openteam.mobile.swift";
let privateKey = process.env.OPENTEAM_APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
let issue = null;
if (!privateKey && process.env.OPENTEAM_APNS_PRIVATE_KEY_FILE) {
  try { privateKey = readFileSync(process.env.OPENTEAM_APNS_PRIVATE_KEY_FILE, "utf8"); }
  catch { issue = "key-file"; }
}
const missing = [];
if (!keyID) missing.push("OPENTEAM_APNS_KEY_ID");
if (!teamID) missing.push("OPENTEAM_APNS_TEAM_ID");
if (!privateKey && !issue) missing.push("OPENTEAM_APNS_PRIVATE_KEY");
if (!issue && !missing.length) {
  if (!/^[A-Z0-9]{10}$/.test(keyID) || !/^[A-Z0-9]{10}$/.test(teamID)) issue = "identifiers";
  else if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(topic)) issue = "topic";
  else {
    try {
      const key = createPrivateKey(privateKey);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
      sign("sha256", Buffer.from("OpenTeam Doctor signing check"), { key, dsaEncoding: "ieee-p1363" });
    } catch { issue = "signing-key"; }
  }
}
console.log(JSON.stringify({ missing, issue, topic }));
`;

interface NotificationState {
  total: number;
  eligible: number;
  invalid: number;
  topics: string[];
  failed: number;
  waiting: number;
}
interface ApnsConfiguration {
  missing: string[];
  issue: string | null;
  topic: string;
}

const missingKeys = ["OPENTEAM_APNS_KEY_ID", "OPENTEAM_APNS_TEAM_ID", "OPENTEAM_APNS_PRIVATE_KEY"];
const issues = ["key-file", "identifiers", "topic", "signing-key"];
const stateIsValid = (value: NotificationState): boolean =>
  value != null &&
  [value.total, value.eligible, value.invalid, value.failed, value.waiting].every(
    (count) => Number.isSafeInteger(count) && count >= 0
  ) &&
  value.invalid <= value.eligible &&
  value.eligible <= value.total &&
  Array.isArray(value.topics) &&
  value.topics.every((topic) => typeof topic === "string");
const configIsValid = (value: ApnsConfiguration): boolean =>
  value != null &&
  Array.isArray(value.missing) &&
  value.missing.every((key) => missingKeys.includes(key)) &&
  (value.issue === null || issues.includes(value.issue)) &&
  typeof value.topic === "string";

export const notificationChecks = (
  state: NotificationState | null,
  config: ApnsConfiguration | null
): DoctorCheck[] => {
  const checks: DoctorCheck[] = [
    {
      label: "iOS push registration",
      level: !state ? "fail" : state.invalid ? "fail" : state.eligible ? "pass" : "warn",
      detail: !state
        ? "Could not inspect device registrations; check database access and schema setup."
        : state.invalid
          ? `${state.invalid} eligible iOS registration(s) have incomplete APNs metadata.`
          : state.eligible
            ? `${state.eligible} iOS device(s) enabled with valid authentication for this server.`
            : state.total
              ? "No eligible iOS devices; saved registrations are disabled or have no valid login session."
              : "No iOS push registration on this server; open the iPhone app and enable Notifications.",
    },
  ];
  const problem = !config
    ? "Could not inspect APNs configuration in the running worker."
    : config.issue === "key-file"
      ? "The worker cannot read its APNs signing-key file."
      : config.missing.length
        ? `Missing in the running worker: ${config.missing.join(", ")}.`
        : config.issue === "identifiers"
          ? "APNs key ID and team ID must each contain 10 uppercase letters or digits."
          : config.issue === "topic"
            ? "OPENTEAM_APNS_TOPIC is not a valid app bundle ID."
            : config.issue === "signing-key"
              ? "The APNs signing key must be a valid P-256 .p8 private key."
              : state?.topics.some((topic) => topic !== config.topic)
                ? "The worker's OPENTEAM_APNS_TOPIC does not match a registered iOS app bundle ID."
                : null;
  checks.push({
    label: "iOS push credentials",
    level: problem
      ? !config || config.issue || !config.missing.length || (state?.eligible ?? 0) > 0
        ? "fail"
        : "warn"
      : "pass",
    detail:
      problem ??
      "Worker credentials and P-256 signing key are valid locally; Apple acceptance and a visible phone alert are not verified.",
  });
  checks.push({
    label: "iOS push delivery",
    level: !state || state.failed ? "fail" : state.waiting || !state.eligible ? "warn" : "pass",
    detail: !state
      ? "Could not inspect push delivery records; check database access and schema setup."
      : state.failed
        ? `${state.failed} iOS push delivery error(s) recorded in the last 24 hours; inspect openteam logs worker.`
        : state.waiting
          ? `${state.waiting} pending iOS push(es) are overdue by more than 5 minutes.`
          : "No recent recorded iOS push errors or overdue pending pushes. A delivered outbox status can include skipped alerts; it does not prove phone delivery.",
  });
  return checks;
};

export const runNotificationChecks = (
  project: ComposeProject,
  runningServices: ReadonlySet<string>
): DoctorCheck[] => {
  const probe = <T>(service: string, script: string, valid: (value: T) => boolean): T | null => {
    if (!runningServices.has(service)) return null;
    try {
      const result = project.run(
        [
          "exec",
          "--no-TTY",
          service,
          service === "worker" ? "node" : "bun",
          "-e",
          `(async () => {${script}})().catch(() => process.exitCode = 1)`,
        ],
        { timeoutMs: 15_000 }
      );
      if (result.status !== 0) return null;
      const value = JSON.parse(result.stdout);
      return valid(value) ? value : null;
    } catch {
      return null;
    }
  };
  const checks = notificationChecks(
    probe("server", NOTIFICATION_STATE_PROBE, stateIsValid),
    probe("worker", APNS_CONFIGURATION_PROBE, configIsValid)
  );
  return checks.map((check) => {
    const service = check.label === "iOS push credentials" ? "worker" : "server";
    return !runningServices.has(service)
      ? { ...check, level: "warn", detail: `Not tested; ${service} is not running` }
      : check;
  });
};
