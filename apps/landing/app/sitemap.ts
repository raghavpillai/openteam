import type { MetadataRoute } from "next";
import { blogPosts } from "@/lib/blog";
import { docPages } from "@/lib/docs";
import { SITE_URL } from "@/lib/page-metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  const latestPost = blogPosts[0];
  return [
    { url: SITE_URL, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/download`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/support`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "monthly", priority: 0.4 },
    {
      url: `${SITE_URL}/blog`,
      ...(latestPost ? { lastModified: latestPost.updated ?? latestPost.date } : {}),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    ...blogPosts.map((post) => ({
      url: new URL(post.href, SITE_URL).toString(),
      lastModified: post.updated ?? post.date,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...docPages.map((page) => ({
      url: new URL(page.href, SITE_URL).toString(),
      ...(page.updated ? { lastModified: page.updated } : {}),
      changeFrequency: "monthly" as const,
      priority: page.href === "/docs" ? 0.8 : 0.6,
    })),
  ];
}
