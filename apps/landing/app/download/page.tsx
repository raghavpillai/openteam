import { ArrowDown, ArrowUpRight, Check, Server, Smartphone, Terminal } from "lucide-react";
import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "Download OpenTeam",
  description:
    "Install the OpenTeam server and download the desktop app for macOS, Windows, or Linux.",
  alternates: { canonical: "/download" },
};

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
            <p className="ot-eyebrow">GET OPENTEAM</p>
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
            <span className="ot-eyebrow">01 / SERVER</span>
            <h2>Install the server.</h2>
            <p>Use a VPS, home server, or spare computer. This is where your agents run.</p>
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
                <Server size={15} /> Runs on your machine. Connect your own inference provider.
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
              Desktop on macOS and Windows. Downloads the CLI, verifies its SHA-256 checksum, and
              starts guided setup. No Node.js or Bun required.
            </p>
            <p className="dl-version-note">
              Set <code>OPENTEAM_VERSION</code> to install a specific release.
            </p>
            <div className="dl-source-links">
              <a href="/install/source" className="ot-text-link">
                Read the install scripts <ArrowUpRight size={15} />
              </a>
              <a href={`${GITHUB}/blob/main/docs/deployment.md`} className="ot-text-link">
                Deployment guide <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
          <SectionBot bot="engineering" side="right" />
        </section>

        <section id="desktop" className="dl-step ot-bot-section">
          <div className="dl-step-heading">
            <span className="ot-eyebrow">02 / DESKTOP</span>
            <h2>Download the app.</h2>
            <p>Connect to your server, create an agent, and send your first task.</p>
          </div>
          <div className="dl-step-content">
            <DownloadOptions />
          </div>
          <SectionBot bot="operations" />
        </section>

        <section className="dl-step dl-mobile-step ot-bot-section">
          <div className="dl-step-heading">
            <span className="ot-eyebrow">03 / IPHONE</span>
            <h2>Check in from your phone.</h2>
            <p>Use the same agents and conversations when you are away from your desk.</p>
          </div>
          <div className="dl-phone-card">
            <div className="dl-phone-icon">
              <Smartphone size={27} />
            </div>
            <div>
              <h3>Build the iPhone app from source.</h3>
              <p>
                App Store and TestFlight builds are not available yet. The iPhone app is included in
                the repository.
              </p>
              <Button
                className="ot-button"
                render={<a href={`${GITHUB}/tree/main/apps/mobile`} />}
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
