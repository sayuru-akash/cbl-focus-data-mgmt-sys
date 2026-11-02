import { test, expect } from "bun:test";
import { openDatabase } from "./db";
import { openTestStore } from "./test-store";

test.skipIf(!process.env.FOCUS_TEST_POSTGRES_SESSION)(
  "pooled operations use their requested schema despite stale server-session settings",
  async () => {
    // Session settings only. Never inspect, initialize or mutate public tables.
    const db = await openDatabase(process.env.DATABASE_URL!),
      isolated = await openTestStore();
    try {
      await db
        .query("SET search_path TO focus_test_nonexistent_session_check")
        .run();
      expect(await db.query("SELECT current_schema() schema").get()).toEqual({
        schema: "public",
      });
      expect(
        (await isolated.db.query("SELECT current_schema() schema").get())
          .schema,
      ).toMatch(/^focus_test_/);
      await isolated.db
        .query("SET search_path TO focus_test_nonexistent_session_check")
        .run();
      expect(
        (await isolated.db.query("SELECT current_schema() schema").get())
          .schema,
      ).toMatch(/^focus_test_/);
      expect(await db.query("SELECT current_schema() schema").get()).toEqual({
        schema: "public",
      });
    } finally {
      await isolated.db.close();
      await db.query("SET search_path TO public").run();
      await db.close();
    }
  },
);
