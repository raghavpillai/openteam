export function pluginOAuthPage(
  outcome: "connected" | "cancelled" | "failed" | "stale",
  status = 200
): Response {
  const [title, message] = {
    connected: ["Plugin connected", "You can close this tab and return to OpenTeam."],
    cancelled: [
      "Authorization cancelled",
      "Your setup is saved. Return to OpenTeam to try again when you’re ready.",
    ],
    failed: [
      "Could not finish sign-in",
      "Return to OpenTeam for connection details and try again. Your setup is saved.",
    ],
    stale: [
      "This sign-in is no longer active",
      "It expired, was cancelled, or was replaced. Return to OpenTeam and start a new sign-in.",
    ],
  }[outcome];
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;background:#171717;color:#f5f5f5}main{text-align:center;max-width:460px}p{color:#a3a3a3;line-height:1.5}button{font:inherit;border:0;border-radius:20px;padding:10px 18px;cursor:pointer}</style><main><h1>${title}</h1><p>${message}</p><button id="close">Close tab</button></main><script nonce="${nonce}">history.replaceState(null,'',location.pathname);document.getElementById('close').onclick=()=>window.close();${outcome === "connected" ? "setTimeout(()=>window.close(),900);" : ""}</script></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      },
    }
  );
}
