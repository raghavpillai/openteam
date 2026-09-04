import { ArrowLeft, ArrowUpRight, CheckCircle2, Server, Smartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { GithubMark, Wordmark } from "@/components/brand";
import { CopyCommand } from "@/components/copy-command";
import { DownloadOptions } from "@/components/download-options";
import { Button } from "@/components/ui/button";

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
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line/80 bg-paper/85 backdrop-blur-md">
        <div className="container-page flex h-16 items-center gap-4">
          <Link href="/" aria-label="OpenTeam home" className="shrink-0">
            <Wordmark size={22} />
          </Link>
          <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
          <span className="hidden text-[14px] text-ink-2 sm:block">Download</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="lg"
              className="h-10 gap-2 px-3 text-[13.5px] text-ink-2 hover:text-ink"
              render={<a href={GITHUB} />}
              nativeButton={false}
            >
              <GithubMark />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-10 gap-2 border-line-strong bg-surface px-3.5 text-[13.5px]"
              render={<Link href="/" />}
              nativeButton={false}
            >
              <ArrowLeft />
              Home
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="pb-24">
        <section className="relative overflow-hidden border-b border-line">
          <div className="dot-grid absolute inset-0 -z-10" aria-hidden="true" />
          <div className="container-page py-16 text-center sm:py-20">
            <p className="microlabel">Get OpenTeam</p>
            <h1 className="display mx-auto mt-4 max-w-[14ch] text-[48px] leading-[1.02] text-ink sm:text-[68px]">
              Install the server. Bring the app.
            </h1>
            <p className="mx-auto mt-5 max-w-[620px] text-[17px] leading-[1.6] text-ink-2 sm:text-[18px]">
              The server keeps your bots working. The desktop app lets you message them, watch their
              screens, and step in from your own computer.
            </p>
          </div>
        </section>

        <div className="container-page max-w-[980px]">
          <section className="grid gap-8 py-14 sm:py-18 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14">
            <div>
              <p className="font-mono text-[13px] text-ink-3">[1]</p>
              <h2 className="mt-2 text-[19px] font-semibold text-ink">OpenTeam server</h2>
              <p className="mt-2 text-[14px] leading-[1.55] text-ink-3">
                Linux or macOS · x64 or arm64
              </p>
            </div>

            <div>
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-raised">
                  <Server className="size-5 text-ink-2" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="font-medium text-ink">One-command guided setup</h3>
                  <p className="text-[13.5px] text-ink-3">
                    Downloads a verified native CLI from GitHub and opens setup.
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-2.5">
                <div>
                  <p className="mb-2 font-mono text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
                    macOS and Linux
                  </p>
                  <CopyCommand command={INSTALL_COMMAND} />
                </div>
                <div>
                  <p className="mb-2 font-mono text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
                    Windows PowerShell
                  </p>
                  <CopyCommand command={WINDOWS_INSTALL_COMMAND} />
                </div>
              </div>

              <div className="mt-5 grid gap-3 text-[13.5px] text-ink-2 sm:grid-cols-3">
                {[
                  "Docker Compose 2.20+",
                  "8 GB memory recommended",
                  "No Node.js or Bun required",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-live" aria-hidden="true" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-[13.5px] leading-[1.6] text-ink-3">
                Review the script at{" "}
                <a className="text-ink underline underline-offset-4" href="/install">
                  openteam.so/install
                </a>{" "}
                before running it. Set{" "}
                <code className="font-mono text-[12.5px] text-ink-2">OPENTEAM_VERSION</code> to
                install a specific release.
              </p>
            </div>
          </section>

          <div className="h-px bg-line" />

          <section className="grid gap-8 py-14 sm:py-18 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14">
            <div>
              <p className="font-mono text-[13px] text-ink-3">[2]</p>
              <h2 className="mt-2 text-[19px] font-semibold text-ink">Desktop app</h2>
              <p className="mt-2 text-[14px] leading-[1.55] text-ink-3">
                Choose the detected build or any alternative.
              </p>
            </div>
            <DownloadOptions />
          </section>

          <div className="h-px bg-line" />

          <section className="grid gap-8 py-14 sm:py-18 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14">
            <div>
              <p className="font-mono text-[13px] text-ink-3">[3]</p>
              <h2 className="mt-2 text-[19px] font-semibold text-ink">iPhone app</h2>
              <p className="mt-2 text-[14px] leading-[1.55] text-ink-3">
                Mobile access to the same server.
              </p>
            </div>
            <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card sm:flex-row sm:items-center">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-raised">
                <Smartphone className="size-5 text-ink-2" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-medium text-ink">Build from source</h3>
                <p className="mt-1 text-[13.5px] leading-[1.55] text-ink-3">
                  App Store and TestFlight distribution are not set up yet. The iPhone app is
                  available in the repository.
                </p>
              </div>
              <Button
                variant="outline"
                size="lg"
                className="h-10 shrink-0 gap-2 border-line-strong bg-surface px-3.5"
                render={<a href={`${GITHUB}/tree/main/apps/mobile`} />}
                nativeButton={false}
              >
                View source
                <ArrowUpRight />
              </Button>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="container-page flex flex-col gap-5 py-9 sm:flex-row sm:items-center sm:justify-between">
          <Wordmark size={18} />
          <div className="flex flex-wrap gap-x-5 text-[13.5px] text-ink-2">
            <a className="py-2 hover:text-ink" href={`${GITHUB}/blob/main/docs/deployment.md`}>
              Deployment guide
            </a>
            <a className="inline-flex items-center gap-1.5 py-2 hover:text-ink" href={GITHUB}>
              <GithubMark className="size-3.5" /> GitHub
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
