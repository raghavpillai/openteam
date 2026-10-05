import { useCallback, useEffect, useRef, useState } from "react";
import { resolveVncSocketUrl } from "../../client/runtime-url";
import type RFB from "@novnc/novnc";
import type { ScreenClipboardInput, ScreenClipboardView, ScreenVncSessionView } from "@openteam/contracts";

export default function VncComputer({ botId, name, serverUrl, createSession, clipboard, onReady, onClose }: {
  botId: string;
  name: string;
  serverUrl: string;
  createSession: (botId: string, signal: AbortSignal) => Promise<ScreenVncSessionView>;
  clipboard?: (input: ScreenClipboardInput, signal: AbortSignal) => Promise<ScreenClipboardView>;
  onReady: () => void;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [state, setState] = useState("connecting");
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clipboardAPI = useRef(clipboard);
  clipboardAPI.current = clipboard;
  const clipboardQueue = useRef(Promise.resolve());
  const clipboardRequests = useRef(new Set<AbortController>());
  const abortClipboard = useCallback(() => {
    for (const request of clipboardRequests.current) request.abort();
    clipboardRequests.current.clear();
    clipboardQueue.current = Promise.resolve();
  }, []);
  const transferClipboard = useCallback((action: "paste" | "copy" | "cut", shift = false, text?: Promise<string>) => {
    const current = rfb.current;
    if (!current) return;
    // Read the local clipboard at the gesture, before a queued operation can delay it.
    const value = action === "paste" ? (text ?? Promise.resolve().then(() => window.openteam?.clipboard?.readText() ?? navigator.clipboard.readText())) : Promise.resolve("");
    const request = new AbortController();
    clipboardRequests.current.add(request);
    const prepared = value.then(text => ({ text }), () => ({ error: "Clipboard access failed. Use the Edit menu to try again." }));
    const operation = clipboardQueue.current.then(async () => {
      const result = await prepared;
      if (request.signal.aborted || rfb.current !== current) return;
      if ("error" in result) throw new Error(result.error);
      if (!clipboardAPI.current) throw new Error("Update your OpenTeam server to use clipboard sharing.");
      if (result.text.length > 1_000_000) throw new Error("Clipboard text is too large.");
      setError(null);
      const input: ScreenClipboardInput = action === "paste" ? { action, text: result.text, shift } : { action, shift };
      const response = await clipboardAPI.current(input, request.signal);
      if (!request.signal.aborted && rfb.current === current && response.text !== undefined) {
        if (window.openteam?.clipboard) await window.openteam.clipboard.writeText(response.text);
        else await navigator.clipboard.writeText(response.text);
      }
    }).catch(cause => {
      if (!request.signal.aborted && rfb.current === current) {
        setError(cause instanceof Error ? cause.message : "Computer clipboard transfer failed.");
      }
    }).finally(() => clipboardRequests.current.delete(request));
    clipboardQueue.current = operation;
  }, []);
  useEffect(() => {
    const bridge = window.openteam?.clipboard;
    const update = () => bridge?.setComputerActive(state === "connected" && !!container.current?.contains(document.activeElement));
    update();
    document.addEventListener("focusin", update);
    const unsubscribe = bridge?.onComputerAction(action => {
      if (state === "connected" && container.current?.contains(document.activeElement)) transferClipboard(action);
    });
    return () => { document.removeEventListener("focusin", update); unsubscribe?.(); bridge?.setComputerActive(false); };
  }, [state, transferClipboard]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handshake: ReturnType<typeof setTimeout> | undefined;
    let connection: RFB | null = null;
    let pending: AbortController | null = null;
    let delay = 500;
    let established = false;
    const retry = () => {
      if (stopped || timer) return;
      setState(established ? "reconnecting" : "connecting");
      timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
      delay = Math.min(delay * 2, 5000);
    };
    const connect = async () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      try {
        const [{ default: RFB }, session] = await Promise.all([
          import("@novnc/novnc"), createSession(botId, request.signal),
        ]);
        if (stopped || request.signal.aborted || !container.current) return;
        const url = resolveVncSocketUrl(serverUrl, session.path, botId);
        const current = new RFB(container.current, url, {
          credentials: { password: session.password }, wsProtocols: session.protocols,
        });
        connection = current;
        rfb.current = current;
        current.scaleViewport = true;
        current.resizeSession = false;
        current.focusOnClick = true;
        current.showDotCursor = false;
        current.qualityLevel = 6;
        current.compressionLevel = 2;
        handshake = setTimeout(() => current.disconnect(), 12_000);
        current.addEventListener("connect", () => {
          if (stopped || connection !== current) return;
          clearTimeout(handshake);
          established = true;
          delay = 500;
          setError(null);
          setLastFrame(null);
          setState("connected");
          onReady();
          current.focus();
        });
        current.addEventListener("disconnect", () => {
          if (stopped || connection !== current) return;
          clearTimeout(handshake);
          if (established) {
            try { setLastFrame(current.toDataURL("image/jpeg", 0.8)); } catch { /* no frame yet */ }
          }
          connection = null;
          rfb.current = null;
          abortClipboard();
          retry();
        });
        current.addEventListener("securityfailure", () => {
          if (stopped || connection !== current) return;
          clearTimeout(handshake);
          // Reissue the short-lived grant and fetch the current VNC password.
          connection = null;
          rfb.current = null;
          abortClipboard();
          current.disconnect();
          retry();
        });
      } catch (cause) {
        if (stopped || request.signal.aborted) return;
        const status = cause && typeof cause === "object" && "status" in cause ? cause.status : undefined;
        if (status === 404 || status === 501) {
          setLastFrame(null);
          setError("Update your OpenTeam server to use the computer.");
          setState("unavailable");
          return;
        }
        if (status === 401 || status === 403) {
          setLastFrame(null);
          setError("Computer access expired. Sign in and reopen the computer.");
          setState("unavailable");
          return;
        }
        retry();
      }
    };
    const online = () => {
      if (connection || stopped) return;
      clearTimeout(timer);
      timer = undefined;
      delay = 500;
      void connect();
    };
    void connect();
    window.addEventListener("online", online);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(handshake);
      pending?.abort();
      window.removeEventListener("online", online);
      connection?.disconnect();
      rfb.current = null;
      abortClipboard();
    };
  }, [botId, serverUrl, createSession, onReady, abortClipboard]);

  return <div className="absolute inset-0 bg-[#1b1d1f]" data-vnc-state={state}
    onKeyDownCapture={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === "Meta") { event.preventDefault(); event.stopPropagation(); }
      else if ((event.ctrlKey || event.metaKey) && ["v", "c", "x"].includes(event.key.toLowerCase()) && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        transferClipboard(event.key.toLowerCase() === "v" ? "paste" : event.key.toLowerCase() === "c" ? "copy" : "cut", event.shiftKey);
      }
      // Accessibility keyboards may send modifier flags without separate modifier
      // key events. Keep the remote modifiers in sync before noVNC sends the key.
      else if (!["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
        rfb.current?.sendKey(0xffe3, "ControlLeft", event.ctrlKey || event.metaKey);
        rfb.current?.sendKey(0xffe1, "ShiftLeft", event.shiftKey);
      }
    }}
    onKeyUpCapture={(event) => {
      if (event.key === "Meta" || ((event.ctrlKey || event.metaKey) && ["v", "c", "x"].includes(event.key.toLowerCase()) && !event.altKey)) {
        event.preventDefault(); event.stopPropagation();
      }
      rfb.current?.sendKey(0xffe3, "ControlLeft", event.ctrlKey || event.metaKey);
      rfb.current?.sendKey(0xffe1, "ShiftLeft", event.shiftKey);
    }}
    onBeforeInput={(event) => event.preventDefault()}
    onPaste={(event) => {
      const text = event.clipboardData.getData("text/plain");
      if (!text || !rfb.current) return;
      event.preventDefault();
      transferClipboard("paste", false, Promise.resolve(text));
    }}>
    {lastFrame && <img alt="" className="pointer-events-none absolute inset-0 size-full object-contain" src={lastFrame} />}
    <div ref={container} contentEditable suppressContentEditableWarning className="absolute inset-0 size-full" role="application" aria-label={`${name}'s interactive Linux computer`} />
    {(state !== "connected" || error) && <div className={`pointer-events-none absolute ${lastFrame || error ? "bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs" : "inset-0 grid place-items-center text-[18px]"}`} role="status">
      {error ?? (state === "reconnecting" ? "Reconnecting…" : "Connecting…")}
    </div>}
  </div>;
}
