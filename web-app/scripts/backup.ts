import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
const root = resolve(import.meta.dir, "..");
const source = resolve(
  process.env.DATA_DIR || resolve(root, "data"),
  "focus.sqlite",
);
const folder = resolve(process.argv[2] || resolve(root, "data/backups"));
mkdirSync(folder, { recursive: true, mode: 0o700 });
const target = resolve(
  folder,
  `focus-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
const db = new Database(source, { readonly: true });
db.query("VACUUM INTO ?").run(target);
db.close();
const copy = new Database(target, { readonly: true });
const check = copy.query("PRAGMA integrity_check").get() as any;
copy.close();
if (check.integrity_check !== "ok")
  throw new Error("Backup integrity check failed");
console.log(`Verified backup: ${target}`);
