import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";
import { pageMetadata, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "@/lib/page-metadata";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  ...pageMetadata({ title: SITE_TITLE, description: SITE_DESCRIPTION, path: "/" }),
  icons: {
    icon: [
      { url: "/favicon-32.png?v=1", type: "image/png", sizes: "32x32" },
      { url: "/favicon.svg?v=2", type: "image/svg+xml", sizes: "any" },
    ],
    apple: [{ url: "/apple-touch-icon.png?v=1", type: "image/png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <body>
        {/* Sets the motion flag before first paint so nothing hidden by CSS flashes. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.setAttribute('data-motion','')}catch(e){}",
          }}
        />
        {children}
        <Toaster position="bottom-center" />
      </body>
    </html>
  );
}
