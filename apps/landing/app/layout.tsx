import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

const title = "OpenTeam | Run your own AI team";
const description =
  "Digital workers that run on your compute and work in your apps. They have their own computer and shared workspace, remember your instructions, and delegate work to each other.";

export const metadata: Metadata = {
  metadataBase: new URL("https://openteam.so"),
  title,
  description,
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/favicon.svg?v=2", type: "image/svg+xml", sizes: "any" }],
  },
  openGraph: {
    title,
    description,
    type: "website",
    url: "/",
    siteName: "OpenTeam",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "OpenTeam" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
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
              "try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.setAttribute('data-motion','')}catch(e){}",
          }}
        />
        {children}
        <Toaster position="bottom-center" />
      </body>
    </html>
  );
}
