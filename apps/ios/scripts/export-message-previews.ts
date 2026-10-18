/** Writes message previews from packages/contracts for the Swift MessagePreview test.
 * `--check` fails when the fixture is stale; the Swift test fails when Swift drifts. */
import {
  attachmentsPreviewText,
  messagePreviewText,
  type AttachmentSummarySource,
} from "../../../packages/contracts/src/message-preview";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(import.meta.dir, "../Tests/CoreTests/Fixtures/message-previews.json");

const examples = [
  "Done. The [CRM](https://docs.google.com/spreadsheets/d/1abc/edit) is updated.",
  "Checking account `1234` now shows **$4,210.55**.",
  "### Done: the **[CRM](https://x.test/a)** is _updated_ with ~~two~~ three leads and `1234` checked.",
  "Status update\nAll three invoices are paid.\n\nDetails follow below.",
  "\n \n## Weekly audit\n\n### Summary\n- **UTC:** now",
  "- **Rent:** paid\n- **Utilities:** due Friday",
  "  * nested item\n",
  "1. First step\n2. Second step",
  "3) Third step",
  "> Hi Sam, thanks for the update.\n\nWant me to send it?",
  "| Item | Cost |\n|---|---|\n| Rent | $2,000 |",
  "![Revenue chart](https://example.com/chart.png)\n\nRevenue grew 12%.",
  "![](https://example.com/blank.png) caption",
  "```bash\nnpm run build\n```",
  "```\nnpm run build\n```",
  "~~~ js\nconst x = 1\n~~~",
  "---\n\nAfter the rule.",
  "Use <b>bold</b> and <i>italic</i> here, plus $$x^2 + y^2$$ and \\(a+b\\) inline.",
  "Line<br>break, line<br/>break, line</br>break, line</br/>stays",
  "<STRONG>Loud</STRONG> <mark>marked</mark> <sub>2</sub> <x>unknown</x> <b>open",
  "Area $$\\text{m}^2$$ \\[\\textcolor{red}{x}\\] \\(\\color{blue}y\\) \\textbf{kept}",
  "Run `<b>x</b>` and `$$y$$` as written",
  "Use ``code with ` inside`` and `unclosed",
  "Price is \\$5, *really* good, and snake_case_name stays.",
  "_italic_ __bold__ ***both*** **unclosed",
  "Windows line\r\nSecond line",
  "Tabs\tand non-breaking  spaces",
  "Emoji 😀 and accents é stay",
  `Done. Here is the [quarterly revenue workbook](https://docs.google.com/spreadsheets/d/${"a".repeat(180)}/edit) for you to review.`,
  `${"word ".repeat(60)}end`,
  `${"a".repeat(198)}😀😀`,
  `${"b".repeat(199)} trailing`,
  "x".repeat(5000),
  "",
  "   ",
  // A first line with no visible text falls through to the next one.
  "![](https://x.test/chart.png)\n\nRevenue grew 12%",
  ">\n> quoted",
  "* * *\nText",
  "<br>\nText",
  "- \nText",
  "$$ $$\nx",
  "```",
  `${"\n".repeat(5000)}too late`,
  `${"> \n".repeat(3000)}too late`,
  `${"y".repeat(9000)}\nnext`,
  // Whitespace and line breaks follow JavaScript's rules on every platform.
  "\ufeff\nHello",
  "\u200b\nHello",
  "\ufeffHello",
  "Hi\u0085there",
  "Status\u0085- item",
  "Note\u000b# not a heading",
  "Page\u2028## break",
  "<b\ufeff>t</b>",
  `${"a".repeat(197)} \u200d${"b".repeat(10)}`,
  `${"a".repeat(197)} \u0301${"b".repeat(10)}`,
  "\u0600<br>x",
  "*>\r\n-<br>\n*",
];

// A fixed pseudo-random mix of markdown fragments, so Swift is checked beyond the hand-picked cases.
const fragments = [
  "**",
  "*",
  "_",
  "__",
  "~~",
  "`",
  "``",
  "```",
  "~~~",
  "[",
  "]",
  "(",
  ")",
  "![",
  "# ",
  "## ",
  "> ",
  "- ",
  "1. ",
  "|",
  "<b>",
  "</b>",
  "<i>",
  "</i>",
  "<br>",
  "</br>",
  "<u>",
  "</u>",
  "<x>",
  "$$",
  "\\(",
  "\\)",
  "\\[",
  "\\]",
  "\\$",
  "\\text{",
  "{",
  "}",
  " ",
  "  ",
  "\n",
  "\n\n",
  "\t",
  "word",
  "snake_case",
  "https://example.com/a_b(c)",
  "😀",
  "é",
  "<",
  ">",
  "#",
  "-",
  "\r",
  "\r\n",
  "\u000b",
  "\f",
  "\u0085",
  "\u00a0",
  "\u2028",
  "\u200b",
  "\u200d",
  "\ufe0f",
  "\ufeff",
  " \u0301",
  "\u0600",
];
let seed = 20261018;
const next = (limit: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return Math.floor((seed / 2 ** 32) * limit);
};
const generated = Array.from({ length: 400 }, () =>
  Array.from({ length: 1 + next(24) }, () => fragments[next(fragments.length)]).join("")
);

const file = (fileName: string, mimeType: string): AttachmentSummarySource => ({
  fileName,
  mimeType,
});
const attachmentSets = [
  [file("chart.png", "image/png")],
  [file("a.png", "image/png"), file("b.jpg", "image/jpeg")],
  [file("a.png", "image/png"), file("q3.pdf", "application/pdf"), file("b.png", "image/png")],
  [file("notes.txt", "text/plain")],
  [file("clip.mov", "video/quicktime"), file("memo.m4a", "audio/mp4")],
  [file("Budget.XLSX", "application/octet-stream")],
  [file("notes.md", "application/octet-stream"), file("data.json", "application/json")],
  [file("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  [file("bundle.tar.gz", "application/gzip"), file("main.swift", "application/octet-stream")],
  [file("data.bin", "application/octet-stream")],
  [file("page.html", "text/html; charset=utf-8"), file("feed.xml", "application/atom+xml")],
  [file("ws:x.gz", "application/octet-stream"), file("music/song one.MP3", "")],
  [file("archive.", "application/octet-stream"), file(".env", "application/octet-stream")],
];

const json = `${JSON.stringify(
  {
    messages: [...examples, ...generated].map((content) => ({
      content,
      preview: messagePreviewText(content),
    })),
    attachments: attachmentSets.map((files) => ({ files, preview: attachmentsPreviewText(files) })),
  },
  null,
  2
)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== json) {
    console.error(
      "Tests/CoreTests/Fixtures/message-previews.json is stale. Run: bun apps/ios/scripts/export-message-previews.ts, then update Sources/Core/MessagePreview.swift to match."
    );
    process.exit(1);
  }
} else writeFileSync(target, json);
