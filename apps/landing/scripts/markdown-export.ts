import { Marked } from "marked";

/** Serialize Markdown with resolved links, without changing examples in code. */
export function exportMarkdown(source: string, resolve: (href: string, image?: boolean) => string) {
  const parser = new Marked({ gfm: true });
  const destination = (href: string, image = false) =>
    resolve(href, image).replace(/[ ()<>]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  parser.use({
    renderer: {
      space: () => "",
      heading({ tokens, depth }) { return `${"#".repeat(depth)} ${this.parser.parseInline(tokens)}\n\n`; },
      paragraph({ tokens }) { return `${this.parser.parseInline(tokens)}\n\n`; },
      text(token) { return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : token.raw; },
      strong({ tokens }) { return `**${this.parser.parseInline(tokens)}**`; },
      em({ tokens }) { return `*${this.parser.parseInline(tokens)}*`; },
      del({ tokens }) { return `~~${this.parser.parseInline(tokens)}~~`; },
      codespan: ({ raw }) => raw,
      code: ({ raw }) => `${raw.trimEnd()}\n\n`,
      html: ({ raw }) => raw,
      br: () => "  \n",
      hr: () => "---\n\n",
      link({ tokens, href, title }) {
        return `[${this.parser.parseInline(tokens)}](${destination(href)}${title ? ` "${title.replaceAll('"', '\\"')}"` : ""})`;
      },
      image({ text, href }) { return `![${text}](${destination(href, true)})`; },
      blockquote({ tokens }) {
        return `${this.parser.parse(tokens).trimEnd().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      },
      list({ items, ordered, start }) {
        return items.map((item, index) => {
          const prefix = ordered ? `${Number(start) + index}. ` : "- ";
          const task = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
          const content = `${task}${this.parser.parse(item.tokens).trim()}`;
          return prefix + content.split("\n").join(`\n${" ".repeat(prefix.length)}`);
        }).join("\n\n") + "\n\n";
      },
      table({ header, rows, align }) {
        const row = (cells: typeof header) => `| ${cells.map((cell) => this.parser.parseInline(cell.tokens).replaceAll("|", "\\|")).join(" | ")} |`;
        const separator = `| ${align.map((value) => value === "center" ? ":---:" : value === "right" ? "---:" : "---").join(" | ")} |`;
        return [row(header), separator, ...rows.map(row)].join("\n") + "\n\n";
      },
    },
  });
  return `${(parser.parse(source) as string).trim()}\n`;
}
