-- Creates the pg_stat_statements extension. STAGING ONLY.
--
-- IMPORTANT: scripts in /docker-entrypoint-initdb.d run only when the data
-- directory is EMPTY. The staging volume (waifumon-pgdata) already has data, so
-- on that host this file will never execute — it is here for a rebuilt stage
-- volume and for a fresh local one.
--
-- To enable the extension on an existing database, run it by hand once. It needs
-- `shared_preload_libraries = 'pg_stat_statements'` (stage-observability.conf)
-- and the restart that setting requires to already be in effect:
--
--   docker compose exec postgres \
--     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
--
-- See docs/metrics-and-observability.md.

-- Idempotent, so re-running it — or running it by hand after this file has
-- already executed on a fresh volume — is safe.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
