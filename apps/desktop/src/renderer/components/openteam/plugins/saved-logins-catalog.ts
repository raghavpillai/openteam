import type { PluginCatalogItemView } from "@openteam/contracts";
import onePasswordIcon from "../../../assets/integrations/1password.png?inline";

export const SAVED_LOGINS_KEY = "1password-saved-logins";
export const savedLoginsCatalog = (logoUrl: string | null, installed = false): PluginCatalogItemView => ({
  key: SAVED_LOGINS_KEY, name: "1Password", version: "1.0.0", publisher: "1Password",
  description: "Share existing 1Password vaults with OpenTeam through a service account token, so it can sign in to sites on its computer.",
  category: "Login and Credential Management", featured: false, installed,
  components: [], connections: [], skills: [], homepageUrl: "https://1password.com",
  sourceUrl: null, sourceRevision: null, logoUrl: logoUrl ?? onePasswordIcon, setupFields: [], setup: null,
});
