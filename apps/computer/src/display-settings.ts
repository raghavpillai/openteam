type Dimensions = { width: number; height: number };

/** Keep existing desktops usable while the control server is unavailable. */
export class ComputerDisplaySettings {
  private cached?: Dimensions;
  private expires = 0;
  private pending?: Promise<Dimensions>;

  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly now = () => performance.now()
  ) {}

  async get(): Promise<Dimensions> {
    // A cold start still requires real, validated settings. Once loaded, refresh
    // in the background so a server outage cannot block an existing desktop.
    if (!this.cached) return this.refresh();
    if (this.now() >= this.expires) void this.refresh().catch(() => {});
    return this.cached;
  }

  private refresh(): Promise<Dimensions> {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve()
      .then(this.load)
      .then((value) => {
        if (!value || typeof value !== "object") throw Error("Invalid computer display dimensions");
        const { width, height } = value as Record<string, unknown>;
        if (
          typeof width !== "number" ||
          typeof height !== "number" ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 640 ||
          width > 7680 ||
          height < 480 ||
          height > 4320
        )
          throw Error("Invalid computer display dimensions");
        this.cached = { width, height };
        this.expires = this.now() + 30_000;
        return this.cached;
      })
      .catch((error) => {
        this.expires = this.now() + 5000;
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
