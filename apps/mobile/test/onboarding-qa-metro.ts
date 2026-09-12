// A separate loopback proxy selects the QA entry without changing package.json or
// the app's native bundle URL. Expo's development reload restores its default entry.
Bun.serve({
  hostname: "127.0.0.1",
  port: 8084,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    url.host = "localhost:8083";
    if (url.pathname.endsWith(".bundle")) {
      url.pathname = "/apps/mobile/test/onboarding-qa-entry.bundle";
    }
    return fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });
  },
});
console.log("Onboarding QA Metro proxy: http://127.0.0.1:8084 → localhost:8083");
