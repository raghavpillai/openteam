import {
  type MobileTheme,
  mobileDarkTheme,
  mobileLightTheme,
  mobileMetrics,
} from "@openbot/design-tokens/mobile-theme";
import { useAppearance } from "./appearance";

export const lightTheme = mobileLightTheme;
export const darkTheme = mobileDarkTheme;
export type Theme = MobileTheme;
export const metrics = mobileMetrics;

export const useTheme = (): Theme => (useAppearance().dark ? darkTheme : lightTheme);
