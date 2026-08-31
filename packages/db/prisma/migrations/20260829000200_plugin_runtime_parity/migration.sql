ALTER TABLE "PluginConnection"
ADD COLUMN "configuration" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "credentials" JSONB NOT NULL DEFAULT '{}';
