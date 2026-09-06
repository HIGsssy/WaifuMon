-- Portal Admin access delegated to Discord guild roles.
--
-- Before this, Portal Admin was the guild owner and nobody else. That is a
-- hard ceiling for a server whose owner wants help authoring World
-- Encounters: the only way to delegate was to hand over the guild.
--
-- This table holds the grants an owner has chosen to hand out — one row per
-- (guild, role) — and nothing else. In particular it does **not** record the
-- owner: ownership is read live from Discord on every authorization, and a
-- row asserting it here would be a second, staler opinion that could
-- disagree with reality after a transfer. An empty table therefore means
-- "owner only", which is precisely the behaviour that shipped before it
-- existed. That is what makes this migration additive in effect as well as
-- in form: applying it changes no one's access.
--
-- `permissions` is text[] rather than a join table because a grant is always
-- read as one whole set during authorization and is never queried by
-- individual permission. Deliberately *not* CHECK-constrained against the
-- permission vocabulary: that list is application-level and changes with
-- releases, so a constraint would turn adding a permission into a migration.
-- `AdminRoleGrantService` validates writes against the grantable set, and
-- authorization intersects again on read — so a permission that no longer
-- exists (or was never grantable) grants nothing even if a row still names it.
--
-- The unique index on (guild, role) is load-bearing: it makes re-adding a
-- role idempotent, and it is the key the API addresses a grant by, since the
-- Portal UI knows a role snowflake but never a surrogate row id.
CREATE TABLE "guild_admin_role_grants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"discord_guild_id" text NOT NULL,
	"role_id" text NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guild_admin_role_grants_guild_role_uq" ON "guild_admin_role_grants" USING btree ("discord_guild_id","role_id");--> statement-breakpoint
CREATE INDEX "guild_admin_role_grants_guild_idx" ON "guild_admin_role_grants" USING btree ("discord_guild_id");
