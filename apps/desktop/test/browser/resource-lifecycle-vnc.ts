// The real BotScreen/VncComputer lifecycle runs against this transport adapter.
// No external machine is contacted and no native input is captured.
const state = { connections: 0, disconnections: 0, live: 0 };
Object.assign(window, { vncFixture: state });
export default class RFB extends EventTarget {
  private canvas = document.createElement("canvas");
  private closed = false;
  constructor(container: HTMLElement) {
    super();
    container.append(this.canvas);
    state.connections++;
    state.live++;
    queueMicrotask(() => {
      if (!this.closed) this.dispatchEvent(new Event("connect"));
    });
  }
  disconnect() {
    if (this.closed) return;
    this.closed = true;
    state.disconnections++;
    state.live--;
    this.canvas.remove();
    this.dispatchEvent(new Event("disconnect"));
  }
  focus() {}
  sendKey() {}
  clipboardPasteFrom() {}
  toDataURL() {
    return this.canvas.toDataURL();
  }
}
