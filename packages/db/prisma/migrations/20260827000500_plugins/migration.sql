CREATE TYPE "PluginInstallStatus" AS ENUM ('installed', 'disabled', 'error');
CREATE TYPE "PluginConnectionStatus" AS ENUM ('disconnected', 'needs_auth', 'ready', 'error', 'revoked');
CREATE TYPE "PluginToolDecision" AS ENUM ('deny', 'prompt', 'allow');
CREATE TYPE "PluginInvocationStatus" AS ENUM ('running', 'completed', 'failed', 'denied');

CREATE TABLE "PluginInstallation" (
  "id" UUID NOT NULL,
  "pluginKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "publisher" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "status" "PluginInstallStatus" NOT NULL DEFAULT 'installed',
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginInstallation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginConnection" (
  "id" UUID NOT NULL,
  "installationId" UUID NOT NULL,
  "connectorKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "alias" TEXT NOT NULL DEFAULT 'default',
  "transport" TEXT NOT NULL,
  "authType" TEXT NOT NULL,
  "endpoint" TEXT,
  "status" "PluginConnectionStatus" NOT NULL DEFAULT 'disconnected',
  "statusMessage" TEXT,
  "instructions" TEXT NOT NULL DEFAULT '',
  "toolSnapshot" JSONB NOT NULL DEFAULT '[]',
  "connectedAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotPluginEnablement" (
  "botId" UUID NOT NULL,
  "installationId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "skillsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotPluginEnablement_pkey" PRIMARY KEY ("botId", "installationId")
);

CREATE TABLE "BotPluginConnectionGrant" (
  "botId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotPluginConnectionGrant_pkey" PRIMARY KEY ("botId", "connectionId")
);

CREATE TABLE "PluginToolPolicy" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "botId" UUID,
  "toolName" TEXT NOT NULL,
  "decision" "PluginToolDecision" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginToolPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginActivity" (
  "id" UUID NOT NULL,
  "installationId" UUID,
  "connectionId" UUID,
  "botId" UUID,
  "kind" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginInvocation" (
  "id" UUID NOT NULL,
  "callId" TEXT NOT NULL,
  "connectionId" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "runId" UUID,
  "toolName" TEXT NOT NULL,
  "decision" "PluginToolDecision" NOT NULL,
  "status" "PluginInvocationStatus" NOT NULL DEFAULT 'running',
  "arguments" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PluginInvocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PluginInstallation_pluginKey_key" ON "PluginInstallation"("pluginKey");
CREATE INDEX "PluginInstallation_status_updatedAt_idx" ON "PluginInstallation"("status", "updatedAt");
CREATE UNIQUE INDEX "PluginConnection_installationId_connectorKey_alias_key" ON "PluginConnection"("installationId", "connectorKey", "alias");
CREATE INDEX "PluginConnection_status_updatedAt_idx" ON "PluginConnection"("status", "updatedAt");
CREATE INDEX "BotPluginEnablement_installationId_enabled_idx" ON "BotPluginEnablement"("installationId", "enabled");
CREATE INDEX "BotPluginConnectionGrant_connectionId_enabled_idx" ON "BotPluginConnectionGrant"("connectionId", "enabled");
CREATE UNIQUE INDEX "PluginToolPolicy_connectionId_botId_toolName_key" ON "PluginToolPolicy"("connectionId", "botId", "toolName");
CREATE INDEX "PluginToolPolicy_botId_connectionId_idx" ON "PluginToolPolicy"("botId", "connectionId");
CREATE INDEX "PluginActivity_createdAt_idx" ON "PluginActivity"("createdAt");
CREATE INDEX "PluginActivity_connectionId_createdAt_idx" ON "PluginActivity"("connectionId", "createdAt");
CREATE INDEX "PluginActivity_botId_createdAt_idx" ON "PluginActivity"("botId", "createdAt");
CREATE UNIQUE INDEX "PluginInvocation_callId_key" ON "PluginInvocation"("callId");
CREATE INDEX "PluginInvocation_botId_startedAt_idx" ON "PluginInvocation"("botId", "startedAt");
CREATE INDEX "PluginInvocation_connectionId_startedAt_idx" ON "PluginInvocation"("connectionId", "startedAt");
CREATE INDEX "PluginInvocation_runId_startedAt_idx" ON "PluginInvocation"("runId", "startedAt");

ALTER TABLE "PluginConnection" ADD CONSTRAINT "PluginConnection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PluginInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginEnablement" ADD CONSTRAINT "BotPluginEnablement_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginEnablement" ADD CONSTRAINT "BotPluginEnablement_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PluginInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginConnectionGrant" ADD CONSTRAINT "BotPluginConnectionGrant_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginConnectionGrant" ADD CONSTRAINT "BotPluginConnectionGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginToolPolicy" ADD CONSTRAINT "PluginToolPolicy_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginToolPolicy" ADD CONSTRAINT "PluginToolPolicy_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginActivity" ADD CONSTRAINT "PluginActivity_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PluginInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginActivity" ADD CONSTRAINT "PluginActivity_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginActivity" ADD CONSTRAINT "PluginActivity_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginInvocation" ADD CONSTRAINT "PluginInvocation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginInvocation" ADD CONSTRAINT "PluginInvocation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginInvocation" ADD CONSTRAINT "PluginInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
