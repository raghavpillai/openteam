import "./browser-network.css";
import { useEffect, useRef, useState } from "react";
import type {
  BrowserNetworkView,
  NetworkSharingStatus,
  NetworkEgress,
  NetworkQuality,
} from "@openteam/contracts/browser-network";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { api } from "../../../client/openteam-api";
import { GripVertical, Laptop, Monitor, Server } from "lucide-react";
import { DragDropProvider, KeyboardSensor, PointerSensor } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { PrivateSettingValue } from "./private-value";
import { SectionLabel, SettingsGroup } from "./ui";

import { browserNetworkLabel } from "../../../lib/browser-network-status";

export function BrowserNetworkSettings() {
  const [view, setView] = useState<BrowserNetworkView | null>(null);
  const [egress, setEgress] = useState<NetworkEgress | null>(null);
  const [quality, setQuality] = useState<NetworkQuality | null>(null);
  const [testing, setTesting] = useState(false);
  const [qualityFailed, setQualityFailed] = useState(false);
  const [egressFailed, setEgressFailed] = useState(false);
  const [localMachineId, setLocalMachineId] = useState<string | null>(null);
  const [sharing, setSharing] = useState<NetworkSharingStatus | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const results = await Promise.allSettled([
        api.browserNetwork(),
        window.openteam?.computer.network() ?? Promise.resolve(null),
        window.openteam?.auth?.machineStatus?.() ?? Promise.resolve(null),
      ]);
      if (!active) return;
      if (results[0].status === "fulfilled") setView(results[0].value);
      else setError(clientErrorMessage(results[0].reason, "Could not load computer networking"));
      if (results[1].status === "fulfilled") setSharing(results[1].value);
      setLocalMachineId(
        results[2].status === "fulfilled" && results[2].value?.configured
          ? results[2].value.machineId
          : null
      );
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const routeKey =
    view?.runtime.routeEpoch ??
    `${view?.settings.revision}:${view?.runtime.state}:${view?.runtime.activeMachineId}`;
  const routeRef = useRef(routeKey);
  routeRef.current = routeKey;
  useEffect(() => {
    setQuality(null);
    setQualityFailed(false);
  }, [routeKey]);
  const testConnection = async () => {
    if (testing) return;
    const epoch = routeKey;
    setTesting(true);
    setQualityFailed(false);
    try {
      const result = await api.browserNetworkQuality();
      if (routeRef.current === epoch && result.epoch === view?.runtime.routeEpoch)
        setQuality(result);
    } catch {
      if (routeRef.current === epoch) {
        setQuality(null);
        setQualityFailed(true);
      }
    } finally {
      setTesting(false);
    }
  };
  useEffect(() => {
    if (!view || !["ready", "server"].includes(view.runtime.state)) return;
    let active = true;
    setEgress(null);
    setEgressFailed(false);
    const check = async () => {
      try {
        const value = await api.browserNetworkEgress();
        if (active) {
          setEgress(value);
          setEgressFailed(false);
        }
      } catch {
        if (active) {
          setEgress(null);
          setEgressFailed(true);
        }
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [routeKey, view?.runtime.state]);
  const savedOrder = view?.settings.sourceOrder?.length ? view.settings.sourceOrder : ["server"];
  const ranked = order ?? savedOrder;
  const dirty = !!view && JSON.stringify(ranked) !== JSON.stringify(savedOrder);
  const move = (from: string, to: string) => {
    const next = [...ranked],
      start = next.indexOf(from),
      end = next.indexOf(to);
    if (start < 0 || end < 0 || start === end) return;
    next.splice(start, 1);
    next.splice(end, 0, from);
    setDraftRevision((revision) => revision ?? view?.settings.revision ?? null);
    setOrder(next);
  };
  const apply = async () => {
    if (!view || !dirty) return;
    if (
      !window.confirm(
        "Save this connection priority? Changing the active connection interrupts downloads and network connections across the bot computer. Apps stay open; requests are not replayed."
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      setView(
        await api.updateBrowserNetwork({
          expectedRevision: draftRevision ?? view.settings.revision,
          mode: "ranked",
          machineId: null,
          sourceOrder: ranked,
        })
      );
      setOrder(null);
      setDraftRevision(null);
    } catch (e) {
      setError(clientErrorMessage(e, "Could not change computer connection"));
      setOrder(null);
      setDraftRevision(null);
      try {
        setView(await api.browserNetwork());
      } catch {
        /* Keep the original error visible while offline. */
      }
    } finally {
      setBusy(false);
    }
  };
  const share = async (allowed: boolean) => {
    if (
      allowed &&
      !window.confirm(
        `Allow all apps and commands on the bot computer at ${sharing?.serverUrl ?? "this server"} to use this computer's internet connection while OpenTeam is open? Public TCP connections and DNS are supported. Other UDP traffic and local and private network destinations remain blocked.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.openteam?.computer.shareNetwork(allowed);
      if (result) setSharing(result);
      setView(await api.browserNetwork());
    } catch (e) {
      setError(clientErrorMessage(e, "Could not change network sharing"));
    } finally {
      setBusy(false);
    }
  };
  const activeId = view?.runtime.state === "server" ? "server" : view?.runtime.activeMachineId;
  const ready = view && ["ready", "server"].includes(view.runtime.state);
  return (
    <section className="bn-network" data-settings-anchor="browser-network">
      <SectionLabel>Computer network</SectionLabel>
      <SettingsGroup>
        <p role="status" className="bn-status">
          {view ? browserNetworkLabel(view).split(" · ")[0] : "Loading connections…"}
        </p>
        <DragDropProvider
          sensors={[PointerSensor, KeyboardSensor]}
          onDragEnd={(event) => {
            if (event.canceled || busy) return;
            const { source } = event.operation;
            if (
              isSortable(source) &&
              source.initialIndex !== source.index &&
              ranked[source.index]
            ) {
              move(String(source.id), ranked[source.index]!);
            }
          }}
        >
          <ol aria-label="Connection priority" className="bn-list">
            {ranked.map((id, index) => {
              const device = view?.devices.find((d) => d.machineId === id);
              const name =
                id === "server" ? "Server connection" : (device?.label ?? "Unavailable computer");
              return (
                <NetworkSourceRow
                  key={id}
                  id={id}
                  name={name}
                  index={index}
                  active={!!ready && activeId === id}
                  current={!!device && id === localMachineId}
                  available={
                    id === "server" ||
                    (!!device?.enabled &&
                      (device.working ?? (device.connected && device.sharingAllowed)))
                  }
                  disabled={busy || !view}
                />
              );
            })}
          </ol>
        </DragDropProvider>
        <div className="bn-egress" key={routeKey}>
          <span>Exit IP</span>
          {ready &&
          egress &&
          (!view?.runtime.routeEpoch || egress.epoch === view.runtime.routeEpoch) ? (
            <div className="bn-egress-values">
              <PrivateSettingValue key={egress.ip} value={egress.ip} label="exit IP" />
              <span aria-hidden="true">·</span>
              <PrivateSettingValue
                key={egress.location}
                value={egress.location}
                label="exit location"
              />
            </div>
          ) : (
            <span className="bn-egress-pending">
              {!ready || egressFailed ? "Unavailable" : "Checking…"}
            </span>
          )}
        </div>
        <div className="bn-quality">
          <span className="bn-quality-label">Connection test</span>
          <div className="bn-quality-values" aria-live="polite">
            {ready && quality?.epoch === view?.runtime.routeEpoch && quality ? (
              <>
                <span aria-label={`Latency ${quality.latencyMs} milliseconds`}>
                  {quality.latencyMs} ms
                </span>
                <span aria-label={`Estimated download ${quality.downloadMbps} megabits per second`}>
                  ↓ ~{quality.downloadMbps.toFixed(1)} Mbps
                </span>
                <span aria-label={`Estimated upload ${quality.uploadMbps} megabits per second`}>
                  ↑ ~{quality.uploadMbps.toFixed(1)} Mbps
                </span>
              </>
            ) : qualityFailed ? (
              <span>Test unavailable</span>
            ) : null}
          </div>
          <button
            type="button"
            className="bn-test"
            aria-label="Test active connection"
            title="Quick latency and speed estimate from the bot computer; about 1.25 MB"
            disabled={!ready || testing}
            onClick={() => void testConnection()}
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
        {sharing?.supported && (
          <label className="bn-share">
            <span>Share this computer’s connection</span>
            <input
              type="checkbox"
              aria-label="Share this computer’s connection"
              checked={sharing.sharingAllowed}
              disabled={busy || !sharing.connected}
              onChange={(e) => void share(e.target.checked)}
              className="bn-switch"
            />
          </label>
        )}
        {dirty && (
          <div className="bn-actions">
            <span>Unsaved changes</span>
            <div className="bn-buttons">
              {dirty && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setOrder(null);
                    setDraftRevision(null);
                  }}
                  className="bn-discard"
                >
                  Discard
                </button>
              )}
              <button
                type="button"
                disabled={busy || !view || !dirty}
                onClick={() => void apply()}
                className="bn-apply"
              >
                Apply
              </button>
            </div>
          </div>
        )}
        {view && !["ready", "server"].includes(view.runtime.state) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api
                .retryBrowserNetwork()
                .then(setView)
                .catch((e) => setError(clientErrorMessage(e, "Could not retry connection")))
                .finally(() => setBusy(false));
            }}
            className="bn-retry"
          >
            Retry connection
          </button>
        )}
        {error && (
          <p role="alert" className="bn-error">
            {error}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}

function NetworkSourceRow({
  id,
  name,
  index,
  active,
  current,
  available,
  disabled,
}: {
  id: string;
  name: string;
  index: number;
  active: boolean;
  current: boolean;
  available: boolean;
  disabled: boolean;
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id,
    index,
    group: "browser-network",
    type: "browser-network",
    accept: "browser-network",
    disabled,
  });
  const Icon = id === "server" ? Server : /mini|desktop|studio/i.test(name) ? Monitor : Laptop;
  return (
    <li
      ref={ref}
      data-network-source={id}
      className={`bn-source${isDragging ? " bn-dragging" : ""}`}
    >
      <span className="bn-rank">{index + 1}</span>
      <Icon size={16} strokeWidth={1.7} className="bn-icon" />
      <span className="bn-device-label">
        <span className="bn-name">{name}</span>
        {current && <span className="bn-current">(current)</span>}
      </span>
      <span
        className={`bn-device-status${available ? " bn-working" : ""}${active ? " bn-in-use" : ""}`}
        aria-label={active ? "Working · In use" : undefined}
      >
        <span className="bn-status-dot" aria-hidden="true" />
        {active ? "In use" : available ? "Working" : "Not working"}
      </span>
      <button
        ref={handleRef}
        type="button"
        aria-label={`Reorder ${name}`}
        disabled={disabled}
        className="bn-handle"
      >
        <GripVertical size={14} />
      </button>
    </li>
  );
}
export default BrowserNetworkSettings;
