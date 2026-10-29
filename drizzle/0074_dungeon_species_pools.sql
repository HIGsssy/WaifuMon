-- Mutable shared encounter pools. Runs freeze bodies in dependency_snapshot;
-- definitions/revisions and regional hunting projections are never rewritten.
CREATE TABLE IF NOT EXISTS dungeon_species_pools (
  pool_key text PRIMARY KEY CHECK (char_length(pool_key) <= 64 AND pool_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND definition->>'key' = pool_key),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS dungeon_species_pool_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pool_key text NOT NULL REFERENCES dungeon_species_pools(pool_key) ON DELETE RESTRICT,
  revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','duplicated','imported','enabled','disabled')),
  actor text,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
