import { describe, expect, test } from "bun:test";
import {
  attachmentSummaryKind,
  attachmentsPreviewText,
  markdownToPlainText,
  messagePreviewText,
} from "../src/message-preview";

describe("message previews", () => {
  test("shows inline formatting as the text a reader sees", () => {
    expect(
      messagePreviewText(
        "Done. The [CRM](https://docs.google.com/spreadsheets/d/1abc/edit) is updated."
      )
    ).toBe("Done. The CRM is updated.");
    expect(messagePreviewText("Checking account `1234` now shows **$4,210.55**.")).toBe(
      "Checking account 1234 now shows $4,210.55."
    );
    expect(
      messagePreviewText(
        "### Done: the **[CRM](https://docs.google.com/spreadsheets/d/1abc/edit)** is _updated_ with ~~two~~ three leads and `1234` checked."
      )
    ).toBe("Done: the CRM is updated with two three leads and 1234 checked.");
    expect(messagePreviewText("Price is \\$5, *really* good, and snake_case_name stays.")).toBe(
      "Price is $5, really good, and snake_case_name stays."
    );
    expect(messagePreviewText("Revision __R1__ is delivered.")).toBe("Revision R1 is delivered.");
  });

  test("uses the first non-empty line", () => {
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
    expect(messagePreviewText("```\nnpm run build\n```")).toBe("");
    expect(messagePreviewText("---\n\nAfter the rule.")).toBe("---");
    expect(messagePreviewText("")).toBe("");
  });

  test("drops formatting tags and math delimiters outside code", () => {
    expect(
      messagePreviewText(
        "Use <b>bold</b> and <i>italic</i> here, plus $$x^2 + y^2$$ and \\(a+b\\) inline."
      )
    ).toBe("Use bold and italic here, plus x^2 + y^2 and a+b inline.");
    expect(markdownToPlainText("Line<br>break and <x>unknown</x> tags")).toBe(
      "Linebreak and <x>unknown</x> tags"
    );
    expect(markdownToPlainText("Unbalanced <b>bold and </i>")).toBe("Unbalanced <b>bold and </i>");
    expect(markdownToPlainText("Area $$\\text{m}^2$$ \\[\\textcolor{red}{x}\\]")).toBe(
      "Area m^2 x"
    );
    expect(markdownToPlainText("Run `<b>x</b>` and `$$y$$` as written")).toBe(
      "Run <b>x</b> and $$y$$ as written"
    );
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

  test("summarizes attachment-only messages by kind", () => {
    const png = { mimeType: "image/png", fileName: "chart.png" };
    expect(attachmentsPreviewText([png])).toBe("Sent 1 image");
    expect(attachmentsPreviewText([png, png])).toBe("Sent 2 images");
    expect(
      attachmentsPreviewText([png, { mimeType: "application/pdf", fileName: "q3.pdf" }, png])
    ).toBe("Sent 3 files · 2 images, 1 PDF");
    expect(attachmentsPreviewText([{ mimeType: "text/plain", fileName: "notes.txt" }])).toBe(
      "Sent 1 text file"
    );
    expect(attachmentsPreviewText([])).toBe("Sent 1 file");
  });

  test("classifies attachments by MIME type, then file name", () => {
    expect(attachmentSummaryKind({ mimeType: "video/mp4" })).toBe("video");
    expect(attachmentSummaryKind({ mimeType: "text/csv" })).toBe("table");
    expect(attachmentSummaryKind({ mimeType: "application/vnd.api+json" })).toBe("json");
    expect(attachmentSummaryKind({ mimeType: "application/zip" })).toBe("archive");
    expect(
      attachmentSummaryKind({ mimeType: "application/octet-stream", fileName: "Budget.XLSX" })
    ).toBe("table");
    expect(
      attachmentSummaryKind({ mimeType: "application/octet-stream", fileName: "notes.md" })
    ).toBe("markdown");
    expect(
      attachmentSummaryKind({ mimeType: "application/octet-stream", fileName: "main.swift" })
    ).toBe("text");
    expect(
      attachmentSummaryKind({ mimeType: "application/octet-stream", fileName: "data.bin" })
    ).toBe("file");
    expect(attachmentSummaryKind({ url: "https://example.com/files/song%20one.mp3?dl=1" })).toBe(
      "audio"
    );
  });
});
