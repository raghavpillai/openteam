import RFB from '@novnc/novnc/core/rfb.js';
import KeyTable from '@novnc/novnc/core/input/keysym.js';
import Keysyms from '@novnc/novnc/core/input/keysymdef.js';

// Only native code supplies single-use grants. The owner token never enters WebKit.
let rfb, connected = false, controlling = false, pointer = {x: 0, y: 0}, buttons = 0;
const host = document.getElementById('screen');
const still = document.getElementById('still');
const notify = (event) => window.webkit.messageHandlers.computer.postMessage({event});
function mouse(type, x = pointer.x, y = pointer.y, held = buttons, button = 0) {
  const canvas = host.querySelector('canvas');
  if (!canvas || !connected) return;
  const rect = canvas.getBoundingClientRect();
  pointer = {x, y}; buttons = held;
  canvas.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button, buttons: held,
    clientX: rect.left + x * rect.width / canvas.width,
    clientY: rect.top + y * rect.height / canvas.height}));
}
function release() {
  if (buttons) mouse('mouseup', pointer.x, pointer.y, 0);
}
function stop(clear = false) {
  release();
  if (rfb && connected && !clear) {
    try { still.src = rfb.toDataURL('image/jpeg', .8); still.hidden = false; } catch {}
  }
  const previous = rfb;
  rfb = undefined; connected = false;
  previous?.disconnect();
  host.replaceChildren();
  if (clear) { still.removeAttribute('src'); still.hidden = true; }
}
function control(active) {
  if (!active) release();
  controlling = active;
  if (rfb) rfb.viewOnly = !active;
}
function key(name, down) {
  const symbol = KeyTable['XK_' + name] ?? (name.length === 1 ? Keysyms.lookup(name.codePointAt(0)) : undefined);
  if (!symbol) throw Error('Unsupported computer key');
  rfb.sendKey(symbol, undefined, down);
}
function type(text) {
  if (typeof text !== 'string' || text.length > 10000) throw Error('Invalid computer text');
  for (const character of text) {
    const symbol = character === '\n' || character === '\r' ? KeyTable.XK_Return :
      character === '\t' ? KeyTable.XK_Tab : Keysyms.lookup(character.codePointAt(0));
    rfb.sendKey(symbol);
  }
}
window.computer = {
  stop, control,
  async connect(session) {
    stop();
    const url = new URL(session.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error('Invalid computer endpoint');
    const current = new RFB(host, url.href, {credentials: {password: session.password}, wsProtocols: session.protocols});
    rfb = current;
    current.scaleViewport = true;
    current.resizeSession = false;
    current.focusOnClick = false;
    current.showDotCursor = false;
    current.qualityLevel = 6;
    current.compressionLevel = 2;
    current.viewOnly = !controlling;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(Error('Computer connection timed out')); current.disconnect(); }, 12000);
      current.addEventListener('connect', () => {
        clearTimeout(timeout);
        if (rfb !== current) { current.disconnect(); reject(Error('Cancelled')); return; }
        connected = true;
        still.hidden = true; still.removeAttribute('src');
        resolve(true);
      });
      current.addEventListener('disconnect', () => {
        clearTimeout(timeout);
        reject(Error('Computer disconnected'));
        if (rfb !== current) return;
        stop(); notify('disconnected');
      });
      current.addEventListener('securityfailure', () => {
        clearTimeout(timeout); reject(Error('Computer authentication failed')); current.disconnect();
      });
    });
    return true;
  },
  input(input) {
    if (!connected || !controlling) throw Error('Take control before using the computer');
    switch (input.action) {
      case 'pointer': mouse(input.phase, input.x, input.y, input.buttons); break;
      case 'move': mouse('mousemove', input.x, input.y, 0); break;
      case 'click': {
        const right = input.button === 'right', held = right ? 2 : 1;
        for (let n = 0; n < (input.double ? 2 : 1); n++) {
          mouse('mousedown', input.x, input.y, held, right ? 2 : 0);
          mouse('mouseup', input.x, input.y, 0, right ? 2 : 0);
        }
        break;
      }
      case 'scroll': {
        const canvas = host.querySelector('canvas'), rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          deltaY: Math.max(-20, Math.min(20, input.deltaY)) * 50}));
        break;
      }
      case 'type': type(input.text); break;
      case 'key':
        for (const combo of input.keys) {
          const names = combo.split('+').map(name => ({Control: 'Control_L', Shift: 'Shift_L', Alt: 'Alt_L', Super: 'Super_L'}[name] ?? name));
          const modifiers = names.slice(0, -1);
          try { modifiers.forEach(name => key(name, true)); key(names.at(-1)); }
          finally { modifiers.reverse().forEach(name => key(name, false)); }
        }
        break;
      default: throw Error('Unsupported computer input');
    }
    return true;
  }
};
