import { ArrowLeft, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { installScript, powerShellInstallScript } from "@/lib/install-script";

export const metadata: Metadata = {
  title: "Review the OpenTeam installer",
  description: "Read the exact macOS, Linux, and Windows bootstrap scripts before running them.",
  alternates: { canonical: "/install/source" },
};

const ScriptSource = ({
  title,
  rawHref,
  source,
}: {
  title: string;
  rawHref: string;
  source: string;
}) => (
  <section className="mt-10">
    <div className="flex items-center justify-between gap-4">
      <h2 className="text-[19px] font-semibold text-ink">{title}</h2>
      <a
        href={rawHref}
        className="inline-flex items-center gap-1.5 text-[13.5px] text-ink-2 underline underline-offset-4 hover:text-ink"
      >
        Raw script <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </div>
    <pre className="mt-3 max-h-[640px] overflow-auto rounded-2xl border border-line bg-ink p-5 text-[12px] leading-[1.65] text-paper shadow-card">
      <code>{source}</code>
    </pre>
  </section>
);

export default function InstallSourcePage() {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line/80 bg-paper/85 backdrop-blur-md">
        <div className="container-page flex h-16 items-center gap-4">
          <Link href="/" aria-label="OpenTeam home" className="shrink-0">
            <Wordmark size={22} />
          </Link>
          <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
          <span className="hidden text-[14px] text-ink-2 sm:block">Installer source</span>
          <Button
            variant="outline"
            size="lg"
            className="ml-auto h-10 gap-2 border-line-strong bg-surface px-3.5 text-[13.5px]"
            render={<Link href="/download" />}
            nativeButton={false}
          >
            <ArrowLeft /> Download
          </Button>
        </div>
      </header>

      <main className="container-page max-w-[980px] pb-24 pt-14 sm:pt-18">
        <p className="microlabel">Installer source</p>
        <h1 className="mt-4 max-w-[16ch] text-[40px] font-semibold leading-[1.08] tracking-[-0.035em] text-ink sm:text-[52px]">
          Read exactly what the one-click installer runs.
        </h1>
        <p className="mt-5 max-w-[680px] text-[16px] leading-[1.65] text-ink-2">
          These are the same scripts served by the raw install URLs. They verify the downloaded
          native CLI checksum, install it for your user, and start the guided server setup.
        </p>

        <ScriptSource title="macOS and Linux" rawHref="/install" source={installScript} />
        <ScriptSource
          title="Windows PowerShell"
          rawHref="/install.ps1"
          source={powerShellInstallScript}
        />
      </main>
    </>
  );
}
