import { InteractiveSwitch } from "./interactive-switch";
import { Button } from "../../ui/button";
import { SettingsSelectContent } from "./select-content";
import { PrivateSettingValue } from "./private-value";
import { SmartNotificationSettings } from "./smart-notifications";
import { TimeZoneSettings } from "./time-zone";
import { LocationSettings } from "./location";
import { Copy } from "lucide-react";
import { type ComponentProps, Suspense, useState, useSyncExternalStore } from "react";
import { signOut } from "../../../client/auth";
import { API_BASE } from "../../../client/http";
import { useAuthSession } from "../../../hooks/use-auth-session";
import { accountPresentation } from "../../../lib/account";
import {
  readBotMessageColors,
  setBotMessageColors,
  subscribeBotMessageColors,
} from "../../../lib/message-colors";
import {
  normalizeThemePreference,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../../../lib/theme";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import type {
  MicrophoneControlProps,
  MicrophoneSettings as MicrophoneSettingsComponent,
} from "./microphone";
import {
  SectionLabel,
  SettingsGroup,
  SettingsRow,
  SkeletonControl,
  settingsSelect,
  settingsSecondaryButton,
} from "./ui";
import { MicrophoneAccessSkeleton } from "./microphone-skeleton";
import { preloadable } from "./preloadable";
// Device discovery stays out of the General chunk, but starts loading with it.
const microphone = preloadable<ComponentProps<typeof MicrophoneSettingsComponent>>(() =>
  import("./microphone").then((module) => ({ default: module.MicrophoneSettings }))
);
void microphone.preload();
const MicrophoneSettings = microphone.Component;

// Reuse the selector already loaded for Theme; device discovery stays lazy.
export const renderMicrophoneControl = ({ options, ...props }: MicrophoneControlProps) => (
  <Select {...props}>
    <SelectTrigger
      aria-label="Microphone"
      className={`${settingsSelect} w-auto max-w-[220px] [&>span]:truncate`}
    >
      <SelectValue />
    </SelectTrigger>
    <SettingsSelectContent>
      {options.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SettingsSelectContent>
  </Select>
);

/** The System section's shape while device discovery loads. */
function MicrophoneSkeleton() {
  return (
    <>
      <SectionLabel>System</SectionLabel>
      <SettingsGroup>
        <SettingsRow stackControl title="Microphone" control={<SkeletonControl width={124} />} />
        <SettingsRow
          stackControl
          title="Microphone access"
          control={<MicrophoneAccessSkeleton />}
        />
      </SettingsGroup>
    </>
  );
}

export default function GeneralSettings() {
  const auth = useAuthSession();
  const account = accountPresentation(auth.user, auth.mode);
  const [signingOut, setSigningOut] = useState(false);
  const [accountCopied, setAccountCopied] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const useBotColors = useSyncExternalStore(subscribeBotMessageColors, readBotMessageColors);

  const changeTheme = (value: string) => {
    const preference = normalizeThemePreference(value);
    setTheme(preference);
    setThemePreference(preference);
  };

  const copyAccount = async () => {
    if (!account.copyValue) return;
    await navigator.clipboard.writeText(account.copyValue);
    setAccountCopied(true);
    window.setTimeout(() => setAccountCopied(false), 1_500);
  };

  const logOut = async () => {
    if (auth.mode === "disabled" || signingOut) return;
    setSigningOut(true);
    await signOut();
  };

  return (
    <>
      <SectionLabel>Account</SectionLabel>
      <SettingsGroup className="px-3.5">
        <div className="flex min-h-[72px] flex-wrap items-center gap-3 py-3.5">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-black/[0.045] text-[13px] font-medium text-foreground-secondary ring-1 ring-black/[0.035] dark:bg-white/[0.07] dark:ring-white/[0.06]">
            {account.initials}
          </span>
          <div className="min-w-[100px] flex-1">
            <div className="truncate text-[13px] font-medium">{account.name}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[12px] text-foreground-secondary">
              <span className="truncate">{account.detail}</span>
              {account.copyValue ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={accountCopied ? "Account name copied" : "Copy account name"}
                  className="grid size-5 shrink-0 place-items-center rounded text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                  onClick={() => void copyAccount()}
                  title={accountCopied ? "Copied" : "Copy account name"}
                  type="button"
                >
                  <Copy className="size-3.5" strokeWidth={1.75} />
                </Button>
              ) : null}
            </div>
            <div className="mt-1 flex items-baseline gap-2 text-[12px] leading-4 text-foreground-secondary">
              <span className="shrink-0">Endpoint</span>
              <PrivateSettingValue value={API_BASE} label="server endpoint" />
            </div>
          </div>
          <Button
            size="xs"
            variant="secondary"
            className={`${settingsSecondaryButton} ml-auto`}
            disabled={auth.mode === "disabled" || signingOut}
            onClick={() => void logOut()}
            type="button"
            loading={signingOut}
            loadingLabel="Signing Out…"
          >
            Sign Out
          </Button>
        </div>
      </SettingsGroup>

      <TimeZoneSettings />

      <LocationSettings />

      <SmartNotificationSettings />

      <SectionLabel>Appearance</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["theme"]}
          control={
            <Select onValueChange={changeTheme} value={theme}>
              <SelectTrigger aria-label="Theme" className={`${settingsSelect} w-auto`}>
                <SelectValue />
              </SelectTrigger>
              <SettingsSelectContent>
                <SelectItem value="system">Follow System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SettingsSelectContent>
            </Select>
          }
          title="Theme"
        />
        <SettingsRow
          title="Use bot colors for messages"
          description="Color your sent messages with the bot’s color. Off keeps them gray."
          control={
            <InteractiveSwitch
              label="Use bot colors for messages"
              checked={useBotColors}
              onChange={setBotMessageColors}
            />
          }
        />
      </SettingsGroup>

      <Suspense fallback={<MicrophoneSkeleton />}>
        <MicrophoneSettings renderControl={renderMicrophoneControl} />
      </Suspense>
    </>
  );
}
