import { expect, test } from "bun:test";
import { inferenceFailure } from "../src/inference-error";

test("provider capacity failures have a stable unavailable diagnostic without leaking payloads", () => {
  for (const message of [
    "The model is currently at capacity due to high demand. Please try again in a few minutes.",
    "Provider overloaded: private-request-details",
    "503 Service Unavailable private-request-details",
  ]) {
    expect(inferenceFailure(new Error(message))).toEqual({
      status: 503,
      error: { code: "inference_unavailable", message: "Inference provider is temporarily unavailable or at capacity" },
    });
  }
});

test("capacity wording does not mask authentication, billing, rate limits, or cancellation", () => {
  for (const message of ["401 unauthorized: at capacity", "invalid API key: overloaded"]) {
    expect(inferenceFailure(new Error(message)).status).toBe(422);
  }
  for (const message of ["insufficient_quota: at capacity", "402 billing limit: overloaded"]) {
    expect(inferenceFailure(new Error(message)).status).not.toBe(503);
  }
  expect(inferenceFailure(new Error("429 rate limit: at capacity")).status).toBe(429);
  expect(inferenceFailure(new Error("request aborted: at capacity")).status).toBe(499);
  expect(inferenceFailure(new Error("request timed out: at capacity")).status).toBe(504);
  expect(inferenceFailure(new Error("unknown private-request-details"))).toEqual({
    status: 502,
    error: { code: "inference_provider_failed", message: "Inference provider failed to return a usable response" },
  });
});
