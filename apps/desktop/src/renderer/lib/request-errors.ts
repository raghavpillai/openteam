import { OpenTeamClientError } from "@openteam/client-core";
import { clientErrorMessage, redactSensitiveText } from "@openteam/product-core/redaction";

/** How long setup waits for an ordinary request before saying so and offering a retry. */
export const REQUEST_DEADLINE_MS = 20_000;
/**
 * How long setup waits for the real model test. The server gives the model 60 s and
 * itself 15 s more (settings-service.ts), so this is a little longer than that.
 */
export const MODEL_TEST_DEADLINE_MS = 90_000;

export const OFFLINE_MESSAGE = "Couldn't reach your server. Check your connection and try again.";
export const TIMEOUT_MESSAGE =
  "Your server didn't answer in time. Check that it's running and try again.";

/**
 * Runs a request with a deadline. When it passes, the request is cancelled and the promise
 * rejects with a timeout, so a silent server becomes a message instead of a spinner.
 */
export function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms = REQUEST_DEADLINE_MS
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OpenTeamClientError(TIMEOUT_MESSAGE, "timeout"));
      controller.abort();
    }, ms);
  });
  return Promise.race([run(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

const failure = (cause: unknown) =>
  (cause && typeof cause === "object" ? cause : {}) as {
    code?: unknown;
    status?: unknown;
    name?: unknown;
  };

// What fetch reports, in each engine, when the connection fails or drops.
const NETWORK_FAILURE =
  /^(?:failed to fetch|fetch failed|load failed|network ?error|networkerror when attempting to fetch resource|network request failed|the network connection was lost|the internet connection appears to be offline)\.?$/i;
const TIMED_OUT =
  /^(?:the operation was aborted due to timeout|the operation timed out|signal timed out)\.?$/i;

// Words meant for people: no JSON and no bare "Request failed (503)".
const readable = (text: string | null | undefined): text is string =>
  typeof text === "string" &&
  text.length > 0 &&
  !/[{}[\]]/.test(text) &&
  !/^Request failed \(\d+\)$/.test(text) &&
  text !== "OpenTeam returned an invalid response";

const plainMessage = (cause: unknown) =>
  clientErrorMessage(cause, "")
    .replace(/^[A-Za-z]*Error:\s*/, "")
    .trim();

/** Whether a request failed because its deadline passed. */
export const timedOut = (cause: unknown): boolean => {
  const error = failure(cause);
  return (
    error.code === "timeout" || error.name === "TimeoutError" || TIMED_OUT.test(plainMessage(cause))
  );
};

/**
 * A failed request as a sentence: a lost connection or a silent server in plain words, the
 * server's own message when it wrote one, and `fallback` otherwise.
 */
export function requestErrorMessage(cause: unknown, fallback: string): string {
  const error = failure(cause);
  const message = plainMessage(cause);
  const status = typeof error.status === "number" ? error.status : 0;
  if (timedOut(cause)) return TIMEOUT_MESSAGE;
  if (NETWORK_FAILURE.test(message) || (error.code === "offline" && !status)) {
    return OFFLINE_MESSAGE;
  }
  if (readable(message)) return message;
  if (status === 429) return "Your server is busy. Wait a moment and try again.";
  if (status >= 500) return "Your server ran into a problem. Try again in a moment.";
  return fallback;
}

// The message inside a provider's JSON error, e.g. `500 {"error":{"message":"…"}}`.
const embeddedMessage = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const body = JSON.parse(text.slice(start)) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    const nested =
      typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    return typeof nested === "string" ? nested.trim() : null;
  } catch {
    return null;
  }
};

const REJECTED =
  /\b401\b|invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|unauthori[sz]ed|authentication_error/i;

/** Whether a provider's error says it turned the key or sign-in down. */
export const keyRejected = (raw: string): boolean =>
  REJECTED.test(`${raw} ${embeddedMessage(raw) ?? ""}`);

/**
 * Why the model test failed, in plain words. The server passes on the provider's own error,
 * sometimes as a status code and raw JSON, so known causes (a refused key, a rate limit, a
 * timeout, an outage) are named, and anything else is kept only when it reads as a sentence.
 */
export function modelTestErrorMessage(raw: string, name: string): string {
  const nested = embeddedMessage(raw);
  const text = `${raw} ${nested ?? ""}`;
  if (REJECTED.test(text)) {
    return `${name} didn't accept this sign-in or key. Sign in again, or use a different key.`;
  }
  if (/\b429\b|rate[_ -]?limit|quota|too many requests/i.test(text)) {
    return `${name} is limiting requests, or your plan's usage has run out. Wait a moment, then try again.`;
  }
  if (/\b403\b|forbidden|permission_error/i.test(text)) {
    return `${name} turned the request down. Check that your account can use this model.`;
  }
  if (/timed? ?out|timeout|aborted/i.test(text)) {
    return `${name} didn't answer in time. Try again.`;
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text)) {
    return `Your server couldn't reach ${name}. Check its internet connection and try again.`;
  }
  if (/\b5\d\d\b|server_error|overloaded|internal (?:server )?error/i.test(text)) {
    return `${name} had a problem on its end. Try again in a moment.`;
  }
  if (readable(nested)) return redactSensitiveText(nested);
  if (readable(raw.trim())) return redactSensitiveText(raw.trim());
  return `${name} sent back an error. Try again, or choose a different AI.`;
}

/**
 * Why a just-connected key didn't work, in plain words: the provider refused it (its model
 * list answers 401 or 403), isn't answering, or has no chat models for it. `message` is the
 * sign-in's error or the server's note on the provider's model list.
 */
export function keyCheckMessage(message: string, name: string): string {
  if (keyRejected(message) || /\b403\b|rejected/i.test(message)) {
    return `${name} didn't accept that key. Check it and try again.`;
  }
  if (/\b429\b|rate[_ -]?limit|too many requests/i.test(message)) {
    return `${name} is limiting requests right now. Wait a moment, then try again.`;
  }
  if (/\b5\d\d\b|failed|unavailable|timed? ?out/i.test(message)) {
    return `${name} isn't answering right now. Try again in a moment.`;
  }
  if (/no supported chat models/i.test(message)) {
    return `${name} accepted the key, but it offers no chat models. Check the key's project and permissions.`;
  }
  return readable(message.trim())
    ? redactSensitiveText(message.trim())
    : `${name} didn't accept that key. Check it and try again.`;
}
