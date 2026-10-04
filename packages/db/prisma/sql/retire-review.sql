-- Remove the retired action-review schema before Prisma synchronizes the new schema.
-- This runs only during deployment; no approval state is retained or translated at runtime.
DROP TABLE IF EXISTS "Approval";
DROP TABLE IF EXISTS "AutoReviewPolicy";
DROP TABLE IF EXISTS "BotPluginConnectionGrant";
DROP TABLE IF EXISTS "BotPluginEnablement";
DROP TABLE IF EXISTS "PluginToolPolicy";
ALTER TABLE IF EXISTS "PluginInvocation" DROP COLUMN IF EXISTS "decision";
ALTER TABLE IF EXISTS "PluginInstallation" DROP COLUMN IF EXISTS "mode";
ALTER TABLE IF EXISTS "SavedLoginConnection" DROP COLUMN IF EXISTS "alwaysAllow", DROP COLUMN IF EXISTS "permissionRevision";
ALTER TABLE IF EXISTS "HostMachine" DROP COLUMN IF EXISTS "localToolPermission";

DO $$
DECLARE spec RECORD; col RECORD; labels TEXT;
BEGIN
  IF to_regclass('"Run"') IS NOT NULL THEN
    -- Pending actions are interrupted, never replayed after upgrading.
    UPDATE "RunItem" SET status='failed', "completedAt"=now(), "updatedAt"=now()
      WHERE "runId" IN (SELECT id FROM "Run" WHERE status::text='waiting_approval')
      AND status::text IN ('pending','running','waiting_approval');
    UPDATE "RunItem" SET status='failed', "completedAt"=now(), "updatedAt"=now() WHERE status::text='waiting_approval';
    UPDATE "Run" SET status='interrupted', "completedAt"=now(), "updatedAt"=now()
      WHERE status::text='waiting_approval';
  END IF;
  IF to_regclass('"RoutineExecution"') IS NOT NULL THEN
    UPDATE "RoutineExecution" SET status='failed', "completedAt"=now(), "updatedAt"=now()
      WHERE status::text='waiting_approval';
  END IF;
  IF to_regclass('"PluginInstallation"') IS NOT NULL THEN
    UPDATE "PluginInstallation" SET status='installed' WHERE status::text='disabled';
  END IF;
  IF to_regclass('"PluginInvocation"') IS NOT NULL THEN
    UPDATE "PluginInvocation" SET status='failed', "completedAt"=now() WHERE status::text='denied';
  END IF;
  -- Replace only enums containing retired review values. Preserve every column's default.
  FOR spec IN SELECT * FROM (VALUES
    ('RunStatus','waiting_approval'), ('RunItemStatus','waiting_approval'), ('RoutineExecutionStatus','waiting_approval'),
    ('PluginInstallStatus','disabled'), ('PluginInvocationStatus','denied')
  ) AS specs(type_name, retired_value) LOOP
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
      JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=current_schema() AND t.typname=spec.type_name AND e.enumlabel=spec.retired_value) THEN
      SELECT string_agg(quote_literal(e.enumlabel), ',' ORDER BY e.enumsortorder) INTO labels
        FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname=current_schema() AND t.typname=spec.type_name AND e.enumlabel<>spec.retired_value;
      EXECUTE format('ALTER TYPE %I RENAME TO %I',spec.type_name,spec.type_name || '_retired');
      EXECUTE format('CREATE TYPE %I AS ENUM (%s)',spec.type_name,labels);
      FOR col IN SELECT c.table_name,c.column_name,c.column_default FROM information_schema.columns c
        WHERE c.table_schema=current_schema() AND c.udt_name=spec.type_name || '_retired' LOOP
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT',col.table_name,col.column_name);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE %I USING %I::text::%I',
          col.table_name,col.column_name,spec.type_name,col.column_name,spec.type_name);
        IF col.column_default IS NOT NULL THEN
          EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %s',col.table_name,col.column_name,
            replace(col.column_default, spec.type_name || '_retired', spec.type_name));
        END IF;
      END LOOP;
      EXECUTE format('DROP TYPE %I',spec.type_name || '_retired');
    END IF;
  END LOOP;
END $$;
