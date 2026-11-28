/**
 * SQL driver abstraction. Same Postgres dialect for both backends:
 *  - DATABASE_URL set   → `pg` Pool against real Postgres / Supabase.
 *  - DATABASE_URL unset → embedded PGlite (Postgres compiled to WASM), data in
 *                         `${DATA_DIR}/pglite`; `memory://` for tests.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** Postgres connection string (takes precedence). */
  databaseUrl?: string | undefined;
  /** Directory for PGlite files, or 'memory://' for an in-memory database. */
  dataDir?: string;
}

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) return openPostgres(opts.databaseUrl);
  return openPglite(opts.dataDir ?? 'memory://');
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  let target: string | undefined;
  if (dir !== 'memory://') {
    target = path.join(dir, 'pglite');
    fs.mkdirSync(target, { recursive: true });
  }
  const pg = target ? await PGlite.create(target) : await PGlite.create();
  return {
    kind: 'pglite',
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async transaction(fn) {
      return pg.transaction(async (tx) =>
        fn({
          async query<T>(sql: string, params: unknown[] = []) {
            return (await tx.query<T>(sql, params)).rows;
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pgModule } = await import('pg');
  // int8 (bigint) → JS number: our bigints are unix-ms timestamps and counters, well within 2^53.
  pgModule.types.setTypeParser(20, (v: string) => Number(v));
  const ssl = /sslmode=require|supabase\.co|supabase\.com/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pgModule.Pool({ connectionString: url, max: 8, ...(ssl ? { ssl } : {}) });
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return {
    kind: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          async query<T>(sql: string, params: unknown[] = []) {
            return (await client.query(sql, params)).rows as T[];
          },
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
