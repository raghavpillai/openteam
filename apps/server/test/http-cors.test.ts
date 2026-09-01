import { describe, expect, test } from "bun:test";
import { corsHeaders } from "../src/http";

describe("HTTP CORS policy", () => {
  test("allows the PUT channel-member mutation used by browser clients", () => {
    expect(corsHeaders["access-control-allow-methods"].split(",")).toContain("PUT");
  });
});
