import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Wordmark } from "./brand";

const GITHUB = "https://github.com/raghavpillai/openteam";

export function SiteFooter({ home = false }: { home?: boolean }) {
  return (
    <footer className="ot-footer ot-container">
      <div className="ot-footer-top">
        <a href={home ? "#top" : "/"} className="ot-wordmark" aria-label="OpenTeam home">
          <Wordmark size={36} textSize={24} animated />
        </a>
        <p>Your AI team, running on your server.</p>
        <nav aria-label="Footer navigation">
          <a href={GITHUB}>GitHub</a>
          <Link href="/docs">Docs</Link>
          <a href="/download">Download</a>
          <a href={`${GITHUB}/releases`}>Releases</a>
          <a href={`${GITHUB}/issues`}>Issues</a>
        </nav>
      </div>
      <div className="ot-footer-bottom">
        <Link href="/docs/getting-started/installation">Installation guide</Link>
        <a href="#top">
          Back to top <ArrowUpRight size={14} />
        </a>
      </div>
    </footer>
  );
}
