-- Restricted, read-only Postgres role for the ad-hoc Gemini SQL feature.
--
-- Run this once against your database, then set READONLY_DATABASE_URL in the
-- environment to a connection string using this role. This is defence in depth:
-- the application ALSO statically validates every ad-hoc query and runs it in a
-- READ ONLY transaction with a statement_timeout (see
-- backend/app/services/restricted_sql.py), but a SELECT-only role means even a
-- bypass cannot mutate data.
--
-- Replace the password before running.

CREATE ROLE media_readonly LOGIN PASSWORD 'change-me';

-- No ability to create objects.
REVOKE ALL ON SCHEMA public FROM media_readonly;
GRANT USAGE ON SCHEMA public TO media_readonly;

-- SELECT only, on the data tables the feature is allowed to see.
GRANT SELECT ON adex_rows, media_watch_rows, rate_cards, batches TO media_readonly;

-- Ensure future tables are NOT auto-granted (explicit grants only).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM media_readonly;

-- Per-role safety limits (belt and braces alongside the per-statement timeout).
ALTER ROLE media_readonly SET statement_timeout = '5s';
ALTER ROLE media_readonly SET default_transaction_read_only = on;
ALTER ROLE media_readonly SET idle_in_transaction_session_timeout = '10s';
