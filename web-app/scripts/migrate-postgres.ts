import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store';
import { Intakes } from '../server/intake';
import { PhotoStorage } from '../server/photos';

const sourcePath=resolve(process.argv[2] || 'data/focus.sqlite');
if(sourcePath.includes('/sample/'))throw new Error('Sample data must not be migrated into production');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const source=new Database(sourcePath,{readonly:true});
const snapshot=source.serialize();
const hash=createHash('sha256').update(snapshot).digest('hex');
const backup=resolve('data/migration-backups',`focus-${Date.now()}.sqlite`);
await mkdir(resolve('data/migration-backups'),{recursive:true,mode:0o700});
await writeFile(backup,snapshot,{mode:0o600});
source.close();
const old=new Database(backup,{readonly:true});
const store=await Store.open(process.env.DATABASE_URL);
const photos=new PhotoStorage();
await Intakes.open(store,photos);
const order=['settings','customers','products','bills','movements','purchases','stock_lots','allocations','product_aliases','intakes','intake_pages','supplier_products','received_supplier_invoices'];
const existing=new Set((old.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r=>r.name));
try {
  await store.db.transaction(async()=>{
    if(await store.setting('sqliteMigrationHash'))throw new Error('This database has already been migrated; refusing to overwrite it');
    for(const table of order.filter(t=>t!=='settings')){
      const row=await store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get();
      if(row.n)throw new Error('Destination contains data; migration stopped');
    }
    for(const table of order){
      if(!existing.has(table))continue;
      const rows=old.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as any[];
      for(const row of rows){
        if(table==='settings'){await store.set(row.key,row.value);continue;}
        // Photo migration is handled outside this transaction below; keep source bytes until it succeeds.
        const cols=Object.keys(row);
        await store.db.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));
      }
      const count=await store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get();
      if(table!=='settings'&&count.n!==rows.length)throw new Error(`Row count mismatch: ${table}`);
    }
    const mismatch=await store.db.query('SELECT p.id FROM products p WHERE p.stock<>COALESCE((SELECT SUM(l.remaining) FROM stock_lots l WHERE l.product_id=p.id),0)').all();
    if(mismatch.length)throw new Error('Stock and batch totals disagree');
    await store.set('sqliteMigrationHash',hash);
    await store.set('sqliteMigrationTime',new Date().toISOString());
  })();
  // Upload only unapproved draft photos. Preserve source snapshot for recovery.
  for(const row of await store.db.query("SELECT p.* FROM intake_pages p JOIN intakes i ON i.id=p.intake_id WHERE i.status='draft' AND p.object_key IS NULL").all()){
    const key=`drafts/${row.intake_id}/${row.id}`;
    await photos.put(key,row.raw,row.mime);
    const previewKey=row.preview ? `${key}-preview` : null;
    if(previewKey)await photos.put(previewKey,row.preview,'image/jpeg');
    await store.db.query('UPDATE intake_pages SET object_key=?,preview_key=?,raw=?,preview=NULL WHERE id=?').run(key,previewKey,new Uint8Array(),row.id);
  }
  console.log('Migration completed. Local backup:',backup);
  for(const table of order.filter(t=>t!=='settings'))console.log(table,(await store.db.query(`SELECT COUNT(*) n FROM ${table}`).get()).n);
} finally {old.close();await store.db.close();}
