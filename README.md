# Focus

A distributor workspace for Bluetooth sales bills, supplier invoice photos, and stock batches. Next.js App Router and Bun serve the application and API on Vercel. Neon Postgres stores the ledger, and a private Cloudflare R2 bucket holds draft invoice photos. SQLite remains available for the isolated local sample workspace.

## Run

```sh
cd web-app
bun install
bun run build
bun run start
```

Copy `web-app/.env.example` to `web-app/.env` and configure the production services. Open http://localhost:4310. For an isolated LAN workspace, set `FOCUS_LOCAL=1` and `SECURE_COOKIES=0`; its initial password can only be set from loopback. Sample mode sets these automatically.

## Local sample workspace

Run `cd web-app`, `bun install`, `bun run build`, then `bun run sample`. Open http://127.0.0.1:4310 and sign in with `focus-sample-2026`.

The sample workspace uses its own database in `web-app/data/sample`, leaving the real workspace intact. Restarting preserves your sample edits. It contains 80 synthetic CBL-format prints (48 accepted, 8 rejected, 24 pending), 24 products, 16 shops and 15 stock receipts (12 received, 3 drafts). Prices, shops and internal `DEMO` SKUs are examples, not official CBL data. Pending invoices 900075-900080 exercise insufficient stock, a different MRP, and an unmapped new product. The earlier pending bills are ready to accept. Raw print bytes, customer details and stock movements are retained through the normal application logic.

The sample server binds only to this computer. Stop it before running the real workspace on the same port, or set `PORT=4314 bun run sample` to use a separate port.

## First device test

1. Open https://cbf.amsonline.lk. The receiver phone needs internet access over Wi-Fi or mobile data.
2. Download `/downloads/focus-bridge.apk` from the web app's address. Install it on the **second device**, not the CBL tablet. Android 9 or newer is required.
3. The v0.5 receiver defaults to https://cbf.amsonline.lk. Enter the connector key from **Connection** once. Updating the existing APK retains its key and queued captures.
4. Tap **Start receiver**. Allow Bluetooth access. If a permission or Bluetooth enable prompt appears, tap **Start receiver** again afterward.
5. Tap **Use printer name SPP-R310** on the receiver phone. Pair it from the tablet's Bluetooth settings, removing the old phone pairing first if its name was cached. Reopen CBL's printer picker and slide **3 Inches** fully right on the phone's SPP-R310 entry. Turn off the physical printer during this test to avoid choosing it by mistake.
6. Print just one bill. Wait until the receiver's byte count stops increasing, then tap **Save bill**. A disconnected stream is also saved automatically.
7. The original appears under **Bills**. Review its contents before mapping inventory items and accepting it.

The v0.4 receiver has captured and uploaded a real CBL bill. CBL uses the standard Bluetooth Serial Port Profile and checks the device name before selecting its printer driver. Use the phone's SPP-R310 entry in the picker.

The APK listens on the standard SPP UUID `00001101-0000-1000-8000-00805f9b34fb`. Its compatibility listener accepts only paired devices and retains a secure-listener option. Version 0.4 provides the SPP-R310 model, PC437 character set, manufacturer/completion, and ready-status replies required by the inspected Bixolon driver. The phone's advertised name can be set with one button; its Bluetooth hardware address is unchanged. Keep the receiver running. It listens again after each disconnect and retries queued uploads every 20 seconds. This is a limited virtual printer profile; additional CBL print formats still require verification.

### Capture boundaries

Manual **Save bill** is intentional for the first test. A byte-stream connection can contain multiple prints, status requests, or image commands. Until real captures establish job boundaries, print and save one bill at a time. Do not assume an inactivity timeout reliably marks the end of a bill. Captures are queued in app-private storage and retried while the receiver service is running. Restart the receiver to resume queued uploads after a device restart. Interrupted captures are marked in their filenames. The current per-file limit is 10 MB.

## Bluetooth troubleshooting

The first user test on an Android 9 CBL tablet and Android 16 receiver phone showed the phone in the CBL printer picker, but the receiver stayed at Waiting for CBL tablet with 0 bytes. CBL showed a checkmark. This proves pairing/listing, not an SPP connection or print delivery.

Version 0.2 adds connection counters and a short event log. Version 0.2.1 fixes the diagnostic sender to wait for a receiver acknowledgment before reporting success; update both devices for that test. Start the phone receiver with Compatibility mode on and retry once. If it still waits, install the same APK on the CBL tablet, leave upload fields blank, and use Test Bluetooth to another device. Choose the receiver phone while its receiver remains running. This sends a fixed diagnostic marker; the bridge discards that marker rather than creating a bill. If this test succeeds but CBL does not, investigate CBL's SDK/channel/UUID with actual evidence instead of assuming ordinary SPP behavior.

Sample and real workspaces have different connector keys and databases. Both default to public port 4310, so run only one at a time unless you set a separate `PORT`. Port 4311 is the internal Next.js server.

## Inspecting the CBL printer implementation

If the direct Bluetooth test passes but CBL printing does not open a receiver connection, install the prepared bridge v0.3 on the tablet. Tap Send CBL app to Mac and select CBL Focus. The installed APK code, split APKs, and package metadata are uploaded directly to the Mac. No private app data is read.

The temporary receiver runs with `bun web-app/server/package-receiver.ts` on port 4312. Its session is stored in the ignored `web-app/data/package-transfer` folder. It accepts one package up to 256 MB, validates the container without extracting or executing it, preserves the original bytes, and acknowledges identical retries. The upload-only transfer capability expires after two hours and cannot read business records. `android-connector/local-transfer.properties` supplies the current local URL and scoped capability for this private installer; it is excluded from Git. The app caches an unsuccessful transfer so retry sends the same bytes.

Use `bun scripts/test-package-receiver.ts` to check the receiver in isolation. Do not distribute a transfer-enabled diagnostic installer outside the intended local test devices.

## Implemented

- Authenticated bill inbox with original downloads and readable text previews.
- PDF import and preview, plus arbitrary raw printer capture storage.
- Manual bill number, shop, SKU mapping, quantities, and note.
- Accept/reject, immutable closed bills, exact-byte upload deduplication, unique active bill numbers.
- Atomic stock deductions on acceptance, including combined repeated product lines.
- Item creation, viewing, editing, soft deletion, adjustments, and movement history.
- Integer thousandths for quantities, avoiding floating-point inventory drift.
- Password hashing, expiring HTTP-only sessions, ingest-only token, same-origin browser mutation checks.
- Local persistence in `web-app/data/focus.sqlite`, with SQLite WAL enabled.
- Next.js App Router with direct record URLs, responsive white and blue UI, TanStack Table and Query, Radix dialogs/popovers, cmdk product search, and Zod table-query validation.
- Server-side search, sorting, date/status filters and pagination for bills, stock, supplier invoices, customers, batches and movements. Table state stays in the URL. Product search fetches up to 30 matches instead of downloading the full catalogue.
- Automatic extraction of the verified CBL invoice format: serial number, date, outlet ID, customer/address, distributor, print metadata, item quantities, selling rates, MRP and totals. Customers link by outlet ID; each bill keeps its own historical snapshot.
- Stock in uses reviewed supplier invoice photos. Supplier-scoped codes create stable SKUs, and posting adds each batch exactly once.
- Received batches retain cost and MRP separately. Sales consume the oldest matching-MRP batches, with recorded allocations and no automatic fallback to a different MRP.
- Accepting a bill checks missing products, units and shortages, and offers stock receiving. Pending bills and failed acceptance never reduce stock.
- Explicitly accepted product mappings are remembered by printed product name and unit. CBL's sample print contains no SKU codes, so internal SKUs are not presented as CBL SKUs.
- Customers are created or updated only when a bill is accepted. Outlet ID identifies repeat customers, not spelling alone. Older approved bills cannot overwrite newer customer details; each bill retains its original printed contact details.

## Stock and print rules

Enter received quantities in each product's stock unit. Changing the unit after stock history exists is blocked. Unknown cost/MRP remains blank rather than being guessed; batches without a known MRP cannot satisfy a sale with a specified MRP. Posted stock bills and used batch prices remain fixed. New invoice batches always require a confirmed MRP.

The original bytes and decoded text remain stored with each bill. Exact retries deduplicate; differing reprints with an existing active invoice number are retained for review and cannot be accepted under that same number twice. Unexpected layouts, multiple copies, nonzero returns, free-issue sections, unrecognized text or mismatched totals require manual review instead of automatically filling stock quantities. Supplier photo intake extracts a draft and infers explicit carton sizes; every page and item still requires review.

Production uses HTTPS, secure HTTP-only sessions, a database-backed login limit, and an ingest-only connector key. Photos upload directly to the private R2 bucket using short-lived, checksum-bound URLs. Approval atomically adds stock and queues photo deletion; failures retry through the daily maintenance job. The confirmed invoice fields, original page hashes, product links, batch costs, MRP, and stock history remain. Draft photos do not expire while awaiting review. Incomplete uploads are cleaned after 24 hours.

## Production deployment

Project: `cbl-focus-data-mgmt-sys`, root directory `web-app`, runtime Bun, region Singapore. The public address is https://cbf.amsonline.lk. See `.env.example` for the environment contract. No credential belongs in `NEXT_PUBLIC_*`, an APK, or Git.

Set these Vercel Production variables: `DATABASE_URL`, `DATABASE_URL_POOLED`, `APP_URL`, `SECURE_COOKIES`, `OCR_ENGINE`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CRON_SECRET`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`, and `CLOUDFLARE_AI_MODEL`. Database, R2 and AI tokens are secret. The scheduled `/api/maintenance` route verifies `CRON_SECRET`.

`bun scripts/migrate-postgres.ts` migrates the real local SQLite workspace into an empty Neon database, preserving existing password and connector hashes/keys. It makes a consistent local backup, verifies row counts and stock balances, rejects sample folders, and refuses to overwrite an already-migrated or populated destination. Sessions are not migrated. For a new empty installation only, use `WORKSPACE_PASSWORD` (at least 10 characters) and optionally `CONNECTOR_KEY` during first setup, then remove the password environment variable.

`bun test` uses isolated SQLite stores. `FOCUS_TEST_POSTGRES=1 bun test --timeout 60000` runs store tests in disposable, uniquely named Neon schemas. It never truncates the production schema. Keep a Neon backup/recovery policy appropriate for your business; the migration backup remains in the ignored `web-app/data/migration-backups` directory.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | HTTP port |
| `HOST` | `0.0.0.0` | Bind interface |
| `DATA_DIR` | `web-app/data` | Persistent SQLite directory |
| `SECURE_COOKIES` | unset | Set `1` when served through HTTPS |

For development, run `bun run dev:sample` in `web-app`. This starts both the Next.js UI and the Bun API against the separate sample database.

## Android build

Use JDK 17+ and Android SDK 36. The current APK is debug-signed for this private device test.

```sh
cd android-connector
./gradlew assembleDebug lintDebug
```

The permanent installer link is `https://cbf.amsonline.lk/downloads/focus-bridge.apk`. It redirects to the APK in the private R2 bucket with a fresh one-hour download signature. This endpoint needs no login or database connection. APKs live under `releases/focus-bridge/`, separately from invoice photos and their cleanup queue. Web deployments do not bundle or delete these releases.

After building a new APK, publish it from `web-app`:

```sh
bun scripts/publish-bridge.ts
```

The publisher verifies the Android package, signature and version, uploads a versioned SHA-256-addressed object, reads it back to verify its checksum, then updates `server/bridge-release.json`. Include that manifest in the next deployment. It rejects changed APK bytes without a versionCode increase, downgrades and signing certificate changes. Old release objects remain available. It uses the existing R2 environment variables; no new credentials are required. `scripts/package-bridge.sh` only makes a local APK copy. APK binaries and secrets stay out of Git.

## Verification

```sh
cd web-app
bun test
bun run build
```

See [current verification](docs/verification-2026-09-27.md) for the Next.js rebuild, invoice workflow, transaction checks and visual comparison. [Earlier verification](docs/verification.md) records the original browser and Android checks.

Protocol references: [Android Bluetooth connection model](https://developer.android.com/develop/connectivity/bluetooth/connect-bluetooth-devices), [Android print services](https://developer.android.com/reference/android/printservice/PrintService).

## Supplier photo intake

Stock in has one intake path: upload or photograph every page of one supplier invoice, process the photos, check the invoice header and each line against its source, then confirm. The original bytes and upright previews stay with the draft. Saving or processing a draft never changes stock.

- Each page has its own document number. All pages must share the tax invoice number, contain a complete page sequence, and be reviewed.
- DZ is 12 packets. MC size comes from an explicit description suffix, for example `480GX6EA` means 6 packets per MC. Unclear suffixes require review. Box counts, sold units, packet conversion and printed amounts are cross-checked.
- MRP is entered from packaging when absent. Printed purchase price, discounted per-packet cost, MRP and selling price are separate. Cost is rounded to cents per packet; the original invoice amounts and exact allocated discounts remain in the intake audit.
- Supplier TIN plus product code remembers the product. Unknown codes create separate products by default. When a supplier changes a code for the same physical item, explicitly choose the existing stock item during review; the internal SKU stays stable. Names or prices alone never merge supplier products. Each receipt keeps its own cost and MRP batch.
- Every item and page must be checked before posting. Totals must reconcile exactly. Re-uploaded photo sets reopen the existing record; supplier/TIN invoice uniqueness and atomic posting prevent stock from being added twice. Stale review revisions cannot overwrite newer changes.
- Historical manual stock receipts remain read-only. Use invoice photos for new deliveries. Stock corrections require a reason and retain movement history.

Cloud `OCR_ENGINE=cloudflare` uses Sharp to prepare a full page and overlapping close-ups, Tesseract for orientation, and Cloudflare-hosted `@cf/qwen/qwen3.8-27b` for structured extraction. Model access and usage quotas depend on the Cloudflare account. Each page is cached separately so retrying a later page does not repeat completed work. Local macOS OCR uses Apple Vision when no cloud engine is selected. Original photos and previews are held privately in R2 while a cloud draft is pending, then removed after approval. OCR never approves stock: codes, totals, pack sizes and page numbers must be checked against the photo, and MRP must be confirmed from the packaging.

## Runtime and development

Node 20.9+ and Bun 1.3+ are required. `bun run start` runs the public Bun API on 4310 and the Next.js production server on loopback 4311. The public server proxies pages and assets while retaining direct control of API authentication, origin checks and the Bluetooth ingest endpoint. Use only port 4310 for the normal application. `PORT` changes the public port; `NEXT_PORT` optionally overrides the internal port.

For development, stop the production runner and use `bun run dev:sample` (sample database) or `bun run dev` (real database). Open the displayed development UI URL, normally http://127.0.0.1:4311. Both processes stop together. The production runtime and development runtime should not use the same ports simultaneously.

Run `bun test`, `bun run typecheck`, and `bun run build` to verify changes. Tests use separate in-memory or temporary databases and never modify the live workspace. `bun run backup` creates a SQLite snapshot and checks its integrity. Set `DATA_DIR=data/sample` for a sample backup. Store scheduled backups outside this machine before relying on it for live business data.

Cloud deployment, scheduled external backups, Android camera capture, and prolonged Bluetooth operation on the actual devices still need their own environment-specific verification. Local browser and transaction tests do not establish those guarantees.
