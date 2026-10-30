-- Content Portability CP-4B: complete dungeon bundles stage artwork files the
-- same way CP-3 enemy packages do, so they share CP-3's import journal and its
-- startup recovery instead of a second cleanup mechanism. `kind` says which
-- importer wrote a row; existing rows are enemy package imports. Additive.
ALTER TABLE enemy_package_imports ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'enemy_package';
--> statement-breakpoint
ALTER TABLE enemy_package_imports DROP CONSTRAINT IF EXISTS enemy_package_imports_kind_check;
--> statement-breakpoint
ALTER TABLE enemy_package_imports ADD CONSTRAINT enemy_package_imports_kind_check CHECK (kind IN ('enemy_package','dungeon_bundle'));
