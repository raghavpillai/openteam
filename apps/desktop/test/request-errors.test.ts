import { describe, expect, test } from "bun:test";
import { OpenTeamClientError } from "@openteam/client-core";
import {
  keyCheckMessage,
  keyRejected,
  modelTestErrorMessage,
  OFFLINE_MESSAGE,
  requestErrorMessage,
  TIMEOUT_MESSAGE,
  timedOut,
  withDeadline,
} from "../src/renderer/lib/request-errors";

describe("setup request deadlines", () => {
  test("a silent request is cancelled and reported as a timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = withDeadline((given) => {
      signal = given;
      return new Promise<never>(() => {});
    }, 20);
    await expect(request).rejects.toMatchObject({ code: "timeout", message: TIMEOUT_MESSAGE });
    expect(signal?.aborted).toBe(true);
  });

  test("an answer in time passes through and leaves the request alone", async () => {
    let signal: AbortSignal | undefined;
    const value = await withDeadline(async (given) => {
      signal = given;
      return "ready";
    }, 20);
    await Bun.sleep(35);
    expect(value).toBe("ready");
    expect(signal?.aborted).toBe(false);
  });

  test("a request that fails in time keeps its own error", async () => {
    await expect(
      withDeadline(async () => {
        throw new OpenTeamClientError("Choose a model before testing it.", "conflict", 409);
      }, 20)
    ).rejects.toThrow("Choose a model before testing it.");
  });
});

describe("request failures in plain words", () => {
  test.each([
    new OpenTeamClientError("Failed to fetch", "offline"),
    new OpenTeamClientError("fetch failed", "offline"),
    new TypeError("Failed to fetch"),
    new Error("Load failed"),
    new Error("Error invoking remote method 'openteam:x': OpenTeamClientError: fetch failed"),
  ])("a lost connection: %p", (cause) => {
    expect(requestErrorMessage(cause, "Could not create the bot")).toBe(OFFLINE_MESSAGE);
  });

  test("a deadline or engine timeout", () => {
    expect(requestErrorMessage(new OpenTeamClientError("x", "timeout"), "x")).toBe(TIMEOUT_MESSAGE);
    expect(requestErrorMessage(new DOMException("signal timed out", "TimeoutError"), "x")).toBe(
      TIMEOUT_MESSAGE
    );
    expect(timedOut(new Error("The operation timed out."))).toBe(true);
    expect(timedOut(new Error("Failed to fetch"))).toBe(false);
  });

  test("keeps the server's own sentence and replaces raw or empty ones", () => {
    expect(
      requestErrorMessage(
        new OpenTeamClientError("The OpenTeam server is temporarily unavailable.", "offline", 503),
        "x"
      )
    ).toBe("The OpenTeam server is temporarily unavailable.");
    expect(
      requestErrorMessage(new OpenTeamClientError("Request failed (502)", undefined, 502), "x")
    ).toBe("Your server ran into a problem. Try again in a moment.");
    expect(
      requestErrorMessage(
        new OpenTeamClientError('{"error":"Cannot delete an active context session"}', "x", 503),
        "x"
      )
    ).toBe("Your server ran into a problem. Try again in a moment.");
    expect(requestErrorMessage(new OpenTeamClientError("", "rate_limited", 429), "x")).toBe(
      "Your server is busy. Wait a moment and try again."
    );
    expect(requestErrorMessage(null, "Could not create the bot")).toBe("Could not create the bot");
  });
});

describe("model test failures in plain words", () => {
  test("names a refused key, a rate limit, a timeout and an outage", () => {
    expect(modelTestErrorMessage("401 Incorrect API key provided: sk-…", "OpenAI")).toBe(
      "OpenAI didn't accept this sign-in or key. Sign in again, or use a different key."
    );
    expect(
      modelTestErrorMessage(
        "429 You exceeded your current quota or rate limit. Please try again in 20s.",
        "ChatGPT"
      )
    ).toBe(
      "ChatGPT is limiting requests, or your plan's usage has run out. Wait a moment, then try again."
    );
    expect(modelTestErrorMessage("The operation was aborted due to timeout", "ChatGPT")).toBe(
      "ChatGPT didn't answer in time. Try again."
    );
    expect(
      modelTestErrorMessage(
        '500 {"error":{"message":"The server had an error while processing your request.","type":"server_error"}}',
        "ChatGPT"
      )
    ).toBe("ChatGPT had a problem on its end. Try again in a moment.");
    expect(modelTestErrorMessage("fetch failed", "Claude")).toBe(
      "Your server couldn't reach Claude. Check its internet connection and try again."
    );
  });

  test("keeps a provider's plain reason and never shows raw JSON", () => {
    expect(modelTestErrorMessage("Your ChatGPT sign-in expired. Sign in again.", "ChatGPT")).toBe(
      "Your ChatGPT sign-in expired. Sign in again."
    );
    expect(
      modelTestErrorMessage('400 {"error":{"message":"Model not available on your plan"}}', "X")
    ).toBe("Model not available on your plan");
    expect(modelTestErrorMessage('{"detail":[1,2]}', "OpenRouter")).toBe(
      "OpenRouter sent back an error. Try again, or choose a different AI."
    );
  });
});

describe("checking a just-connected key", () => {
  test("a model list the provider refused means the key was turned down", () => {
    const refused =
      "The provider rejected model discovery (HTTP 401). Reconnect it or grant model-list access.";
    expect(keyCheckMessage(refused, "OpenAI")).toBe(
      "OpenAI didn't accept that key. Check it and try again."
    );
    expect(keyCheckMessage("Incorrect API key provided.", "OpenAI")).toBe(
      "OpenAI didn't accept that key. Check it and try again."
    );
    expect(keyRejected('401 {"error":{"type":"authentication_error"}}')).toBe(true);
    expect(keyRejected("429 You exceeded your current quota")).toBe(false);
  });

  test("an outage, a rate limit or an empty list says so instead", () => {
    expect(
      keyCheckMessage(
        "Model discovery failed (HTTP 502). Check the provider's availability and retry.",
        "OpenRouter"
      )
    ).toBe("OpenRouter isn't answering right now. Try again in a moment.");
    expect(keyCheckMessage("HTTP 429 Too Many Requests", "Anthropic")).toBe(
      "Anthropic is limiting requests right now. Wait a moment, then try again."
    );
    expect(
      keyCheckMessage(
        "No supported chat models were returned. Check model access or the endpoint's model types.",
        "OpenAI"
      )
    ).toBe(
      "OpenAI accepted the key, but it offers no chat models. Check the key's project and permissions."
    );
    expect(keyCheckMessage("", "OpenAI")).toBe(
      "OpenAI didn't accept that key. Check it and try again."
    );
  });
});
