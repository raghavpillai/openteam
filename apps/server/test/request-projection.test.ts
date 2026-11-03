import { expect, test } from "bun:test";
import { runViews } from "../src/services/snapshot/views";

test("request state exposes its wait without projecting private progress, evidence or control fields", () => {
  const now = new Date();
  const source = {
    id: "request",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    requestProgress: {
      state: "waiting",
      summary: "Private diagnostic",
      evidence: ["private-worker-reference"],
      remaining: ["Verify a pending decision"],
    },
    requestNextCheckAt: new Date(now.getTime() + 3600_000),
    requestStoppedAt: null,
    requestRevision: 8,
    requestReconciliations: 2,
  };
  const view = runViews([source])[0]!;
  expect(view.status).toBe("completed"); // model turn and request have distinct lifecycles
  expect(view.requestState).toBe("waiting");
  expect(view.requestNextCheckAt).toBe(source.requestNextCheckAt.toISOString());
  const encoded = JSON.stringify(view);
  expect(encoded).not.toContain("Private diagnostic");
  expect(encoded).not.toContain("private-worker-reference");
  expect(encoded).not.toContain("requestRevision");
  expect(encoded).not.toContain("requestReconciliations");
  expect(runViews([{ ...source, requestStoppedAt: now }])[0]!.requestState).toBeUndefined();
});
