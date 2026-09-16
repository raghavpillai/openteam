import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { Marked, type Token, type Tokens } from "marked";
import { DOCS_ORIGIN, type DocPage, type DocsConfig, type DocsData, type DocsTextData } from "../lib/docs-types";
import { exportMarkdown } from "./markdown-export";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const docsDirectory = path.join(repositoryRoot, "docs");
const generatedDirectory = fileURLToPath(new URL("../.generated/", import.meta.url));

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );
}

function plainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if ("tokens" in token && token.tokens) return plainText(token.tokens);
      return "text" in token ? token.text : "";
    })
    .join("");
}

export function validateConfig(value: unknown): DocsConfig {
  if (!value || typeof value !== "object") throw new Error("Docs config must be an object");
  const config = value as DocsConfig;
  for (const field of ["title", "description", "repository", "branch", "home"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) {
      throw new Error(`Docs config needs a nonempty ${field}`);
    }
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(config.repository)) {
    throw new Error("Docs repository must be a GitHub repository URL without a trailing slash");
  }
  if (!Array.isArray(config.groups) || !config.groups.length)
    throw new Error("Docs config needs groups");
  const files = new Set<string>();
  for (const group of config.groups) {
    if (!group.title || !Array.isArray(group.pages) || !group.pages.length) {
      throw new Error("Each docs group needs a title and pages");
    }
    for (const page of group.pages) {
      if (
        typeof page.title !== "string" ||
        !page.title.trim() ||
        typeof page.file !== "string" ||
        !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/.test(page.file)
      ) {
        throw new Error(`Invalid docs page: ${JSON.stringify(page)}`);
      }
      if (files.has(page.file)) throw new Error(`Duplicate docs page: ${page.file}`);
      files.add(page.file);
    }
  }
  if (!files.has(`${config.home}.md`))
    throw new Error("Docs home must reference a configured page");
  return config;
}

/** Reads only during dev/build. The deployed site imports the resulting JSON. */
export function compileDocs(directory = docsDirectory): DocsData & { text: DocsTextData } {
  const config = validateConfig(
    JSON.parse(readFileSync(path.join(directory, "config.json"), "utf8"))
  );
  const root = path.dirname(directory);
  const pages: DocPage[] = config.groups.flatMap((group) =>
    group.pages.map((entry) => {
      const filename = path.join(directory, entry.file);
      if (!existsSync(filename)) throw new Error(`Missing docs file: ${entry.file}`);
      if (!realpathSync(filename).startsWith(`${realpathSync(directory)}${path.sep}`)) {
        throw new Error(`Docs file escapes docs directory: ${entry.file}`);
      }
      const markdown = readFileSync(filename, "utf8");
      const slug = entry.file.replace(/\.md$/, "");
      return {
        ...entry,
        group: group.title,
        slug,
        href: slug === config.home ? "/docs" : `/docs/${slug}`,
        sourceUrl: `${config.repository}/blob/${config.branch}/docs/${entry.file}`,
        markdown,
        html: "",
        description: "",
        headings: [],
      };
    })
  );
  const byFile = new Map(pages.map((page) => [page.file, page]));
  const markdownPages: Record<string, string> = {};
  const links: { source: DocPage; target: DocPage; hash: string }[] = [];
  for (const page of pages) {
    const slugger = new GithubSlugger();
    const parser = new Marked({ gfm: true });
    const tokens = parser.lexer(page.markdown);
    const first = tokens.find((token) => token.type !== "space");
    if (first?.type !== "heading" || first.depth !== 1) {
      throw new Error(`${page.file} must start with a Markdown title`);
    }
    const headingTitle = plainText(first.tokens ?? []);
    if (headingTitle !== page.title)
      throw new Error(`Title in ${page.file} must match config: ${page.title}`);
    // Reserve the H1 anchor even though the page header renders it outside the prose.
    page.headings.push({ id: slugger.slug(headingTitle), title: headingTitle, level: 1 });
    tokens.splice(tokens.indexOf(first), 1);
    const intro = tokens.find((token): token is Tokens.Paragraph => token.type === "paragraph");
    page.description = intro ? plainText(intro.tokens) : config.description;

    const resolveLink = (href: string, image = false) => {
      if (/^(https?:|mailto:)/i.test(href)) return href;
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
        throw new Error(`Unsupported URL in ${page.file}: ${href}`);
      }
      if (href.startsWith("/")) return href;
      const url = new URL(href, `https://docs.local/docs/${page.file}`);
      const targetPath = decodeURIComponent(url.pathname).slice(1);
      const targetFile = targetPath.replace(/^docs\//, "");
      const target =
        targetPath === "docs/README.md"
          ? byFile.get(`${config.home}.md`)
          : targetPath.startsWith("docs/")
            ? byFile.get(targetFile)
            : undefined;
      if (target && !image) {
        links.push({ source: page, target, hash: decodeURIComponent(url.hash.slice(1)) });
        return `${target.href}${url.search}${url.hash}`;
      }
      if (!existsSync(path.join(root, targetPath))) {
        throw new Error(`Broken link in ${page.file}: ${href}`);
      }
      return `${config.repository}/${image ? "raw" : "blob"}/${config.branch}/${targetPath}${url.search}${url.hash}`;
    };

    parser.use({
      renderer: {
        heading({ tokens, depth }) {
          if (depth === 1) throw new Error(`${page.file} has more than one H1`);
          const title = plainText(tokens);
          const id = slugger.slug(title);
          page.headings.push({ id, title, level: depth });
          return `<h${depth} id="${escapeHtml(id)}"><a href="#${escapeHtml(id)}">${this.parser.parseInline(tokens)}</a></h${depth}>\n`;
        },
        link({ href, title, tokens }) {
          return `<a href="${escapeHtml(resolveLink(href))}"${title ? ` title="${escapeHtml(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
        },
        image({ href, title, text }) {
          return `<img src="${escapeHtml(resolveLink(href, true))}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy" />`;
        },
        html({ text }) {
          return escapeHtml(text);
        },
        code({ text, lang }) {
          const language = lang?.split(/\s/)[0] || "text";
          return `<div class="docs-code"><div class="docs-code-label">${escapeHtml(language)}</div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
        },
        table(token) {
          const renderRow = (cells: Tokens.TableCell[], header = false) =>
            cells
              .map((cell) => {
                const tag = header ? "th" : "td";
                return `<${tag}${header ? ' scope="col"' : ""}>${this.parser.parseInline(cell.tokens)}</${tag}>`;
              })
              .join("");
          return `<div class="docs-table" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr>${renderRow(token.header, true)}</tr></thead><tbody>${token.rows.map((row) => `<tr>${renderRow(row)}</tr>`).join("")}</tbody></table></div>\n`;
        },
      },
    });
    page.html = parser.parser(tokens);
    markdownPages[`/docs/${page.slug}`] = exportMarkdown(page.markdown, (href, image) => {
      const resolved = resolveLink(href, image);
      if (!resolved.startsWith("/")) return resolved;
      const url = new URL(resolved, DOCS_ORIGIN);
      const target = pages.find((entry) => entry.href === url.pathname);
      if (!image && target) url.pathname = `/docs/${target.slug}.md`;
      return url.href;
    });
  }
  for (const { source, target, hash } of links) {
    if (hash && !target.headings.some((heading) => heading.id === hash)) {
      throw new Error(`Broken heading in ${source.file}: ${target.file}#${hash}`);
    }
  }
  const index = [
    `# OpenTeam ${config.title}`,
    `> ${config.description}`,
    ...config.groups.map((group) => `## ${group.title}\n\n${pages.filter((page) => page.group === group.title).map((page) =>
      `- [${page.title}](${DOCS_ORIGIN}/docs/${page.slug}.md): ${page.description.split("\n")[0].slice(0, 300)}`
    ).join("\n")}`),
  ].join("\n\n") + "\n";
  const full = `# OpenTeam ${config.title}\n\n> ${config.description}\n\n` + pages.map((page) =>
    `---\n\nSource: ${DOCS_ORIGIN}/docs/${page.slug}.md\n\n${markdownPages[`/docs/${page.slug}`]}`
  ).join("\n");
  markdownPages["/docs"] = markdownPages[`/docs/${config.home}`];
  markdownPages["/docs/index"] = markdownPages["/docs"];
  return { config, pages, text: { pages: markdownPages, index, full } };
}

export function generateDocs() {
  const { text, ...data } = compileDocs();
  mkdirSync(generatedDirectory, { recursive: true });
  for (const [filename, content] of [["docs.json", data], ["docs-text.json", text]] as const) {
    const output = path.join(generatedDirectory, filename);
    const json = `${JSON.stringify(content)}\n`;
    if (!existsSync(output) || readFileSync(output, "utf8") !== json) writeFileSync(output, json);
  }
  return data;
}
