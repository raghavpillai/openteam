import Link from "next/link";

export default function DocNotFound() {
  return (
    <main id="docs-content" className="docs-main docs-not-found">
      <p className="docs-eyebrow">Documentation</p>
      <h1>Page not found</h1>
      <p>This guide may have moved. Choose a page in the sidebar or return to the introduction.</p>
      <Link href="/docs">Back to documentation</Link>
    </main>
  );
}
