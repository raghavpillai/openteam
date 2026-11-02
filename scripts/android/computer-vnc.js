import RFB from "@novnc/novnc/core/rfb.js";
import KeyTable from "@novnc/novnc/core/input/keysym.js";
import Keysyms from "@novnc/novnc/core/input/keysymdef.js";

let rfb;
let connected = false;
let controlling = false;
let pointer = { x: 0, y: 0 };
let buttons = 0;

const host = document.getElementById("screen");
const native = (method, value) => {
  try {
    window.openTeamNative?.[method]?.(value);
  } catch {
    // The viewer can still render when the native bridge is unavailable.
  }
};

function mouse(type, x = pointer.x, y = pointer.y, held = buttons, button = 0) {
  const canvas = host.querySelector("canvas");
  if (!canvas || !connected) return;
  const rect = canvas.getBoundingClientRect();
  pointer = { x, y };
  buttons = held;
  canvas.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    buttons: held,
    clientX: rect.left + x * rect.width / canvas.width,
    clientY: rect.top + y * rect.height / canvas.height,
  }));
}

function release() {
  if (buttons) mouse("mouseup", pointer.x, pointer.y, 0);
}

function stop() {
  release();
  const previous = rfb;
  rfb = undefined;
  connected = false;
  controlling = false;
  previous?.disconnect();
  host.replaceChildren();
}

function control(active) {
  if (!active) release();
  controlling = active;
  if (rfb) rfb.viewOnly = !active;
}

function key(name, down = true) {
  const symbol = KeyTable["XK_" + name] ??
    (name.length === 1 ? Keysyms.lookup(name.codePointAt(0)) : undefined);
  if (!symbol) throw Error("Unsupported computer key");
  rfb.sendKey(symbol, undefined, down);
}

function type(text) {
  if (typeof text !== "string" || text.length > 10000) throw Error("Invalid computer text");
  for (const character of text) {
    const symbol = character === "\n" || character === "\r"
      ? KeyTable.XK_Return
      : character === "\t"
        ? KeyTable.XK_Tab
        : Keysyms.lookup(character.codePointAt(0));
    if (symbol) rfb.sendKey(symbol);
  }
}

window.openTeamVnc = {
  stop,
  control,
  async connect(session) {
    stop();
    const url = new URL(session.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw Error("Invalid computer endpoint");
    }
    const current = new RFB(host, url.href, {
      credentials: { password: session.password },
      wsProtocols: session.protocols,
    });
    rfb = current;
    current.scaleViewport = true;
    current.resizeSession = false;
    current.focusOnClick = true;
    current.showDotCursor = false;
    current.qualityLevel = 6;
    current.compressionLevel = 2;
    current.viewOnly = !controlling;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        current.disconnect();
        reject(Error("Computer connection timed out"));
      }, 15000);
      current.addEventListener("connect", () => {
        clearTimeout(timeout);
        if (rfb !== current) {
          current.disconnect();
          reject(Error("Computer connection cancelled"));
          return;
        }
        connected = true;
        native("connected");
        resolve(true);
      });
      current.addEventListener("disconnect", (event) => {
        clearTimeout(timeout);
        if (rfb === current) {
          connected = false;
          native("disconnected", event?.detail?.reason ?? "");
        }
        reject(Error("Computer disconnected"));
      });
      current.addEventListener("securityfailure", () => {
        clearTimeout(timeout);
        native("failed", "Computer authentication failed");
        current.disconnect();
        reject(Error("Computer authentication failed"));
      });
    });
    return true;
  },
  input(input) {
    if (!connected || !controlling) throw Error("Take control before using the computer");
    switch (input.action) {
      case "move":
        mouse("mousemove", input.x, input.y, 0);
        break;
      case "click": {
        const right = input.button === "right";
        const held = right ? 2 : 1;
        for (let n = 0; n < (input.double ? 2 : 1); n += 1) {
          mouse("mousedown", input.x, input.y, held, right ? 2 : 0);
          mouse("mouseup", input.x, input.y, 0, right ? 2 : 0);
        }
        break;
      }
      case "type":
        type(input.text);
        break;
      case "key":
        for (const combo of input.keys) {
          const names = combo.split("+").map((name) => ({
            Control: "Control_L",
            Shift: "Shift_L",
            Alt: "Alt_L",
            Super: "Super_L",
          }[name] ?? name));
          const modifiers = names.slice(0, -1);
          try {
            modifiers.forEach((name) => key(name, true));
            key(names.at(-1));
          } finally {
            modifiers.reverse().forEach((name) => key(name, false));
          }
        }
        break;
      default:
        throw Error("Unsupported computer input");
    }
    return true;
  },
};
