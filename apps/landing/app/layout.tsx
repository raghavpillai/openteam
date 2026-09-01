import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://openteam.so"),
  title: "OpenBot | Self-hosted agents that keep working",
  description:
    "Give AI agents a persistent computer, shared files, durable context, and scheduled work on infrastructure you control.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "OpenBot | Self-hosted agents that keep working",
    description: "Hand off a job, close the app, and come back to the files.",
    type: "website",
    url: "/",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "OpenBot, self-hosted agents that keep working",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenBot | Self-hosted agents that keep working",
    description: "Hand off a job, close the app, and come back to the files.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
