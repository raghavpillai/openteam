export const AUTOMATION_WEBHOOK_PROVIDERS = [
  "slack",
  "github",
  "linear",
  "sentry",
  "pagerduty",
  "microsoftTeams",
  "webhook",
] as const;
export type AutomationWebhookProvider = (typeof AUTOMATION_WEBHOOK_PROVIDERS)[number];
export interface AutomationWebhookInput {
  id?: string;
  source: AutomationWebhookProvider;
  ownerKind: "bot" | "group";
  ownerId: string;
  publicUrl: string;
  configuration: Record<string, string>;
  signingSecret?: string;
  apiToken?: string;
  enabled?: boolean;
}
export interface AutomationWebhookView {
  id: string;
  source: string;
  ownerKind: string;
  ownerId: string;
  callbackUrl: string;
  configuration: Record<string, string>;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  remoteId: string | null;
  expiresAt: string | null;
  hasApiToken: boolean;
  hasSigningSecret: boolean;
}
