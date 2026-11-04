/**
 * Storage port.
 *
 * Everything above this layer (repositories, services, routes) is written
 * against this interface and never imports a database driver, so the SQLite
 * implementation can be swapped for PostgreSQL or MySQL without touching
 * business code:
 *
 * - Repositories use `?` positional placeholders and plain ANSI SQL; the
 *   adapter is responsible for translating placeholders and binding values.
 * - Every method is async, even though SQLite answers synchronously, because a
 *   networked database does not. Writing the port any other way would force a
 *   rewrite of every caller at migration time.
 * - Timestamps travel as ISO-8601 UTC strings and booleans as 0/1 integers so
 *   the same SQL behaves identically on every dialect.
 */
export type SqlDialect = "sqlite" | "postgres" | "mysql";

/** Values a statement may bind. Booleans are normalised to 0/1 by adapters. */
export type SqlValue = string | number | boolean | null;

export type SqlParams = readonly SqlValue[];

export type SqlRow = Record<string, unknown>;

export interface SqlStatementResult {
  /** Rows touched by the statement (INSERT/UPDATE/DELETE). */
  changes: number;
  /** Generated key for an insert, when the dialect reports one. */
  lastInsertId: number | null;
}

export interface SqlExecutor {
  query<TRow extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]>;
  execute(sql: string, params?: SqlParams): Promise<SqlStatementResult>;
}

export interface SqlDatabase extends SqlExecutor {
  readonly dialect: SqlDialect;
  /**
   * Runs `work` atomically. Callbacks must only touch the database: the
   * SQLite adapter serialises transactions and holds the connection open.
   */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Normalises bound values for drivers that reject booleans and `undefined`. */
export function normaliseParams(params: SqlParams = []): SqlValue[] {
  return params.map((value) => {
    if (value === undefined) {
      return null;
    }
    return typeof value === "boolean" ? (value ? 1 : 0) : value;
  });
}

/**
 * Rewrites `?` placeholders to the numbered form PostgreSQL and MySQL expect
 * (`$1, $2…`). Quoted strings and comments are skipped so a literal question
 * mark is left alone.
 */
export function toNumberedPlaceholders(sql: string, prefix: "$" | "?" = "$"): string {
  let index = 0;
  let output = "";
  let quote: "'" | '"' | null = null;

  for (let position = 0; position < sql.length; position += 1) {
    const character = sql[position]!;

    if (quote) {
      output += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }

    if (character === "?") {
      index += 1;
      output += `${prefix}${index}`;
      continue;
    }

    output += character;
  }

  return output;
}
