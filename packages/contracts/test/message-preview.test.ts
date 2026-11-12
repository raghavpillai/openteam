import { describe, expect, test } from "bun:test";
import {
  messagePreviewText,
} from "../src/message-preview";

describe("message previews", () => {

  test("uses the first line with visible text", () => {
    expect(
      messagePreviewText("Status update\nAll three invoices are paid.\n\nDetails follow.")
    ).toBe("Status update");
    expect(messagePreviewText("\n \n## Weekly audit\n\n### Summary\n- **UTC:** now")).toBe(
      "Weekly audit"
    );
    expect(messagePreviewText("- **Rent:** paid\n- **Utilities:** due Friday")).toBe("Rent: paid");
    expect(messagePreviewText("1. First step\n2. Second step")).toBe("First step");
    expect(messagePreviewText("> Hi Sam, thanks for the update.\n\nWant me to send it?")).toBe(
      "Hi Sam, thanks for the update."
    );
    expect(messagePreviewText("| Item | Cost |\n|---|---|\n| Rent | $2,000 |")).toBe("Item Cost");
    expect(messagePreviewText("![Revenue chart](https://example.com/chart.png)\n\nUp 12%.")).toBe(
      "Revenue chart"
    );
    expect(messagePreviewText("```bash\nnpm run build\n```")).toBe("bash");
    expect(messagePreviewText("```\nnpm run build\n```")).toBe("npm run build");
    expect(messagePreviewText("---\n\nAfter the rule.")).toBe("---");
    expect(messagePreviewText("![](https://x.test/chart.png)\n\nRevenue grew 12%")).toBe(
      "Revenue grew 12%"
    );
    expect(messagePreviewText("<br>\n> \nStill here")).toBe("Still here");
    expect(messagePreviewText("```")).toBe("");
    expect(messagePreviewText("")).toBe("");
  });

  test("caps previews at 200 characters after removing markdown", () => {
    const link = `[quarterly revenue workbook](https://docs.google.com/spreadsheets/d/${"a".repeat(180)}/edit)`;
    expect(messagePreviewText(`Done. Here is the ${link} for you to review.`)).toBe(
      "Done. Here is the quarterly revenue workbook for you to review."
    );
    const preview = messagePreviewText(`${"word ".repeat(60)}end`);
    expect(preview).toHaveLength(200);
    expect(preview.endsWith("word…")).toBe(true);
    expect(messagePreviewText(`${"a".repeat(198)}😀😀`)).toBe(`${"a".repeat(198)}…`);
    expect(messagePreviewText("x".repeat(10_000))).toBe(`${"x".repeat(199)}…`);
  });

});
