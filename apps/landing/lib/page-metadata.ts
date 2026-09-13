import type { Metadata } from "next";

export const SITE_URL = "https://openteam.so";
export const SITE_TITLE = "OpenTeam | Run your own AI team";
export const SITE_DESCRIPTION =
  "Digital workers that run on your compute and work in your apps. They have their own computer and shared workspace, remember your instructions, and delegate work to each other.";

// Change the image URL when the artwork changes so share crawlers fetch it again.
const SOCIAL_IMAGE = {
  url: `${SITE_URL}/social/openteam-2026-09-13.png`,
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "OpenTeam — Run your own AI team. Digital workers on your compute. Open source and self-hosted, with the teal 2D OpenTeam bot.",
};

export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const url = new URL(path, SITE_URL).toString();
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      siteName: "OpenTeam",
      locale: "en_US",
      images: [{ ...SOCIAL_IMAGE, secureUrl: SOCIAL_IMAGE.url }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: SOCIAL_IMAGE.url, alt: SOCIAL_IMAGE.alt }],
    },
  };
}
