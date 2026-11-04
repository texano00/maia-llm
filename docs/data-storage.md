# Data storage

The telemetry API (`apps/telemetry-api`) stores two things: diagnostic batches sent
by the desktop app, and the shared GPU reputation. Both live in one SQLite
database on the server.

```bash
npm run -w @maia/telemetry-api dev      # migrates and serves on :8787
```

| Variable                        | Default             | Purpose                                                               |
| ------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `MAIA_DATABASE_FILE`            | `./var/maia.sqlite` | SQLite file (created, with its directory, on first boot)              |
| `MAIA_DB_DRIVER`                | `sqlite`            | Storage engine; `sqlite` is implemented, the port is ready for others |
| `MAIA_TELEMETRY_RETENTION_DAYS` | `30`                | Telemetry older than this is deleted on every ingest                  |
| `MAIA_UNSTABLE_TTL_HOURS`       | `6`                 | How long a failed GPU stays out of circulation                        |
| `MAIA_REPUTATION_FILE`          | unset               | Legacy JSON file, imported once and archived to `*.imported`          |

The driver is Node's built-in `node:sqlite` (Node 22.13+ / 23.4+), not a native
addon: the service installs with no compiler step, and the desktop app rebuilding
`better-sqlite3` for Electron's ABI cannot break it.

## Schema

```mermaid
erDiagram
  telemetry_batches ||--o{ telemetry_events : contains
  gpu_machines ||--o{ gpu_reports : "history (by machine_id)"

  telemetry_batches {
    integer id PK
    text app
    text version
    text platform
    integer event_count
    text received_at
  }
  telemetry_events {
    integer id PK
    integer batch_id FK
    text occurred_at
    text level
    text message
    text context_json
  }
  gpu_machines {
    integer machine_id PK
    text gpu_name
    text status
    integer successes
    integer failures
    text last_success_at
    text last_failure_at
    text last_error
    text updated_at
  }
  gpu_reports {
    integer id PK
    integer machine_id
    text outcome
    text gpu_name
    integer offer_id
    text error
    text reported_at
  }
```

Design rules that keep the schema portable:

| Concern            | Rule                                           | Why                                                     |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| Timestamps         | ISO-8601 UTC `TEXT`                            | Sorts correctly and is unambiguous on every engine      |
| Booleans           | `INTEGER` 0/1                                  | SQLite has no boolean type; MySQL/PostgreSQL accept 1/0 |
| JSON               | `TEXT` column, parsed by the repository        | `jsonb`/`JSON` are not shared syntax                    |
| Surrogate keys     | One `autoId(dialect)` helper in the migration  | The only place SQLite, PostgreSQL and MySQL differ      |
| Counters and state | One row per machine, recomputed by the service | No dialect-specific upsert is needed                    |
| History            | Append-only `gpu_reports`                      | A counter reset cannot destroy evidence                 |

`GET /health` reports the active engine (`{"status":"ok","storage":"sqlite"}`), so
a deployment can be checked from outside.

## Layers

```
routes        Fastify handlers: parse, validate, shape the response
  ↓
services      domain rules: counters, freshness, retention
  ↓
repositories  SQL, expressed once for all dialects, `?` placeholders
  ↓
ports         SqlDatabase / SqlExecutor: async, driver-free interface
  ↓
adapters      src/db/sqlite.ts (node:sqlite)
```

- `src/db/database.ts` — the port plus helpers (`normaliseParams`,
  `toNumberedPlaceholders`) that adapters share.
- `src/db/sqlite.ts` — the only file that imports a driver. It serialises
  transactions (SQLite has a single connection) and sets WAL, foreign keys and a
  busy timeout.
- `src/db/migrate.ts` — applies migrations in one transaction each and records
  them in `schema_migrations`. The table is an ordinary one rather than SQLite's
  `user_version` pragma, so history survives an engine change.
- `src/repositories/*` — SQL, dialect-free. No service or route imports a driver.
- `src/services/*` — rules only; they take a repository, so they are tested with
  an in-memory database and an injected clock.
- `src/context.ts` — composition root: config → database → migrations →
  repositories → services.

## Adding a migration

1. Add `src/db/migrations/00N-name.ts` exporting a `Migration`.
2. Register it in `src/db/migrations/index.ts`; ids are applied in order and never
   reused.
3. Keep the statements ANSI: `TEXT`/`INTEGER`, `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `LIMIT ?`. No `ON CONFLICT`, no `AUTOINCREMENT`
   outside `autoId()`, no engine-specific functions.
4. Boot the service against a scratch file (`MAIA_DATABASE_FILE=/tmp/t.sqlite`) and
   check the migration applies and is idempotent on the second boot.

## Moving to PostgreSQL or MySQL

The SQL, the repositories, the services and the routes are already engine-neutral.
The work is confined to one new adapter and a short verification pass:

1. **Add the adapter** — implement `SqlDatabase` in `src/db/postgres.ts` with a
   pool (`SELECT`s via `query`, writes via `execute`, `transaction` using a
   dedicated client). Translate placeholders with
   `toNumberedPlaceholders(sql, "$")` (use `"?"` for MySQL, which keeps `?`).
   `normaliseParams` already converts booleans for engines that reject them.
2. **Select it** — in `src/config.ts` return the driver from `loadConfig()` and
   build the adapter in `src/context.ts`. `migrations` and every repository are
   used unchanged.
3. **Check the schema** — run the migrations against an empty database. Only
   `autoId()` needs a dialect branch; it already has `postgres` and `mysql`
   branches.
4. **Verify behaviour** — the suite is engine-agnostic. Point
   `createAppContext({ databaseFile })` at the new adapter and run
   `npx vitest run apps/telemetry-api`; the tests assert on ISO timestamps, monotonic
   history and retention, not on SQLite specifics.
5. **Copy the data** — export from SQLite (`sqlite3 maia.sqlite .dump` or a small
   script over the repositories) and import into the new engine. `id` columns are
   the only values worth preserving, because `machine_id` and timestamps carry the
   meaning.
6. **Keep the file** — SQLite remains the zero-dependency default for a single
   box. The port exists so a shared deployment can switch without a rewrite.

## Backup and inspection

- The database is a single file plus `-wal`/`-shm` sidecars. Copy all three, or
  stop the service first.
- `sqlite3 var/maia.sqlite 'select * from gpu_machines'` works from any shell.
- Telemetry can be read over HTTP: `GET /v1/diagnostics/logs?level=error&limit=50`.
