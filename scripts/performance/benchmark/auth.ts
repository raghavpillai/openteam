import { createHash } from "node:crypto";

type Arm = {
  label: "disabled" | "required";
  baseUrl: string;
  headers?: HeadersInit;
};

type Sample = {
  bytes: number;
  elapsedMs: number;
  sha256: string;
};

const integerSetting = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const requiredSetting = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, "");
const disabledBaseUrl = normalizeBaseUrl(
  process.env.OPENTEAM_AUTH_DISABLED_BASE_URL ?? "http://127.0.0.1:8877"
);
const requiredBaseUrl = normalizeBaseUrl(
  process.env.OPENTEAM_AUTH_REQUIRED_BASE_URL ?? "http://127.0.0.1:8878"
);
const username = requiredSetting("OPENTEAM_AUTH_USERNAME");
const password = requiredSetting("OPENTEAM_AUTH_PASSWORD");
const warmupCount = integerSetting("OPENTEAM_AUTH_WARMUPS", 10);
const sampleCount = Math.max(1, integerSetting("OPENTEAM_AUTH_SAMPLES", 100));
const targetPath = "/api/v0/client-runtime";

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
};

const summarize = (values: number[]) => ({
  min: Math.min(...values),
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
  mean: values.reduce((total, value) => total + value, 0) / values.length,
});

const assertMode = async (baseUrl: string, expected: Arm["label"]): Promise<void> => {
  const response = await fetch(`${baseUrl}/api/auth/config`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${baseUrl}/api/auth/config returned ${response.status}`);
  }
  const body = (await response.json()) as { mode?: unknown };
  if (body.mode !== expected) {
    throw new Error(`${baseUrl} reported auth mode ${String(body.mode)}; expected ${expected}`);
  }
};

const login = async (): Promise<string> => {
  const response = await fetch(`${requiredBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, rememberMe: true }),
  });
  if (!response.ok) {
    throw new Error(`Required-mode login returned ${response.status}: ${await response.text()}`);
  }
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("Required-mode login did not return set-auth-token");
  return token;
};

const request = async (arm: Arm): Promise<Sample> => {
  const startedAt = performance.now();
  const response = await fetch(`${arm.baseUrl}${targetPath}`, {
    cache: "no-store",
    headers: arm.headers,
  });
  const body = Buffer.from(await response.arrayBuffer());
  const elapsedMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(
      `${arm.label} ${targetPath} returned ${response.status}: ${body.toString("utf8")}`
    );
  }
  return {
    bytes: body.byteLength,
    elapsedMs,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
};

await Promise.all([
  assertMode(disabledBaseUrl, "disabled"),
  assertMode(requiredBaseUrl, "required"),
]);
const token = await login();
const arms: [Arm, Arm] = [
  { label: "disabled", baseUrl: disabledBaseUrl },
  {
    label: "required",
    baseUrl: requiredBaseUrl,
    headers: { authorization: `Bearer ${token}` },
  },
];

for (let index = 0; index < warmupCount; index += 1) {
  for (const arm of index % 2 === 0 ? arms : [...arms].reverse()) await request(arm);
}

const samplesByArm = new Map<Arm["label"], Sample[]>([
  ["disabled", []],
  ["required", []],
]);
for (let index = 0; index < sampleCount; index += 1) {
  for (const arm of index % 2 === 0 ? arms : [...arms].reverse()) {
    samplesByArm.get(arm.label)?.push(await request(arm));
  }
}

const results = arms.map((arm) => {
  const samples = samplesByArm.get(arm.label) ?? [];
  return {
    label: arm.label,
    baseUrl: arm.baseUrl,
    bytes: [...new Set(samples.map((sample) => sample.bytes))],
    sha256: [...new Set(samples.map((sample) => sample.sha256))],
    endToEndMs: summarize(samples.map((sample) => sample.elapsedMs)),
  };
});
const disabled = results[0];
const required = results[1];
if (
  disabled.bytes.length !== 1 ||
  required.bytes.length !== 1 ||
  disabled.sha256.length !== 1 ||
  required.sha256.length !== 1 ||
  disabled.bytes[0] !== required.bytes[0] ||
  disabled.sha256[0] !== required.sha256[0]
) {
  throw new Error("Disabled and required auth arms returned different protected responses");
}

const output = JSON.stringify(
  {
    measuredAt: new Date().toISOString(),
    targetPath,
    sampleCount,
    warmupCount,
    requestOrder: "alternating",
    responseParity: {
      bytes: disabled.bytes[0],
      sha256: disabled.sha256[0],
      exact: true,
    },
    results,
    requiredModeOverheadMs: {
      p50: required.endToEndMs.p50 - disabled.endToEndMs.p50,
      p95: required.endToEndMs.p95 - disabled.endToEndMs.p95,
      mean: required.endToEndMs.mean - disabled.endToEndMs.mean,
    },
  },
  null,
  2
);
if (process.env.OPENTEAM_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENTEAM_AUDIT_OUTPUT, `${output}\n`);
}
console.log(output);
