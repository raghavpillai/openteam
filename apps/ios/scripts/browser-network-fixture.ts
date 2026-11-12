/** Inert device-event fixture for native interface tests; never routes real traffic. */
export class BrowserNetworkFixture {
  settings = {
    deploymentId: "ui-test-deployment",
    mode: "ranked",
    machineId: null,
    revision: 1,
    sourceOrder: ["air", "mini", "server"],
  };
  devices = [
    {
      machineId: "air",
      label: "MacBook Air",
      enabled: true,
      connected: true,
      sharingAllowed: true,
      supported: true,
    },
    {
      machineId: "mini",
      label: "Mac mini",
      enabled: true,
      connected: true,
      sharingAllowed: true,
      supported: true,
    },
  ];
  patches: unknown[] = [];
  protocols = ["working", "unavailable"];
  staleProtocols = false;
  view() {
    const id = this.settings.sourceOrder.find(
      (id) =>
        id === "server" ||
        this.devices.some((d) => d.machineId === id && d.enabled && d.connected && d.sharingAllowed)
    )!;
    return {
      settings: this.settings,
      devices: this.devices.map((d) => ({
        ...d,
        working: d.enabled && d.connected && d.sharingAllowed,
      })),
      runtime: {
        routeEpoch: `${this.settings.revision}-${id}`,
        connectivity: {
          epoch: this.staleProtocols ? "obsolete" : `${this.settings.revision}-${id}`,
          sourceId: id, checkedAt: "2026-11-10T03:15:00.000Z",
          ipv4: { state: this.protocols[0] },
          ipv6: { state: this.protocols[1], ...(this.protocols[1] === "unavailable" ? { reason: "connect_failed" } : {}) },
        },
        state: id === "server" ? "server" : "ready",
        activeMachineId: id === "server" ? null : id,
        appliedRevision: this.settings.revision,
        activeConnections: 0,
        bytesSent: 0,
        bytesReceived: 0,
        blockedConnections: 0,
      },
    };
  }
  control(input: any) {
    if (input.protocols) this.protocols = input.protocols;
    if (typeof input.staleProtocols === "boolean") this.staleProtocols = input.staleProtocols;
    if (input.sourceOrder) {
      this.settings.sourceOrder = input.sourceOrder;
      this.settings.revision++;
    }
    for (const update of input.devices ?? [])
      Object.assign(this.devices.find((d) => d.machineId === update.machineId) ?? {}, update);
  }
  handle(path: string, method: string, input: any): Response | null {
    if (path === "/api/v0/server-settings/browser-network/quality" && method === "POST") {
      const view = this.view();
      return Response.json({
        epoch: view.runtime.routeEpoch,
        sourceId: view.runtime.activeMachineId ?? "server",
        checkedAt: new Date().toISOString(),
        latencyMs: 42,
        downloadMbps: 28.4,
        uploadMbps: 9.2,
        downloadBytes: 1048576,
        uploadBytes: 262144,
      });
    }
    if (path === "/api/v0/server-settings/browser-network/egress" && method === "POST") {
      const view = this.view();
      const id = view.runtime.activeMachineId ?? "server";
      return Response.json({
        epoch: view.runtime.routeEpoch,
        sourceId: id,
        ip: id === "air" ? "203.0.113.10" : id === "mini" ? "198.51.100.20" : "192.0.2.30",
        location:
          id === "air"
            ? "New York, United States"
            : id === "mini"
              ? "Boston, United States"
              : "Ashburn, United States",
        checkedAt: new Date().toISOString(),
      });
    }
    if (path !== "/api/v0/server-settings/browser-network") return null;
    if (method === "PATCH") {
      if (input.expectedRevision !== this.settings.revision)
        return Response.json(
          { message: "The browser connection changed. Refresh settings and try again." },
          { status: 409 }
        );
      if (
        input.mode !== "ranked" ||
        input.machineId !== null ||
        !Array.isArray(input.sourceOrder) ||
        !input.sourceOrder.includes("server") ||
        new Set(input.sourceOrder).size !== input.sourceOrder.length
      )
        return Response.json(
          { message: "Rank connections with the server included once" },
          { status: 400 }
        );
      this.settings = {
        ...this.settings,
        sourceOrder: input.sourceOrder,
        revision: this.settings.revision + 1,
      };
      this.patches.push(input);
    }
    return Response.json(this.view());
  }
}
