import { useEffect, useState } from "react";

/** Shared endpoint/IP privacy interaction. Hidden values are excluded from VoiceOver. */
export function PrivateSettingValue({ value, label }: { value: string; label: string }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
    const hide = () => setRevealed(false);
    window.addEventListener("blur", hide);
    return () => window.removeEventListener("blur", hide);
  }, [value]);
  return (
    <button
      aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`}
      aria-pressed={revealed}
      className="min-w-0 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      onClick={() => setRevealed((value) => !value)}
      type="button"
    >
      <span
        aria-hidden={!revealed}
        className={`block select-none break-all transition-[filter,opacity] duration-300 ease-out motion-reduce:transition-none ${revealed ? "blur-none opacity-100" : "blur-[5px] opacity-70"}`}
      >
        {value}
      </span>
    </button>
  );
}
