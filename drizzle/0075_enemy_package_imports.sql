-- Content Portability CP-3: standalone Enemy Catalogue package imports.
-- One row per apply request. It is written (status 'staged', with the storage
-- keys of every artwork file the import is about to write) and committed
-- BEFORE any file is written, so a crash between writing files and committing
-- the import leaves a durable record of exactly which files to remove.
-- The import's own transaction turns it 'applied' with the result; a caught
-- failure turns it 'failed' after removing the files; startup recovery turns
-- a stale 'staged' row 'abandoned' after removing any file no asset row names.
CREATE TABLE IF NOT EXISTS enemy_package_imports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  package_hash text NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('staged','applied','failed','abandoned')),
  staged_storage_keys text[] NOT NULL DEFAULT '{}',
  actor text,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT enemy_package_imports_result_check CHECK ((status = 'applied') = (result IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS enemy_package_imports_staged_idx ON enemy_package_imports (created_at) WHERE status = 'staged';
