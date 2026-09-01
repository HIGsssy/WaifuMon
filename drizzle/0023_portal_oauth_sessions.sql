CREATE TABLE IF NOT EXISTS "portal_oauth_states" (
  "state_digest" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "portal_sessions" (
  "session_digest" text PRIMARY KEY NOT NULL,
  "discord_user_id" text NOT NULL,
  "discord_username" text,
  "discord_avatar_url" text,
  "selected_discord_guild_id" text,
  "selected_guild_db_id" bigint,
  "player_id" bigint,
  "eligible_guilds" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "csrf_token" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);

ALTER TABLE "portal_sessions"
  ADD CONSTRAINT "portal_sessions_selected_guild_db_id_guilds_id_fk"
  FOREIGN KEY ("selected_guild_db_id") REFERENCES "public"."guilds"("id")
  ON DELETE no action ON UPDATE no action;

ALTER TABLE "portal_sessions"
  ADD CONSTRAINT "portal_sessions_player_id_players_id_fk"
  FOREIGN KEY ("player_id") REFERENCES "public"."players"("id")
  ON DELETE no action ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "portal_oauth_states_expires_idx"
  ON "portal_oauth_states" USING btree ("expires_at");

CREATE INDEX IF NOT EXISTS "portal_sessions_expires_idx"
  ON "portal_sessions" USING btree ("expires_at");

CREATE INDEX IF NOT EXISTS "portal_sessions_discord_user_idx"
  ON "portal_sessions" USING btree ("discord_user_id");

CREATE INDEX IF NOT EXISTS "portal_sessions_player_idx"
  ON "portal_sessions" USING btree ("player_id");
