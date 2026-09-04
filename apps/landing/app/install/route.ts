import { installScript } from "@/lib/install-script";

export const dynamic = "force-static";

export function GET() {
  return new Response(installScript, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Content-Disposition": 'inline; filename="openteam-install.sh"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
