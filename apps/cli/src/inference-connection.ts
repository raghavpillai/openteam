import { redactSensitiveText } from "@openteam/product-core/redaction";
import type { ComposeProject } from "./docker";
import type { RuntimeInferenceSettings } from "./runtime-settings";

const INFERENCE_TIMEOUT_MS = 30_000;

// Run inside the server so this follows its computer URL and network path. Provider
// credentials stay in the computer; the control token never leaves the container.
const PROBE_SCRIPT = String.raw`
let result;
try {
  const input = JSON.parse(await Bun.stdin.text());
  const token = process.env.OPENTEAM_CONTROL_TOKEN;
  if (!token) throw new Error("The server control token is missing");
  const url = new URL("/v1/infer", process.env.OPENTEAM_COMPUTER_URL ?? "http://127.0.0.1:8790");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(input.timeoutMs + 5000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new Error("HTTP " + response.status + (typeof detail === "string" ? ": " + detail : ""));
  }
  if (typeof body?.text !== "string" || !body.text.trim()) {
    throw new Error("The model returned no text");
  }
  result = { ok: true };
} catch (error) {
  result = {
    ok: false,
    error: error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "The model connection test timed out"
      : error instanceof Error ? error.message : String(error),
  };
}
await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + "\n", error => error ? reject(error) : resolve()));
`;

export const checkInferenceConnection = (
  project: ComposeProject,
  settings: RuntimeInferenceSettings
): { ok: boolean; detail: string } => {
  const model = `${settings.providerId}/${settings.modelId}`;
  const started = Date.now();
  const result = project.run(["exec", "--no-TTY", "server", "bun", "-e", PROBE_SCRIPT], {
    input: JSON.stringify({
      kind: "verification",
      instructions: "This is a connection test. Reply with only OK.",
      prompt: "Reply OK.",
      timeoutMs: INFERENCE_TIMEOUT_MS,
      model,
      reasoning: settings.reasoning,
    }),
    timeoutMs: INFERENCE_TIMEOUT_MS + 10_000,
  });
  let error: string;
  if (result.status !== 0) {
    error =
      result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
        ? "The model connection test timed out"
        : result.stderr.trim() || result.error?.message || "Could not run the connection test";
  } else {
    let response: { ok?: unknown; error?: unknown } | null = null;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      // Do not print unstructured command output, which may contain credentials.
    }
    if (response?.ok === true) {
      return {
        ok: true,
        detail: `${model} responded in ${((Date.now() - started) / 1_000).toFixed(1)}s (thinking ${settings.reasoning})`,
      };
    }
    error =
      typeof response?.error === "string" && response.error.trim()
        ? response.error
        : "The connection test returned an invalid result";
  }
  return { ok: false, detail: redactSensitiveText(`${model}: ${error}`).slice(0, 1_000) };
};
