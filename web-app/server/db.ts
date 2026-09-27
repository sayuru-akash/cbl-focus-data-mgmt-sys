import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export async function mapAsync<T, R>(
  values: T[],
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < values.length; i++) result.push(await fn(values[i]!, i));
  return result;
}
export type RunResult = { changes: number };
export interface DataConnection {
  dialect: "sqlite" | "postgres";
  query(sql: string): {
    get(...args: any[]): Promise<any>;
    all(...args: any[]): Promise<any[]>;
    run(...args: any[]): Promise<RunResult>;
  };
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): () => Promise<T>;
  close(): Promise<void>;
}

// Only the application's fixed SQL is translated. All user values remain bound parameters.
export function postgresSql(sql: string) {
  sql = sql.replace(/\bINTEGER\b/g, "BIGINT").replace(/\bBLOB\b/g, "BYTEA");
  sql = sql.replace(
    /json_extract\(([\w.]+),'\$\.([\w]+)'\)/g,
    (_, col, field) =>
      field === "total"
        ? `(${col}::jsonb->>'${field}')::numeric`
        : `(${col}::jsonb->>'${field}')`,
  );
  sql = sql.replace(/([\w.]+) COLLATE NOCASE/g, "lower($1)");
  sql = sql
    .replace(/group_concat\(/g, "string_agg(")
    .replace(/\bLIKE\b/g, "ILIKE");
  sql = sql
    .replace(/\browid\b/g, "__order")
    .replace(/\bmatchingStock\b/g, '"matchingStock"');
  sql = sql.replace(
    /INSERT OR REPLACE INTO settings VALUES \(\?,\?\)/g,
    "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  sql = sql.replace(
    /INSERT OR REPLACE INTO product_aliases VALUES \(\?,\?,\?\)/g,
    "INSERT INTO product_aliases(name,unit,product_id) VALUES (?,?,?) ON CONFLICT(name,unit) DO UPDATE SET product_id=excluded.product_id",
  );
  sql = sql.replace(
    /INSERT OR IGNORE INTO supplier_products VALUES \(\?,\?,\?\)/g,
    "INSERT INTO supplier_products(tin,code,product_id) VALUES (?,?,?) ON CONFLICT(tin,code) DO NOTHING",
  );
  // PostgreSQL needs a type for nullable standalone parameter tests.
  sql = sql
    .replace(/\? IS NULL OR l.mrp=\?/g, "CAST(? AS BIGINT) IS NULL OR l.mrp=?")
    .replace(
      /\? IS NULL OR upper\(p.unit\)=\?/g,
      "CAST(? AS TEXT) IS NULL OR upper(p.unit)=?",
    );
  let n = 0,
    quoted = false,
    out = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      if (quoted && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      quoted = !quoted;
    }
    out += ch === "?" && !quoted ? `$${++n}` : ch;
  }
  return out;
}

export async function openDatabase(
  path: string,
  schemaName = "public",
): Promise<DataConnection> {
  if (!/^postgres(?:ql)?:/.test(path)) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const context = new AsyncLocalStorage<boolean>();
    let tail = Promise.resolve();
    const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (context.getStore()) return fn();
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await context.run(true, fn);
      } finally {
        release();
      }
    };
    return {
      dialect: "sqlite",
      query(sql) {
        return {
          get: (...a) => exclusive(async () => db.query(sql).get(...a)),
          all: (...a) => exclusive(async () => db.query(sql).all(...a)),
          run: (...a) =>
            exclusive(async () => ({
              changes: db.query(sql).run(...a).changes,
            })),
        };
      },
      exec: (sql) =>
        exclusive(async () => {
          db.exec(sql);
        }),
      transaction: (fn) => () =>
        exclusive(async () => {
          if (db.inTransaction) return fn();
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }),
      close: () =>
        exclusive(async () => {
          db.close();
        }),
    };
  }
  const url = new URL(path);
  url.searchParams.set("sslmode", "verify-full");
  const schema = schemaName;
  if (!/^(public|focus_test_[a-z0-9_]+)$/.test(schema))
    throw new Error("Invalid database schema");
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 3,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
    enableChannelBinding: true,
  });
  pool.on("error", () => console.error("Database connection interrupted"));
  const context = new AsyncLocalStorage<pg.PoolClient>();
  const withClient = async <T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> => {
    const current = context.getStore();
    if (current) return fn(current);
    const client = await pool.connect();
    try {
      if(schema!=="public")await client.query(`SET search_path TO "${schema}"`);
      return await fn(client);
    } finally {
      client.release();
    }
  };
  const rows = async (sql: string, args: any[]) =>
    withClient(async (client) => {
      const pragma = sql.match(/^PRAGMA table_info\((\w+)\)$/);
      const result = pragma
        ? await client.query(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
            [schema, pragma[1]],
          )
        : await client.query({
            text: postgresSql(sql),
            values: args.map((v) =>
              v instanceof Uint8Array ? Buffer.from(v) : v,
            ),
            types: {
              getTypeParser: (oid, format) =>
                [20, 1700].includes(oid)
                  ? Number
                  : pg.types.getTypeParser(oid, format),
            },
          });
      return result;
    });
  return {
    dialect: "postgres",
    query(sql) {
      return {
        get: async (...args) => (await rows(sql, args)).rows[0] || null,
        all: async (...args) => (await rows(sql, args)).rows,
        run: async (...args) => ({
          changes: (await rows(sql, args)).rowCount || 0,
        }),
      };
    },
    async exec(sql) {
      sql = sql.replace(/PRAGMA[^;]+;/g, "");
      // Stable insertion order is used only as the final FIFO tie-breaker.
      sql = sql.replace(
        /(CREATE TABLE IF NOT EXISTS (?:stock_lots|allocations)\([^;]+)(\);)/g,
        "$1,__order BIGSERIAL$2",
      );
      if (sql.trim())
        await withClient(async (client) => {
          await client.query(postgresSql(sql));
        });
    },
    transaction: (fn) => async () => {
      if (context.getStore()) return fn();
      return withClient(async (client) => {
        await client.query("BEGIN");
        try {
          // One distributor: serialize short ledger mutations, across every Vercel instance.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext(current_schema()), 4310)",
          );
          const result = await context.run(client, fn);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    },
    close: () => pool.end(),
  };
}
