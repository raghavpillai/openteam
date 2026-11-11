import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { pageMetadata } from "@/lib/page-metadata";
import "../landing.css";
import "../monochrome.css";
import "./support.css";

export const metadata = pageMetadata({
  title: "OpenTeam Client support",
  description: "Get help installing your OpenTeam server and connecting the iPhone and iPad app.",
  path: "/support",
});

export default function SupportPage() {
  return (
    <div className="landing" id="top">
      <a href="#main" className="ot-skip">Skip to content</a>
      <SiteHeader />
      <main id="main" className="ot-container ot-help">
        <h1>OpenTeam support</h1>
        <p>OpenTeam Client for iPhone and iPad connects to your own OpenTeam server. You need a running server and its sign-in details to use the app.</p>
        <h2>Set up your server</h2>
        <p>Follow the <Link href="/docs/getting-started/installation">installation guide</Link> to install the server, configure a model provider, and create your server account. Keep the server running on a computer your phone or tablet can reach.</p>
        <h2>Connect the app</h2>
        <p>Tap Get started, enter the server address printed by setup, and sign in using your server account. For a local address, connect your device to the same network and allow Local Network access in iOS Settings. For access away from home, use your configured secure remote address or VPN.</p>
        <h2>Connection or sign-in problems</h2>
        <p>Check that the server is running and that its address opens from your device. Verify the address, port, and account details. If you forgot the password, run <code>openteam account update --password</code> on the server. Your server operator can help with server access, backups, and account deletion.</p>
        <h2>Messages, voice notes, and notifications</h2>
        <p>Bot replies require a working model provider on your server. Voice-note transcription requires a configured transcription provider and microphone permission. Push notifications require notification permission and a server configured for mobile notifications. See the <Link href="/docs">documentation</Link> for setup and troubleshooting.</p>
        <h2>Contact</h2>
        <p>Email <a href="mailto:me@raghav.sh">me@raghav.sh</a> or <a href="https://github.com/raghavpillai/openteam/issues">open a GitHub issue</a>. Include your app version, iOS version, and the steps that caused the problem. Keep account passwords, API keys, and private messages out of reports.</p>
        <p><Link href="/privacy">Read the privacy policy</Link>.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
