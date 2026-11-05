import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { api, openTeamClient } from "../../src/renderer/client/openteam-api";
import { useOpenTeam } from "../../src/renderer/state/use-openteam";
import { installWindowVisibility, isWindowActive } from "../../src/renderer/lib/window-visibility";
import { syncDesktopNotificationSnapshot } from "../../src/renderer/lib/notifications";
import { desktopDurableSendController } from "../../src/renderer/lib/durable-sends";

const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async input => {
  const message = `Unexpected network request in sync fixture: ${String(input)}`;
  errors.push(message);
  throw Error(message);
};
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
const runtimeTimers = new Map<number, () => void>();
const deliveryPolls = new Set<number>();
const nativeInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
window.setInterval = ((callback: () => void, delay: number) => {
  const id = nativeInterval(callback, delay);
  if (delay === 5_000) deliveryPolls.add(id);
  return id;
}) as typeof window.setInterval;
window.clearInterval = id => { deliveryPolls.delete(id!); nativeClearInterval(id); };
const nativeTimeout = window.setTimeout.bind(window);
const nativeClear = window.clearTimeout.bind(window);
window.setTimeout = ((callback: () => void, delay: number) => {
  const id = nativeTimeout(callback, delay);
  if (delay === 30_000) runtimeTimers.set(id, callback);
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = id => { runtimeTimers.delete(id!); nativeClear(id); };
let online = true;
Object.defineProperty(navigator, "onLine", { get: () => online });
let runtimeReads = 0, bootstraps = 0, connections = 0, aborts = 0, sendCount = 0;
let resolveStream = () => {};
let eventHandlers: any;
const cursors: string[] = [];
const runtime = { server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "ready" } as any;
let bootstrap = {
  cursor: "1", workspace: { id: "qa", name: "QA" }, capabilities: CLIENT_CAPABILITIES, runtime,
  bots: [{ id: "qa-bot", name: "QA", status: "active" }],
  channels: [{ id: "qa-chat", name: "QA", kind: "bot_dm", members: [{botId:"qa-bot",ordinal:0}], unreadCount: 0,
    notificationState: { channelId: "qa-chat", lastReadSequence: "0", lastReadNotificationSequence: "0", notificationCursor: "0", notifications: [] } }],
  latestMessages: [], activeRuns: [], channelRounds: [], subagents: [],
} as any;
api.bootstrap = async () => { bootstraps++; return structuredClone(bootstrap); };
api.runtime = async () => { runtimeReads++; return { runtime } as never; };
openTeamClient.listenForEvents = async (cursor, handlers, signal) => {
  connections++; cursors.push(cursor); eventHandlers = handlers;
  handlers.onOpen?.();
  return new Promise<void>(resolve => {
    resolveStream = resolve;
    signal?.addEventListener("abort", () => { aborts++; resolve(); }, {once:true});
  });
};
let acceptedMessage: any;
api.messageDeliveryStatus = async () => ({ status: acceptedMessage ? "accepted" : "not_found", message: acceptedMessage }) as never;
api.sendChannelMessage = async (channelId, content, _attachments, _reply, options) => {
  sendCount++;
  acceptedMessage = { id: "qa-delivered", channelId, content, clientId: options?.clientId, sequence: "10", sender: "user", metadata: {}, createdAt: new Date().toISOString() };
  return { message: acceptedMessage } as never;
};
installWindowVisibility();
let state: ReturnType<typeof useOpenTeam>;
function Probe() {
  state = useOpenTeam();
  useEffect(() => { syncDesktopNotificationSnapshot(window.openteam?.notifications, state.snapshot); }, [state.snapshot]);
  return <div>Background sync fixture</div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Probe />);
let delivery: ReturnType<typeof desktopDurableSendController> | null = null;
Object.assign(window, {
  syncProbe: () => ({ bootstraps, connections, aborts, cursors, runtimeReads, cursor: state?.snapshot?.cursor,
    active: isWindowActive(), errors, sendCount, deliveryPolls: deliveryPolls.size, deliveries: delivery?.getSnapshot().map(record => record.phase) ?? [] }),
  advanceRuntime: () => { clockOffset += 31_000; },
  tickRuntime: () => { for (const [id, callback] of [...runtimeTimers]) { window.clearTimeout(id); callback(); } },
  injectNotification: () => {
    bootstrap = structuredClone(bootstrap); bootstrap.cursor = "2";
    bootstrap.channels[0].notificationState.notificationCursor = "2";
    bootstrap.channels[0].notificationState.notifications = [{channelId:"qa-chat",botId:"qa-bot",kind:"message",title:"QA completion",body:"Completed in the background",notificationSequence:"2",messageSequence:"20"}];
    eventHandlers.onEvent({ sequence: "2", topic: "message.created", payload: {} });
  },
  markReadElsewhere: () => {
    bootstrap = structuredClone(bootstrap); bootstrap.cursor = "3";
    bootstrap.channels[0].notificationState.lastReadSequence = "20";
    eventHandlers.onEvent({ sequence: "3", topic: "channel.read", payload: {} });
  },
  disconnectStream: () => resolveStream(),
  queueOffline: async () => {
    online = false; window.dispatchEvent(new Event("offline"));
    delivery = desktopDurableSendController(); await delivery.restore();
    await delivery.enqueue({target:{channelId:"qa-chat"},payload:{content:"Queued in the background",attachments:[]}});
  },
  reconnectDelivery: () => { online = true; window.dispatchEvent(new Event("online")); },
  acknowledgeDelivery: async () => { await delivery?.reconcile([acceptedMessage]); },
  unmountSync: () => root.unmount(),
});
