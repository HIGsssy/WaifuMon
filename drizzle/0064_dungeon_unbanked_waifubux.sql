ALTER TABLE dungeon_runs ADD COLUMN unbanked_waifubux integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE dungeon_runs ADD CONSTRAINT dungeon_runs_unbanked_waifubux_check CHECK (unbanked_waifubux >= 0);
