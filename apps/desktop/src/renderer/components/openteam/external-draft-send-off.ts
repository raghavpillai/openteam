import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Sends and discards this device started and has not seen answered, by message
    id. The record outlives the card, which is unmounted when the chat is switched
    away, so a card that comes back mid-send picks its send-off up again. */
const out = new Map<string, { at: number; discard: boolean; answered: Promise<void> }>();

/** A card's send-off, for a Send or Discard pressed on this device: "charging"
    from the press until it is answered, then "flying" while the flight plays.
    `resync` re-reads the card from the server; a card that came back mid-send
    calls it once that send is answered, since the answer went to the card that
    left. `lost` is a send whose outcome can't be confirmed; it gets no send-off. */
export function useDraftSendOff<Card extends HTMLElement>(id: string, state: string, resync: () => Promise<unknown>, lost = false) {
  const card = useRef<Card>(null);
  const [resumed] = useState(() => out.get(id));
  const [fx, setFx] = useState<"idle" | "charging" | "flying">(resumed ? "charging" : "idle");
  const [discard, setDiscard] = useState(resumed?.discard ?? false);
  // This device's request is still unanswered.
  const [waiting, setWaiting] = useState(Boolean(resumed));
  const pressedAt = useRef(resumed?.at ?? 0);
  const landed = useRef(false);
  const flight = useRef<Promise<typeof import("./external-draft-send-flight")> | null>(null);
  const load = () => {
    if (flight.current) return;
    flight.current = import("./external-draft-send-flight");
    // A failed load is dealt with when the flight is due.
    flight.current.catch(() => {});
  };
  if (resumed) load();
  const reread = useRef(resync);
  reread.current = resync;
  useEffect(() => {
    if (!resumed) return;
    let live = true;
    void resumed.answered
      .then(() => live && reread.current())
      .then(
        () => live && setWaiting(false),
        // The card couldn't ask: show its plain state, not a blob that may never leave.
        () => live && setFx("idle")
      );
    return () => {
      live = false;
    };
  }, [resumed]);
  useEffect(() => {
    if (fx !== "charging") return;
    if (state !== (discard ? "dismissed" : "sent")) {
      if (!waiting && (state !== "sending" || lost)) setFx("idle");
      return;
    }
    // Hold long enough for the blob to form, however fast the answer was.
    const hold = (discard ? 200 : 300) - (performance.now() - pressedAt.current);
    const timer = window.setTimeout(() => setFx("flying"), Math.max(0, hold));
    return () => window.clearTimeout(timer);
  }, [fx, state, lost, waiting, discard]);
  useLayoutEffect(() => {
    if (fx !== "flying") return;
    let cancel: (() => void) | undefined;
    let stale = false;
    const finish = () => {
      landed.current = true;
      setFx("idle");
    };
    void flight.current
      ?.then(({ playDraftSendFlight }) => {
        if (!stale && card.current) cancel = playDraftSendFlight(card.current, finish, discard);
      })
      // Without the flight the card still has to settle.
      .catch(() => stale || finish());
    return () => {
      stale = true;
      cancel?.();
    };
  }, [fx, discard]);
  /** Call as the send (or discard) starts, and call what it returns once it is
      answered, whatever the answer. Does nothing under Reduce Motion. */
  const press = (discarding = false) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
    let answer = () => {};
    const entry = { at: performance.now(), discard: discarding, answered: new Promise<void>((resolve) => (answer = resolve)) };
    out.set(id, entry);
    pressedAt.current = entry.at;
    load();
    setDiscard(discarding);
    setWaiting(true);
    setFx("charging");
    return () => {
      if (out.get(id) === entry) out.delete(id);
      answer();
      setWaiting(false);
    };
  };
  return { card, fx, discard, landed: landed.current, press };
}
