import { ArrowDown, ArrowUpRight, Check, Server, Terminal } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { CopyCommand } from "@/components/copy-command";
import { DownloadOptions } from "@/components/download-options";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { LandingEffects } from "@/components/landing-effects";
import { SectionBot } from "@/components/section-bot";
import { Button } from "@/components/ui/button";
import "../landing.css";
import "./download.css";
import "../monochrome.css";
import "../alive.css";

const GITHUB = "https://github.com/raghavpillai/openteam";
const INSTALL_COMMAND = "curl -fsSL https://openteam.so/install | sh";
const WINDOWS_INSTALL_COMMAND = "irm https://openteam.so/install.ps1 | iex";

export const metadata = pageMetadata({
  title: "Download OpenTeam",
  description:
    "Install the OpenTeam server and download the desktop app for macOS, Windows, or Linux.",
  path: "/download",
});

export default function DownloadPage() {
  return (
    <div className="landing ot-download" id="top">
      <LandingEffects />
      <a href="#main" className="ot-skip">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="ot-container">
        <section className="dl-hero ot-bot-section">
          <div>
            <h1>
              <span className="ot-title-line"><span>Install the server. </span></span>
              <span className="ot-title-line"><span>Connect the app.</span></span>
            </h1>
          </div>
          <div className="dl-intro">
            <p>
              Run the server on a machine that stays on. Connect the desktop app to message agents,
              watch their screens, and review their work.
            </p>
            <div className="dl-jump-links">
              <a href="#server">
                Install the server <ArrowDown size={15} />
              </a>
              <a href="#desktop">
                Download the app <ArrowDown size={15} />
              </a>
            </div>
          </div>
          <SectionBot bot="research" />
        </section>

        <section id="server" className="dl-step ot-bot-section">
          <div className="dl-step-heading">
            <h2>Install the server.</h2>
            <p>Run guided setup on a VPS, home server, or spare machine. Create your account and connect a model.</p>
          </div>
          <div className="dl-step-content">
            <div className="dl-terminal">
              <div className="dl-terminal-title">
                <Terminal size={17} />
                <span>Guided setup</span>
                <span>~ /</span>
              </div>
              <div className="dl-terminal-body">
                <div className="dl-command-group">
                  <p>macOS and Linux</p>
                  <CopyCommand
                    command={INSTALL_COMMAND}
                    label="Copy macOS and Linux install command"
                  />
                </div>
                <div className="dl-command-group">
                  <p>Windows PowerShell</p>
                  <CopyCommand
                    command={WINDOWS_INSTALL_COMMAND}
                    label="Copy Windows install command"
                  />
                </div>
              </div>
              <p className="dl-terminal-note">
                <Server size={15} /> Setup gives you the server URL to connect your apps.
              </p>
            </div>
            <div className="dl-requirements">
              {["Docker Compose 2.20+", "8 GB RAM recommended", "macOS, Windows, or Linux"].map(
                (item) => (
                  <span key={item}>
                    <Check size={15} />
                    {item}
                  </span>
                )
              )}
            </div>
            <p className="dl-setup-note">
              Requires a running Docker Engine and Compose. Use Docker Engine on Linux or Docker
              Desktop on macOS and Windows. No Node.js or Bun required.
            </p>
            <div className="dl-source-links">
              <a href="/install/source" className="ot-text-link">
                Read the install scripts <ArrowUpRight size={15} />
              </a>
              <Link href="/docs/getting-started/installation" className="ot-text-link">
                Installation guide <ArrowUpRight size={15} />
              </Link>
            </div>
          </div>
          <SectionBot bot="engineering" side="right" />
        </section>

        <section id="desktop" className="dl-step ot-bot-section">
          <div className="dl-step-heading">
            <h2>Download the app.</h2>
            <p>Enter the server URL from setup, sign in, and create your first agent.</p>
          </div>
          <div className="dl-step-content">
            <DownloadOptions />
          </div>
          <SectionBot bot="operations" />
        </section>

        <section id="mobile" className="dl-step dl-mobile-step ot-bot-section">
          <div className="dl-step-heading">
            <h2>Build the iPhone companion.</h2>
            <p>Connect to the same server and continue your conversations from your phone.</p>
          </div>
          <div className="dl-phone-card">
            <div className="dl-phone-icon">
              <Image src="/openteam-app-icon.png" alt="OpenTeam app icon" width={52} height={52} unoptimized />
            </div>
            <div>
              <h3>Available from source.</h3>
              <p>
                App Store and TestFlight builds are not available yet. The iPhone app is included in
                the repository.
              </p>
              <Button
                className="ot-button"
                render={<a href={`${GITHUB}/tree/main/apps/ios`} />}
                nativeButton={false}
              >
                View iPhone source <ArrowUpRight size={16} />
              </Button>
            </div>
          </div>
          <SectionBot bot="research" side="right" />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
