import type { Metadata, Viewport } from "next";
import "./globals.css";

const title = "OpenBot — self-hosted AI agents that keep working";
const description =
  "Give AI agents their own computer, memory, and schedule on a server you run. Hand off a job from your desktop or phone and come back to the finished result.";

export const metadata: Metadata = {
  metadataBase: new URL("https://openteam.so"),
  title,
  description,
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    title,
    description,
    type: "website",
    url: "/",
    siteName: "OpenBot",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "OpenBot" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#fbfbfa",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
