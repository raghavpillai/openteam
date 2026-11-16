import type { Metadata } from "next";

export const SITE_URL = "https://openteam.so";
// Search results show the title and description, so both lead with the terms people search for.
export const SITE_TITLE = "OpenTeam: Run your own team of self-hosted AI agents";
export const SITE_DESCRIPTION =
  "Open-source AI agents that run on your hardware. Each gets its own computer and browser, works in your apps, remembers how you work, and delegates to teammates.";
export const GITHUB_URL = "https://github.com/raghavpillai/openteam";

// Change the image URL when the artwork changes so share crawlers fetch it again.
const SOCIAL_IMAGE = {
  url: `${SITE_URL}/social/openteam-2026-09-13.png`,
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "OpenTeam — Run your own AI team. Digital workers on your compute. Open source and self-hosted, with the teal 2D OpenTeam bot.",
};

type ArticleMetadata = {
  publishedTime: string;
  modifiedTime?: string;
  authors: string[];
  section: string;
};

export function pageMetadata({
  title,
  description,
  path,
  image,
  article,
}: {
  title: string;
  description: string;
  path: string;
  /** Overrides the site-wide social image, e.g. with a post's lead image. */
  image?: { url: string; alt: string; width?: number; height?: number };
  article?: ArticleMetadata;
}): Metadata {
  const url = new URL(path, SITE_URL).toString();
  const social = image
    ? { ...image, url: new URL(image.url, SITE_URL).toString() }
    : SOCIAL_IMAGE;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "OpenTeam",
      locale: "en_US",
      images: [{ ...social, secureUrl: social.url }],
      ...(article ? { type: "article" as const, ...article } : { type: "website" as const }),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: social.url, alt: social.alt }],
    },
  };
}
