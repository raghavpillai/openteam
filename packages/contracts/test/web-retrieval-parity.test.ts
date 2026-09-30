import { expect, test } from "bun:test";
import { referenceTool } from "../src/tool-contracts";
import captured from "../src/tool-reference.json";

test("web tools retain captured inputs with accurate retrieval and fallback guidance", () => {
  for (const name of ["WebFetch", "WebSearch"] as const)
    expect(referenceTool(name).inputSchema).toEqual(captured[name].inputSchema);
  const description = referenceTool("WebFetch").description;
  expect(description).toStartWith("Fetch content from a specified URL and return its contents in a readable markdown format.");
  expect(description).not.toContain("your box egresses from a different network");
  expect(description).not.toContain("does not support fetching binary content, e.g. media or PDFs");
  expect(description).toContain("retrieval time is not crawl time");
  expect(description).toContain("wrong-region content");
  expect(description).toContain("continue with the requested browser or Shell fallback");
});
