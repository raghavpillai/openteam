import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { Marked, type Tokens } from "marked";
import { BLOG_CATEGORIES, type BlogAuthor, type BlogCategory, type BlogData, type BlogPost } from "../lib/blog-types";
import { codeBlockHtml, docsDirectory, escapeHtml, generatedDirectory, plainText } from "./build-docs";

export const blogDirectory = fileURLToPath(new URL("../content/blog/", import.meta.url));
const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

const DEFAULT_AUTHOR: BlogAuthor = { name: "Raghav Pillai", url: "https://github.com/raghavpillai" };

const FIELDS = ["title", "seoTitle", "description", "date", "updated", "category", "image", "imageAlt", "related"] as const;
type Field = (typeof FIELDS)[number];

function parseFrontmatter(source: string, file: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${file} must start with --- frontmatter ---`);
  const fields: Partial<Record<Field, string>> = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const entry = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!entry) throw new Error(`${file}: can't read frontmatter line "${line}"`);
    const [, key, raw] = entry;
    if (!(FIELDS as readonly string[]).includes(key)) throw new Error(`${file}: unknown frontmatter field "${key}"`);
    const value = raw.trim();
    fields[key as Field] = /^".*"$/.test(value) ? (JSON.parse(value) as string) : value;
  }
  return { fields, body: source.replace(/\r\n/g, "\n").slice(match[0].length) };
}

function isDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Width and height keep images from shifting the page while they load. */
function imageSize(file: string): { width: number; height: number } | undefined {
  const bytes = new Uint8Array(readFileSync(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, end: number) => new TextDecoder("latin1").decode(bytes.subarray(start, end));
  const uint24 = (offset: number) => view.getUint16(offset, true) | (bytes[offset + 2] << 16);
  if (text(1, 4) === "PNG") return { width: view.getUint32(16), height: view.getUint32(20) };
  if (text(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    const chunk = text(12, 16);
    if (chunk === "VP8X") return { width: uint24(24) + 1, height: uint24(27) + 1 };
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return;
      const marker = bytes[offset + 1];
      // Start-of-frame markers carry the dimensions; DHT, JPG and DAC share the range but don't.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return;
  }
  const svg = new TextDecoder().decode(bytes.subarray(0, 4096));
  const viewBox = /viewBox="[\d.\s-]*?\s([\d.]+)\s+([\d.]+)"/.exec(svg);
  if (viewBox) return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
}

/** Widths from Next's default device sizes; the optimizer serves WebP at the closest one. */
const SRCSET_WIDTHS = [640, 828, 1080, 1200, 1920];

function responsiveSource(src: string, width: number) {
  if (src.endsWith(".svg")) return "";
  const widths = SRCSET_WIDTHS.filter((candidate) => candidate <= width);
  if (width > 1200) widths.push(1920);
  if (widths.length < 2) return "";
  const urls = [...new Set(widths)].map((candidate) => `/_next/image?url=${encodeURIComponent(src)}&w=${candidate}&q=75 ${candidate}w`);
  return ` srcset="${escapeHtml(urls.join(", "))}" sizes="(max-width: 800px) calc(100vw - 40px), 680px"`;
}

function dimensions(size: { width: number; height: number } | undefined) {
  return size ? { imageWidth: size.width, imageHeight: size.height } : {};
}

function docsHrefs(directory: string) {
  const config = JSON.parse(readFileSync(path.join(directory, "config.json"), "utf8")) as {
    home: string;
    groups: { pages: { file: string }[] }[];
  };
  return new Set(
    config.groups.flatMap((group) => group.pages.map(({ file }) => {
      const slug = file.replace(/\.md$/, "");
      return slug === config.home ? "/docs" : `/docs/${slug}`;
    }))
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reads only during dev/build. Posts dated after `asOf` are left out, so a
 * scheduled post appears with the first deploy on or after its date.
 */
export function compileBlog({
  directory = blogDirectory,
  publicDir = publicDirectory,
  docs = docsDirectory,
  asOf = today(),
}: { directory?: string; publicDir?: string; docs?: string; asOf?: string } = {}): BlogData {
  if (!existsSync(directory)) return { posts: [] };
  const files = readdirSync(directory).filter((file) => file.endsWith(".md")).sort();
  const slugs = new Set<string>();
  for (const file of files) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) throw new Error(`Blog file names must be lowercase slugs: ${file}`);
    slugs.add(file.replace(/\.md$/, ""));
  }
  const docLinks = docsHrefs(docs);
  const linkedPosts = new Map<string, Set<string>>();

  const posts = files.map((file): BlogPost => {
    const slug = file.replace(/\.md$/, "");
    const { fields, body } = parseFrontmatter(readFileSync(path.join(directory, file), "utf8"), file);
    for (const field of ["title", "description", "date", "category"] as const) {
      if (!fields[field]?.trim()) throw new Error(`${file} needs a nonempty ${field}`);
    }
    const title = fields.title!;
    const seoTitle = fields.seoTitle || title;
    const description = fields.description!;
    if (seoTitle.length > 70) throw new Error(`${file}: the search title is ${seoTitle.length} characters; keep it to 70`);
    if (description.length > 165) throw new Error(`${file}: the description is ${description.length} characters; keep it to 165`);
    if (!isDate(fields.date!)) throw new Error(`${file}: date must be YYYY-MM-DD`);
    if (fields.updated && (!isDate(fields.updated) || fields.updated < fields.date!)) {
      throw new Error(`${file}: updated must be a YYYY-MM-DD date on or after the publish date`);
    }
    if (!(BLOG_CATEGORIES as readonly string[]).includes(fields.category!)) {
      throw new Error(`${file}: category must be one of ${BLOG_CATEGORIES.join(", ")}`);
    }
    const related = (fields.related ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    for (const entry of related) {
      if (!slugs.has(entry) || entry === slug) throw new Error(`${file}: related post "${entry}" doesn't exist`);
    }

    const localImage = (src: string) => {
      const target = path.join(publicDir, decodeURIComponent(src.split(/[?#]/)[0]));
      if (!target.startsWith(publicDir) || !existsSync(target)) throw new Error(`${file}: missing image ${src}`);
      return target;
    };
    if (fields.image) {
      if (!fields.image.startsWith("/")) throw new Error(`${file}: image must be a path under public/`);
      localImage(fields.image);
      if (!fields.imageAlt?.trim()) throw new Error(`${file}: image needs imageAlt`);
    }

    const linked = new Set<string>();
    linkedPosts.set(slug, linked);
    const headings: BlogPost["headings"] = [];
    const slugger = new GithubSlugger();
    const parser = new Marked({ gfm: true });
    const resolveLink = (href: string) => {
      if (/^(https?:|mailto:)/i.test(href) || href.startsWith("#")) return href;
      if (!href.startsWith("/")) throw new Error(`${file}: use absolute site paths or full URLs, not "${href}"`);
      const pathname = href.split(/[?#]/)[0].replace(/\/$/, "") || "/";
      const post = /^\/blog\/([^/]+)$/.exec(pathname);
      if (post) linked.add(post[1]);
      const known =
        pathname === "/" ||
        pathname === "/blog" ||
        pathname === "/download" ||
        (post && slugs.has(post[1])) ||
        docLinks.has(pathname) ||
        existsSync(path.join(publicDir, pathname));
      if (!known) throw new Error(`${file}: broken link ${href}`);
      return href;
    };
    parser.use({
      renderer: {
        heading({ tokens, depth }) {
          if (depth === 1) throw new Error(`${file}: the title comes from frontmatter; don't add an H1`);
          const text = plainText(tokens);
          const id = slugger.slug(text);
          headings.push({ id, title: text, level: depth });
          return `<h${depth} id="${escapeHtml(id)}"><a href="#${escapeHtml(id)}">${this.parser.parseInline(tokens)}</a></h${depth}>\n`;
        },
        paragraph({ tokens }) {
          // A paragraph holding only an image becomes a figure, which can't sit inside <p>.
          const content = this.parser.parseInline(tokens);
          return tokens.length === 1 && tokens[0].type === "image" ? content : `<p>${content}</p>\n`;
        },
        link({ href, title, tokens }) {
          const target = resolveLink(href);
          const external = /^https?:/i.test(target);
          return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' rel="noopener"' : ""}>${this.parser.parseInline(tokens)}</a>`;
        },
        image({ href, title, text }) {
          if (!href.startsWith("/")) throw new Error(`${file}: download images into public/ instead of hotlinking ${href}`);
          if (!text.trim()) throw new Error(`${file}: image ${href} needs alt text`);
          const size = imageSize(localImage(href));
          const dimensions = size ? ` width="${size.width}" height="${size.height}"` : "";
          const sources = size ? responsiveSource(href, size.width) : "";
          const img = `<img src="${escapeHtml(href)}"${sources} alt="${escapeHtml(text)}"${dimensions} loading="lazy" decoding="async" />`;
          return `<figure>${img}${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""}</figure>\n`;
        },
        html({ text }) {
          return escapeHtml(text);
        },
        code({ text, lang }) {
          return codeBlockHtml(text, lang);
        },
        table(token: Tokens.Table) {
          // The first column names each row, so it's a row header for screen readers and parsers.
          const renderRow = (cells: Tokens.TableCell[], header = false) =>
            cells
              .map((cell, index) => {
                const scope = header ? "col" : index === 0 ? "row" : undefined;
                const tag = scope ? "th" : "td";
                return `<${tag}${scope ? ` scope="${scope}"` : ""}>${this.parser.parseInline(cell.tokens)}</${tag}>`;
              })
              .join("");
          return `<div class="docs-table" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr>${renderRow(token.header, true)}</tr></thead><tbody>${token.rows.map((row) => `<tr>${renderRow(row)}</tr>`).join("")}</tbody></table></div>\n`;
        },
      },
    });
    const html = parser.parse(body, { async: false });
    const words = body.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
    return {
      slug,
      href: `/blog/${slug}`,
      title,
      seoTitle,
      description,
      date: fields.date!,
      ...(fields.updated ? { updated: fields.updated } : {}),
      category: fields.category as BlogCategory,
      ...(fields.image ? { image: fields.image, imageAlt: fields.imageAlt, ...dimensions(imageSize(localImage(fields.image))) } : {}),
      related,
      author: DEFAULT_AUTHOR,
      markdown: body.trim(),
      html,
      headings,
      readingMinutes: Math.max(1, Math.round(words / 230)),
      wordCount: words,
    };
  });

  const published = new Set(posts.filter((post) => post.date <= asOf).map((post) => post.slug));
  for (const slug of published) {
    for (const target of linkedPosts.get(slug) ?? []) {
      if (!published.has(target)) throw new Error(`${slug}.md links to ${target}, which isn't published until later`);
    }
  }
  return {
    posts: posts
      .filter((post) => published.has(post.slug))
      .map((post) => ({ ...post, related: post.related.filter((entry) => published.has(entry)) }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)),
  };
}

export function generateBlog() {
  const data = compileBlog();
  mkdirSync(generatedDirectory, { recursive: true });
  const output = path.join(generatedDirectory, "blog.json");
  const json = `${JSON.stringify(data)}\n`;
  if (!existsSync(output) || readFileSync(output, "utf8") !== json) writeFileSync(output, json);
  return data;
}
