import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { pageMetadata } from "@/lib/page-metadata";
import "../landing.css";
import "../monochrome.css";
import "../support/support.css";

export const metadata = pageMetadata({
  title: "OpenTeam privacy policy",
  description: "How OpenTeam handles your server connection, conversations, files, and optional services.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <div className="landing" id="top">
      <a href="#main" className="ot-skip">Skip to content</a>
      <SiteHeader />
      <main id="main" className="ot-container ot-help">
        <h1>Privacy policy</h1>
        <p className="ot-help-date">Effective November 10, 2026</p>
        <p>This policy covers OpenTeam Client for iPhone and iPad and the OpenTeam website. OpenTeam is open-source software maintained by Raghav Pillai. The app connects to a server you choose and control. Your server operator and the services configured on that server determine how your conversations and files are processed and retained.</p>
        <h2>Your server and account</h2>
        <p>The app sends sign-in requests, messages, attachments, voice notes, settings changes, and task requests to your selected OpenTeam server. That server stores your account, conversations, files, bot memory, connected-service credentials, and most settings. Connection and session information is saved in the device Keychain. The app also caches content and device preferences locally to support its interface.</p>
        <h2>AI models and connected services</h2>
        <p>Your server sends the content needed for your tasks to the model providers and connected services you configure. Depending on your settings, this can include messages, files, search queries, webpage addresses, voice recordings for transcription, and requests to connected accounts. Those providers have their own privacy and retention policies. You can configure a local model server. Disconnect services or change provider settings on your server to control future access.</p>
        <h2>Permissions and notifications</h2>
        <p>Camera and microphone access are used when you choose to capture a photo or record a voice note. Photo-library access is used when you choose to save a photo. You can manage these permissions in iOS Settings. If you enable push notifications, the app registers its notification token with your server and notifications pass through Apple Push Notification service. Notification previews may contain conversation content.</p>
        <h2>Siri, Shortcuts, and Spotlight</h2>
        <p>Shortcuts use your saved server connection to carry out actions you request. Optional Siri and Spotlight discovery makes a limited selection of conversations and messages available to the system on your device. You can disable discovery in the app's Siri and Spotlight settings. Disabling discovery or signing out clears the app's donated discovery content.</p>
        <h2>Website requests and support</h2>
        <p>The app checks openteam.so for beta update information when running a TestFlight build. Opening the website, documentation, or other external links sends a normal web request to that service, including your IP address and browser or network information. Our hosting provider processes requests to serve and protect the website. If you contact support, we receive the contact information and content you send. Please keep passwords, API keys, and private conversations out of support reports.</p>
        <h2>Retention and deletion</h2>
        <p>Your server operator controls server retention and backups. Delete conversations and files using the server's available controls, and contact its operator to request account or server-data deletion. Backups may retain earlier copies according to that operator's backup policy. Signing out removes the app's saved session and discovery content. Removing the app removes its local app container. Revoke notification permission and disconnect connected accounts to stop their future use. Contact us to request deletion of support correspondence.</p>
        <h2>Tracking and sharing</h2>
        <p>We do not sell personal data or use the iOS app for advertising tracking. The app contains no third-party advertising or analytics SDK. Data you send to your server and its configured providers is used to provide the features you request. We may disclose support correspondence or service records when required by law.</p>
        <h2>Changes and contact</h2>
        <p>We will publish policy changes on this page with an updated effective date. For privacy questions or requests, email <a href="mailto:me@raghav.sh">me@raghav.sh</a>. For help connecting to your server, visit <Link href="/support">OpenTeam support</Link>.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
