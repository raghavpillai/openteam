import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileBlog } from "./build-blog";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// A 2×1 PNG header is enough for the size reader.
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000010806000000", "hex");

function post(fields: Record<string, string>, body = "Lead paragraph.\n\n## First section\n\nText.\n") {
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "openteam-blog-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "blog");
  const publicDir = path.join(root, "public");
  const docs = path.join(root, "docs");
  mkdirSync(directory);
  mkdirSync(path.join(publicDir, "blog/images"), { recursive: true });
  mkdirSync(docs);
  writeFileSync(path.join(publicDir, "blog/images/shot.png"), png);
  writeFileSync(
    path.join(docs, "config.json"),
    JSON.stringify({ home: "overview/introduction", groups: [{ pages: [{ file: "overview/introduction.md" }, { file: "usage/memory.md" }] }] })
  );
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(directory, name), content);
  return { directory, publicDir, docs };
}

const base = { title: "First post", description: "A short summary of the post.", date: "2026-10-06", category: "Guides" };

describe("blog build", () => {
  test("compiles posts newest first with headings and validated links", () => {
    const options = fixture({
      "first-post.md": post(
        { ...base, image: "/blog/images/shot.png", imageAlt: "A screenshot" },
        'Intro with [memory](/docs/usage/memory) and [the next post](/blog/second-post).\n\n![Bot desktop](/blog/images/shot.png "Image: OpenTeam")\n\n## Why it matters\n\n```sh\necho "<hi>"\n```\n'
      ),
      "second-post.md": post({ ...base, title: "Second post", date: "2026-10-07", related: "first-post", seoTitle: "Second post for search" }),
    });
    const { posts } = compileBlog({ ...options, asOf: "2026-10-12" });
    expect(posts.map((entry) => entry.slug)).toEqual(["second-post", "first-post"]);
    const [second, first] = posts;
    expect(second.seoTitle).toBe("Second post for search");
    expect(second.related).toEqual(["first-post"]);
    expect(first.image).toBe("/blog/images/shot.png");
    expect([first.imageWidth, first.imageHeight]).toEqual([2, 1]);
    expect(first.html).toContain('<h2 id="why-it-matters">');
    expect(first.html).toContain("echo &quot;&lt;hi&gt;&quot;");
    expect(first.headings.map((heading) => heading.id)).toEqual(["why-it-matters"]);
  });

  test("holds back future posts, drops them from related lists, and refuses links to them", () => {
    const later = post({ ...base, title: "Later", date: "2026-10-20" });
    const { posts } = compileBlog({ ...fixture({ "now.md": post({ ...base, related: "later" }), "later.md": later }), asOf: "2026-10-12" });
    expect(posts.map((entry) => entry.slug)).toEqual(["now"]);
    expect(posts[0].related).toEqual([]);
    const linked = fixture({ "now.md": post(base, "See [later](/blog/later).\n"), "later.md": later });
    expect(() => compileBlog({ ...linked, asOf: "2026-10-12" })).toThrow("isn't published until later");
  });

  test.each([
    ["a bad date", post({ ...base, date: "Oct 6" }), "YYYY-MM-DD"],
    ["an H1 in the body", post(base, "# Title\n"), "don't add an H1"],
    ["a broken site link", post(base, "[x](/docs/nope)\n"), "broken link"],
    ["a hotlinked image", post(base, "![x](https://example.com/a.png)\n"), "instead of hotlinking"],
    ["a missing image", post(base, "![x](/blog/images/missing.png)\n"), "missing image"],
    ["an image without alt text", post(base, "![](/blog/images/shot.png)\n"), "needs alt text"],
    ["an unknown related post", post({ ...base, related: "ghost" }), 'related post "ghost"'],
  ])("rejects %s", (_name, content, message) => {
    const options = fixture({ "bad-post.md": content });
    expect(() => compileBlog({ ...options, asOf: "2026-10-12" })).toThrow(message);
  });
});
