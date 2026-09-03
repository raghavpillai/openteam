import { Copy } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { signOut } from "../../client/auth";
import { useAuthSession } from "../../hooks/use-auth-session";
import { accountPresentation } from "../../lib/account";
import {
  normalizeThemePreference,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../../lib/theme";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionLabel, SettingsGroup, SettingsRow } from "./settings-ui";

const GeneralBotSettings = lazy(() => import("./settings-general-bot"));

export default function GeneralSettings() {
  const auth = useAuthSession();
  const account = accountPresentation(auth.user, auth.mode);
  const [signingOut, setSigningOut] = useState(false);
  const [accountCopied, setAccountCopied] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);

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
        <div className="flex min-h-[72px] items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-black/[0.045] text-[13px] font-medium text-foreground-secondary ring-1 ring-black/[0.035] dark:bg-white/[0.07] dark:ring-white/[0.06]">
            {account.initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">{account.name}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-foreground-secondary">
              <span className="truncate">{account.detail}</span>
              {account.copyValue ? (
                <button
                  aria-label={accountCopied ? "Account name copied" : "Copy account name"}
                  className="grid size-5 shrink-0 place-items-center rounded text-foreground-tertiary hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                  onClick={() => void copyAccount()}
                  title={accountCopied ? "Copied" : "Copy account name"}
                  type="button"
                >
                  <Copy className="size-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          </div>
          <button
            className="inline-flex h-8 items-center rounded-full border border-black/[0.04] bg-black/[0.035] px-3.5 text-[12px] hover:bg-black/[0.065] disabled:cursor-default disabled:opacity-50 dark:border-white/[0.06] dark:bg-white/[0.07] dark:hover:bg-white/[0.1]"
            disabled={auth.mode === "disabled" || signingOut}
            onClick={() => void logOut()}
            type="button"
          >
            {signingOut ? "Signing Out…" : "Sign Out"}
          </button>
        </div>
      </SettingsGroup>

      <SectionLabel>Appearance</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["theme"]}
          control={
            <Select onValueChange={changeTheme} value={theme}>
              <SelectTrigger
                aria-label="Theme"
                className="h-7 min-w-[126px] rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">Follow System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          }
          title="Theme"
        />
      </SettingsGroup>

      <Suspense fallback={null}>
        <GeneralBotSettings />
      </Suspense>
    </>
  );
}
