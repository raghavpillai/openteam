import { ArrowUpRight } from "lucide-react";
import { Wordmark } from "./brand";

const GITHUB = "https://github.com/raghavpillai/openteam";

export function SiteFooter({ home = false }: { home?: boolean }) {
  return (
    <footer className="ot-footer ot-container">
      <div className="ot-footer-top">
        <a href={home ? "#top" : "/"} className="ot-wordmark" aria-label="OpenTeam home">
          <Wordmark size={36} textSize={24} />
        </a>
        <p>Your AI team, running on your server.</p>
        <nav aria-label="Footer navigation">
          <a href={GITHUB}>GitHub</a>
          <a href="/download">Download</a>
          <a href={`${GITHUB}/releases`}>Releases</a>
          <a href={`${GITHUB}/issues`}>Issues</a>
        </nav>
      </div>
      <div className="ot-footer-bottom">
        <span>Source code available on GitHub.</span>
        <a href="#top">
          Back to top <ArrowUpRight size={14} />
        </a>
      </div>
    </footer>
  );
}
