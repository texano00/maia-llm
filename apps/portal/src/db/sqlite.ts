import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  normaliseParams,
  type SqlDatabase,
  type SqlDialect,
  type SqlExecutor,
  type SqlParams,
  type SqlRow,
  type SqlStatementResult,
} from "./database.js";

export interface SqliteDatabaseOptions {
  /** File path, or `:memory:` for an ephemeral database (tests). */
  file: string;
}

/** Binds port-level values to the driver, which rejects booleans and `undefined`. */
function bind(params: SqlParams): SQLInputValue[] {
  return normaliseParams(params) as SQLInputValue[];
}

/**
 * SQLite adapter built on Node's own `node:sqlite`.
 *
 * No native addon: the service installs without a compiler step and cannot be
 * broken by another app in the monorepo rebuilding `better-sqlite3` for a
 * different ABI. Requires Node 22.13+ (unflagged) or 23.4+.
 */ class SqliteExecutor implements SqlExecutor {
  protected readonly statements = new Map<string, StatementSync>();

  constructor(protected readonly db: DatabaseSync) {}

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) {
      return cached;
    }

    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  async query<TRow extends SqlRow = SqlRow>(sql: string, params: SqlParams = []): Promise<TRow[]> {
    return this.prepare(sql).all(...bind(params)) as TRow[];
  }

  async execute(sql: string, params: SqlParams = []): Promise<SqlStatementResult> {
    const result = this.prepare(sql).run(...bind(params));
    const lastInsertId = Number(result.lastInsertRowid);

    return {
      changes: Number(result.changes),
      lastInsertId: Number.isFinite(lastInsertId) && lastInsertId > 0 ? lastInsertId : null,
    };
  }
}
class SqliteDatabase extends SqliteExecutor implements SqlDatabase {
  readonly dialect: SqlDialect = "sqlite";
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: DatabaseSync) {
    super(connection);
  }

  /**
   * SQLite writes run on a single connection, so transactions are serialised
   * in-process. Callbacks must not await anything other than statements, which
   * keeps the critical section short.
   */
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.connection.exec("BEGIN IMMEDIATE");

      try {
        const result = await work(this);
        this.connection.exec("COMMIT");
        return result;
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
    };

    const queued = this.tail.then(run, run);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued;
  }

  async close(): Promise<void> {
    this.statements.clear();
    this.connection.close();
  }
}

/**
 * Opens (and creates) a SQLite database with the pragmas this service relies
 * on: WAL for concurrent readers, foreign keys enforced, and a busy timeout so
 * second process waits instead of failing with `SQLITE_BUSY`.
 */
export function openSqliteDatabase(options: SqliteDatabaseOptions): SqlDatabase {
  const file = options.file;

  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }

  const connection = new DatabaseSync(file);
  connection.exec("PRAGMA journal_mode = WAL");
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA synchronous = NORMAL");

  return new SqliteDatabase(connection);
}
