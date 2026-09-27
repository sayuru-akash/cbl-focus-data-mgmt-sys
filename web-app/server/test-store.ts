import { Store } from "./store";
import pg from "pg";
export async function openTestStore() {
  if (!process.env.FOCUS_TEST_POSTGRES) return Store.open(":memory:");
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("sslmode", "verify-full");
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1, idleTimeoutMillis: 5000 });
  // Long fixture replays must not retain an idle administrative connection.
  admin.on("error", () => {});
  const schema = "focus_test_" + crypto.randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    const store = await Store.open(url.toString(), schema);
    const close = store.db.close;
    store.db.close = async () => {
      await close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    };
    return store;
  } catch (error) {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
}
