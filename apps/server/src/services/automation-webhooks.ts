import { randomUUID } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import {
  AUTOMATION_WEBHOOK_PROVIDERS,
  type AutomationWebhookInput,
  type AutomationWebhookView,
} from "@openteam/contracts/automation-webhooks";
import { receiveAutomationWebhook, type AutomationWebhookBinding } from "../automation-webhooks";
import type { AutomationEvent } from "@openteam/messaging";
import { toJson } from "./service-utils";
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const configurationKeys: Record<string, string[]> = {
  github: ["repository"],
  slack: ["appId", "teamId", "selfUserId"],
  linear: ["teamId", "organizationId"],
  sentry: ["appSlug", "organizationId"],
  pagerduty: ["serviceId"],
  microsoftTeams: ["tenantId", "teamId", "resource"],
  webhook: [],
};
const stableConfig = (value: unknown) =>
  JSON.stringify(
    Object.entries(value as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))
  );
class ProviderResponseError extends Error {
  constructor(readonly status: number) {
    super(
      `Provider request failed (${status}); verify the token, permissions, target and public callback URL`
    );
  }
}
type Row = NonNullable<Awaited<ReturnType<PrismaClient["automationWebhook"]["findUnique"]>>>;
export class AutomationWebhooksService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dispatch: (
      owner: AutomationWebhookBinding["owner"],
      event: AutomationEvent
    ) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  private viewOf(row: Row): AutomationWebhookView {
    return {
      id: row.id,
      source: row.source,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      configuration: row.configuration as Record<string, string>,
      enabled: row.enabled,
      status: row.status,
      statusMessage: row.statusMessage,
      remoteId: row.remoteId,
      callbackUrl: row.callbackUrl,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      hasApiToken: Boolean(row.apiToken),
      hasSigningSecret: Boolean(row.signingSecret),
    };
  }
  async list() {
    return (await this.db.automationWebhook.findMany({ orderBy: { createdAt: "asc" } })).map(
      (row) => this.viewOf(row)
    );
  }
  async save(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ApiError(400, "invalid_webhook", "Webhook configuration is required");
    const input = raw as AutomationWebhookInput;
    if (
      !AUTOMATION_WEBHOOK_PROVIDERS.includes(input.source) ||
      !["bot", "group"].includes(input.ownerKind) ||
      !uuid.test(input.ownerId) ||
      (input.id && !uuid.test(input.id))
    )
      throw new ApiError(400, "invalid_webhook", "Choose a provider and a valid owner ID");
    const owner =
      input.ownerKind === "bot"
        ? await this.db.bot.count({ where: { id: input.ownerId, status: "active" } })
        : await this.db.channel.count({
            where: { id: input.ownerId, kind: "group", archivedAt: null },
          });
    if (!owner)
      throw new ApiError(
        404,
        "webhook_owner_unavailable",
        "The target bot or group is unavailable"
      );
    const origin = new URL(input.publicUrl);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    )
      throw new ApiError(400, "invalid_webhook_url", "Use this server's public HTTPS base URL");
    if (
      !input.configuration ||
      typeof input.configuration !== "object" ||
      Array.isArray(input.configuration) ||
      Object.keys(input.configuration).length > 20 ||
      Object.values(input.configuration).some(
        (value) => typeof value !== "string" || value.length > 1000
      )
    )
      throw new ApiError(400, "invalid_webhook_config", "Invalid provider configuration");
    if (
      Object.keys(input.configuration).some(
        (key) => !configurationKeys[input.source]!.includes(key)
      )
    )
      throw new ApiError(400, "invalid_webhook_config", "Unexpected provider configuration field");
    const required: Record<string, string[]> = {
      github: ["repository"],
      slack: ["appId", "teamId"],
      linear: ["teamId"],
      sentry: ["appSlug"],
      pagerduty: ["serviceId"],
      microsoftTeams: ["tenantId", "teamId", "resource"],
      webhook: [],
    };
    if (
      required[input.source]!.some((key) => !input.configuration[key]?.trim()) ||
      Object.values(input.configuration).some((value) => /[\x00-\x1f\x7f]/.test(value))
    )
      throw new ApiError(
        400,
        "invalid_webhook_config",
        "Complete the required provider configuration fields"
      );
    if (input.source === "microsoftTeams" && (input.signingSecret?.length ?? 0) > 128)
      throw new ApiError(
        400,
        "invalid_webhook_secret",
        "Teams client state must contain at most 128 characters"
      );
    for (const key of ["signingSecret", "apiToken"] as const)
      if (
        input[key] !== undefined &&
        (typeof input[key] !== "string" ||
          input[key]!.length > 16000 ||
          input[key]!.length < 16 ||
          /[\x00-\x1f\x7f]/.test(input[key]!))
      )
        throw new ApiError(
          400,
          "invalid_webhook_key",
          "Signing secrets and API tokens must contain at least 16 characters"
        );
    if (["slack", "sentry"].includes(input.source)) {
      const key = input.source === "slack" ? "appId" : "appSlug";
      if (
        input.configuration[key] &&
        (await this.db.automationWebhook.count({
          where: {
            source: input.source,
            id: { not: input.id ?? "00000000-0000-0000-0000-000000000000" },
            configuration: { path: [key], equals: input.configuration[key] },
          },
        }))
      )
        throw new ApiError(
          409,
          "webhook_app_in_use",
          "This provider app already has an event owner. Use that binding or create a separate provider app."
        );
    }
    const id = input.id ?? randomUUID();
    const previous = await this.db.automationWebhook.findUnique({ where: { id } });
    if (previous && ["connecting", "uncertain"].includes(previous.status))
      throw new ApiError(
        409,
        "webhook_setup_pending",
        "Subscription setup is in progress or its outcome is uncertain. Inspect the provider subscription before making changes."
      );
    if (
      previous?.remoteId &&
      (previous.callbackUrl !== `${origin.href.replace(/\/$/, "")}/api/v0/automation-hooks/${id}` ||
        (input.signingSecret !== undefined && input.signingSecret !== previous.signingSecret) ||
        previous.source !== input.source ||
        previous.ownerId !== input.ownerId ||
        previous.ownerKind !== input.ownerKind ||
        stableConfig(previous.configuration) !== stableConfig(input.configuration))
    )
      throw new ApiError(
        409,
        "webhook_target_changed",
        "Delete this subscription before changing its provider, owner or target"
      );
    const signingSecret =
      input.signingSecret ??
      previous?.signingSecret ??
      (input.source === "pagerduty" ? randomUUID() : undefined);
    if (!signingSecret)
      throw new ApiError(
        400,
        "webhook_secret_required",
        "Enter the provider signing secret, or a new random secret for GitHub, Graph, PagerDuty or generic webhooks"
      );
    const data = {
      externalAppKey: ["slack", "sentry"].includes(input.source)
        ? `${input.source}:${input.configuration[input.source === "slack" ? "appId" : "appSlug"]}`
        : null,
      source: input.source,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      configuration: toJson(input.configuration),
      callbackUrl: `${origin.href.replace(/\/$/, "")}/api/v0/automation-hooks/${id}`,
      signingSecret,
      apiToken: input.apiToken ?? previous?.apiToken ?? null,
      enabled: input.enabled ?? true,
      status: "pending",
      statusMessage: null,
    };
    if (previous) {
      const changed = await this.db.automationWebhook
        .updateMany({
          where: {
            id,
            updatedAt: previous.updatedAt,
            status: { notIn: ["connecting", "uncertain"] },
          },
          data,
        })
        .catch(() => {
          throw new ApiError(
            409,
            "webhook_save_failed",
            "This subscription could not be saved; reload settings and verify the provider app is not already connected"
          );
        });
      if (!changed.count)
        throw new ApiError(
          409,
          "webhook_changed",
          "Subscription changed concurrently; reload settings"
        );
    } else {
      try {
        await this.db.automationWebhook.create({ data: { id, ...data } });
      } catch {
        throw new ApiError(
          409,
          "webhook_save_failed",
          "This subscription could not be saved; reload settings and verify the provider app is not already connected"
        );
      }
    }
    return this.connect(id);
  }
  private async request(row: Row, url: string, method: string, body?: unknown) {
    const authorization =
      row.source === "pagerduty"
        ? `Token token=${row.apiToken}`
        : row.source === "linear"
          ? row.apiToken!
          : `Bearer ${row.apiToken}`;
    const response = await this.fetcher(url, {
      method,
      headers: {
        authorization,
        "content-type": "application/json",
        accept:
          row.source === "pagerduty"
            ? "application/vnd.pagerduty+json;version=2"
            : "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new Error("Provider connection failed; inspect the subscription before retrying");
    });
    if (!response.ok) throw new ProviderResponseError(response.status);
    if (response.status === 204) return {};
    try {
      return (await response.json()) as any;
    } catch {
      throw new Error("Provider returned an invalid subscription response");
    }
  }
  async connect(id: string): Promise<AutomationWebhookView> {
    const row = await this.db.automationWebhook.findUniqueOrThrow({ where: { id } });
    if (!row.enabled || row.status === "uncertain") return this.viewOf(row);
    const claimed = await this.db.automationWebhook.updateMany({
      where: { id, updatedAt: row.updatedAt, status: { notIn: ["connecting", "uncertain"] } },
      data: { status: "connecting", statusMessage: null },
    });
    if (!claimed.count) return this.viewOf(row);
    const c = row.configuration as Record<string, string>;
    let remoteId = row.remoteId;
    let expiresAt: Date | null = null;
    let creating = false;
    try {
      if (row.source !== "webhook" && !row.apiToken)
        throw new Error("Enter a provider API token with permission to manage subscriptions");
      if (row.source === "github") {
        if (!/^[\w.-]+\/[\w.-]+$/.test(c.repository ?? ""))
          throw new Error("configuration.repository must be owner/repository");
        const base = `https://api.github.com/repos/${c.repository}/hooks`;
        creating = !remoteId;
        const result = await this.request(
          row,
          remoteId ? `${base}/${encodeURIComponent(remoteId)}` : base,
          remoteId ? "PATCH" : "POST",
          {
            name: "web",
            active: true,
            events: [
              "pull_request",
              "pull_request_review",
              "pull_request_review_comment",
              "pull_request_review_thread",
              "issue_comment",
              "issues",
              "check_run",
              "check_suite",
              "workflow_run",
            ],
            config: {
              url: row.callbackUrl,
              content_type: "json",
              secret: row.signingSecret,
              insecure_ssl: "0",
            },
          }
        );
        if (result.id === undefined) throw new Error("Provider returned no subscription ID");
        remoteId = String(result.id);
      } else if (row.source === "microsoftTeams") {
        if (
          !uuid.test(c.tenantId ?? "") ||
          !/^teams\/[\w-]+\/channels\/[^/]+\/messages$/.test(c.resource ?? "")
        )
          throw new Error(
            "Configure tenantId and resource teams/TEAM_ID/channels/CHANNEL_ID/messages"
          );
        creating = !remoteId;
        expiresAt = new Date(Date.now() + 50 * 60_000);
        const result = await this.request(
          row,
          `https://graph.microsoft.com/v1.0/subscriptions${remoteId ? `/${encodeURIComponent(remoteId)}` : ""}`,
          remoteId ? "PATCH" : "POST",
          remoteId
            ? { expirationDateTime: expiresAt.toISOString() }
            : {
                changeType: "created,updated",
                notificationUrl: row.callbackUrl,
                resource: c.resource,
                expirationDateTime: expiresAt.toISOString(),
                clientState: row.signingSecret,
                includeResourceData: false,
              }
        );
        remoteId = result.id ?? remoteId;
      } else if (row.source === "linear") {
        if (!c.teamId) throw new Error("Configure teamId for the Linear team");
        if (!remoteId) {
          creating = true;
          const result = await this.request(row, "https://api.linear.app/graphql", "POST", {
            query:
              "mutation($input:WebhookCreateInput!){webhookCreate(input:$input){success webhook{id}}}",
            variables: {
              input: {
                url: row.callbackUrl,
                teamId: c.teamId,
                resourceTypes: ["Issue", "Cycle"],
                secret: row.signingSecret,
              },
            },
          });
          if (result.errors || !result.data?.webhookCreate?.success)
            throw new Error("Linear refused webhook creation; verify admin scope and team access");
          remoteId = result.data.webhookCreate.webhook.id;
        }
      } else if (row.source === "pagerduty") {
        if (!c.serviceId) throw new Error("Configure serviceId for the PagerDuty service");
        if (!remoteId) {
          creating = true;
          const result = await this.request(
            row,
            "https://api.pagerduty.com/webhook_subscriptions",
            "POST",
            {
              webhook_subscription: {
                type: "webhook_subscription",
                delivery_method: { type: "http_delivery_method", url: row.callbackUrl },
                events: [
                  "incident.triggered",
                  "incident.acknowledged",
                  "incident.resolved",
                  "incident.escalated",
                ],
                filter: { type: "service_reference", id: c.serviceId },
              },
            }
          );
          remoteId = result.webhook_subscription?.id;
          const generatedSecret = result.webhook_subscription?.delivery_method?.secret;
          if (typeof generatedSecret !== "string" || generatedSecret.length < 16)
            throw new Error(
              "PagerDuty did not return its signing secret; inspect the subscription before reconnecting"
            );
          await this.db.automationWebhook.update({
            where: { id },
            data: { remoteId, signingSecret: generatedSecret },
          });
        }
      } else if (row.source === "slack") {
        if (!c.appId || !c.teamId)
          throw new Error(
            "Configure Slack appId and teamId; the API token must be an app configuration token"
          );
        const exported = await this.request(
          row,
          "https://slack.com/api/apps.manifest.export",
          "POST",
          { app_id: c.appId }
        );
        if (!exported.ok)
          throw new Error("Slack manifest export failed; use an app configuration token");
        const manifest = exported.manifest;
        manifest.settings ??= {};
        manifest.settings.event_subscriptions = {
          ...(manifest.settings.event_subscriptions ?? {}),
          request_url: row.callbackUrl,
          bot_events: [
            ...new Set([
              ...(manifest.settings.event_subscriptions?.bot_events ?? []),
              "message.channels",
              "message.groups",
              "message.im",
              "message.mpim",
              "app_mention",
              "reaction_added",
            ]),
          ],
        };
        const result = await this.request(
          row,
          "https://slack.com/api/apps.manifest.update",
          "POST",
          { app_id: c.appId, manifest: JSON.stringify(manifest) }
        );
        if (!result.ok)
          throw new Error(
            "Slack refused manifest update; verify scopes and reinstall the app if requested"
          );
        remoteId = c.appId;
      } else if (row.source === "sentry") {
        if (!c.appSlug) throw new Error("Configure appSlug for the Sentry custom integration");
        const url = `https://sentry.io/api/0/sentry-apps/${encodeURIComponent(c.appSlug)}/`;
        const existing = await this.request(row, url, "GET");
        await this.request(row, url, "PUT", {
          name: existing.name,
          scopes: existing.scopes,
          webhookUrl: row.callbackUrl,
          events: [...new Set([...(existing.events ?? []), "issue"])],
        });
        remoteId = c.appSlug;
      }
      if (row.source !== "webhook" && !remoteId)
        throw new Error(
          "Provider did not confirm a subscription; inspect provider settings before reconnecting"
        );
      return this.viewOf(
        await this.db.automationWebhook.update({
          where: { id },
          data: { remoteId, expiresAt, status: "connected", statusMessage: null },
        })
      );
    } catch (error) {
      if (
        row.source === "microsoftTeams" &&
        row.remoteId &&
        error instanceof ProviderResponseError &&
        error.status === 404
      ) {
        await this.db.automationWebhook.update({
          where: { id },
          data: { remoteId: null, expiresAt: null, status: "pending" },
        });
        return this.connect(id);
      }
      const uncertain =
        creating && (!(error instanceof ProviderResponseError) || error.status >= 500);
      return this.viewOf(
        await this.db.automationWebhook.update({
          where: { id },
          data: {
            status: uncertain ? "uncertain" : "error",
            statusMessage: uncertain
              ? "Provider creation was not confirmed. Do not reconnect blindly. Inspect the provider for this exact callback; remove any created subscription there before disconnecting and creating a replacement."
              : (error instanceof Error ? error.message : "Subscription failed").slice(0, 1000),
          },
        })
      );
    }
  }
  async receive(id: string, request: Request) {
    if (!uuid.test(id)) return null;
    const row = await this.db.automationWebhook.findUnique({ where: { id } });
    if (!row) return null;
    if (!row.enabled) return new Response("Webhook disabled", { status: 410 });
    const c = row.configuration as Record<string, string>;
    const binding: AutomationWebhookBinding = {
      ...c,
      id,
      source: row.source as AutomationWebhookBinding["source"],
      owner: { kind: row.ownerKind as "bot" | "group", id: row.ownerId },
      subscriptionId: row.remoteId ?? undefined,
    };
    return receiveAutomationWebhook(
      request,
      binding,
      row.signingSecret,
      this.dispatch,
      Date.now(),
      (resource) => this.request(row, `https://graph.microsoft.com/v1.0/${resource}`, "GET")
    );
  }
  async remove(id: string) {
    const row = await this.db.automationWebhook.findUniqueOrThrow({ where: { id } });
    const claimed = await this.db.automationWebhook.updateMany({
      where: { id, updatedAt: row.updatedAt, status: { not: "connecting" } },
      data: { enabled: false, status: "connecting" },
    });
    if (!claimed.count)
      throw new ApiError(
        409,
        "webhook_busy",
        "Subscription is changing; wait for setup to finish before disconnecting"
      );
    const c = row.configuration as Record<string, string>;
    try {
      if (row.remoteId) {
        if (row.source === "github")
          await this.request(
            row,
            `https://api.github.com/repos/${c.repository}/hooks/${encodeURIComponent(row.remoteId)}`,
            "DELETE"
          );
        if (row.source === "microsoftTeams")
          await this.request(
            row,
            `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(row.remoteId)}`,
            "DELETE"
          );
        if (row.source === "pagerduty")
          await this.request(
            row,
            `https://api.pagerduty.com/webhook_subscriptions/${encodeURIComponent(row.remoteId)}`,
            "DELETE"
          );
        if (row.source === "linear") {
          const result = await this.request(row, "https://api.linear.app/graphql", "POST", {
            query: "mutation($id:String!){webhookDelete(id:$id){success}}",
            variables: { id: row.remoteId },
          });
          if (!result.data?.webhookDelete?.success)
            throw new Error("Linear did not confirm webhook deletion");
        }
      }
    } catch (error) {
      if (!(error instanceof ProviderResponseError && error.status === 404)) {
        await this.db.automationWebhook.update({
          where: { id },
          data: {
            enabled: false,
            status: "error",
            statusMessage:
              "Local delivery is disabled. Provider removal was not confirmed; retry disconnect to remove the remote subscription.",
          },
        });
        throw new ApiError(
          502,
          "webhook_remove_failed",
          "Local delivery is disabled. Provider removal was not confirmed; retry disconnect."
        );
      }
    }
    await this.db.automationWebhook.delete({ where: { id } });
    return {
      removed: true,
      notice: ["slack", "sentry"].includes(row.source)
        ? "Local delivery is revoked. The shared provider app settings remain; change its callback there if retiring the app."
        : null,
    };
  }
  async renew() {
    await this.db.automationWebhook.updateMany({
      where: { status: "connecting", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      data: {
        status: "uncertain",
        statusMessage:
          "Subscription setup was interrupted. Inspect the provider for this callback before replacing it.",
      },
    });
    const rows = await this.db.automationWebhook.findMany({
      where: {
        enabled: true,
        status: "connected",
        expiresAt: { lt: new Date(Date.now() + 15 * 60_000) },
      },
    });
    for (const row of rows) await this.connect(row.id);
  }
}
