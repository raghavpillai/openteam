import type { UserTimeZoneView } from "@openteam/contracts";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../client/openteam-api";
import { supportedTimeZones, timeInZone, timeZoneLabel } from "../../../lib/time-zone";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { SettingsGroup, SettingsRow } from "./ui";

const AUTO = "auto";

/** The zone routines, the box clock and the bot's sense of time use: auto-detected, or an override. */
export function TimeZoneSettings() {
  const [setting, setSetting] = useState<UserTimeZoneView | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const zones = useMemo(supportedTimeZones, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api
        .userTimeZone()
        .then((value) => {
          if (active) setSetting(value);
        })
        .catch(() => {
          /* The row stays hidden until the setting loads. */
        });
    };
    refresh();
    window.addEventListener("openteam:time-zone-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("openteam:time-zone-changed", refresh);
    };
  }, []);

  if (!setting) return null;
  const detected = setting.detectedTimeZone;
  const autoLabel = detected ? `Auto-detect (${timeZoneLabel(detected)})` : "Auto-detect";
  const override = setting.overrideTimeZone;
  const entries = [
    { value: AUTO, label: autoLabel, zone: detected },
    ...(override && !zones.includes(override) ? [override] : []).concat(zones).map((zone) => ({
      value: zone,
      label: timeZoneLabel(zone),
      zone,
    })),
  ];
  const needle = query.trim().toLowerCase().replaceAll("_", " ");
  const visible = needle
    ? entries.filter((entry) => entry.value !== AUTO && `${entry.label} ${entry.value}`.toLowerCase().replaceAll("_", " ").includes(needle))
    : entries;
  const selected = override ?? AUTO;

  const choose = (value: string) => {
    setOpen(false);
    if (value === selected) return;
    setSaving(true);
    setFailed(false);
    void api
      .updateUserTimeZone({ overrideTimeZone: value === AUTO ? null : value })
      .then(setSetting)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  return (
    <SettingsGroup>
      <SettingsRow
        title="Timezone"
        description={failed ? <span role="alert" className="text-destructive">Couldn't save. Try again.</span> : undefined}
        control={
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) {
                setNow(new Date());
                setQuery("");
              }
            }}
          >
            <PopoverTrigger asChild>
              <button
                aria-label="Timezone"
                className="inline-flex h-7 max-w-[260px] items-center gap-1 rounded-[8px] border border-black/[0.055] bg-black/[0.035] px-2 text-[12px] disabled:opacity-50 dark:border-white/[0.07] dark:bg-white/[0.07]"
                disabled={saving}
                type="button"
              >
                <span className="truncate">{override ? timeZoneLabel(override) : autoLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[424px] max-w-[calc(100vw-16px)] rounded-[12px] p-1.5">
              <input
                aria-label="Search timezone"
                autoFocus
                className="mb-1 h-8 w-full rounded-[8px] bg-black/[0.035] px-2.5 text-[13px] outline-none dark:bg-white/[0.07]"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && visible[0]) choose(visible[0].value);
                }}
                placeholder="Search timezone"
                value={query}
              />
              <div aria-label="Timezone" className="max-h-[320px] overflow-y-auto" role="listbox">
                {visible.map((entry) => {
                  const time = entry.zone ? timeInZone(entry.zone, now) : null;
                  return (
                    <button
                      aria-selected={entry.value === selected}
                      className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                      key={entry.value}
                      onClick={() => choose(entry.value)}
                      role="option"
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {time ? <span className="shrink-0 text-foreground-tertiary">{time}</span> : null}
                      <Check className={`size-3.5 shrink-0 ${entry.value === selected ? "" : "invisible"}`} />
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        }
      />
    </SettingsGroup>
  );
}
