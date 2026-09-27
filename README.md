# Focus

A private distribution workspace for sales bills, supplier invoices and stock.

**[Open workspace](https://cbf.amsonline.lk)** · **[Download Focus Bridge](https://cbf.amsonline.lk/downloads/focus-bridge.apk)**

Bluetooth prints arrive as sales drafts. Supplier invoice photos become stock-in drafts. Review and confirm before either changes inventory.

## Daily workflow

| Page | What it does |
| --- | --- |
| **Bills** | Review incoming prints; search pending, accepted and rejected bills by date, customer, number and payment type. Desktop review opens in a side panel. |
| **Stock** | See quantities, MRP batches, purchase costs, supplier codes and movement history. Receive deliveries through invoice photos. |
| **Finance** | Filter accepted sales by date and payment type; view discounts, returns and free items; export the filtered report. |
| **Customers** | Find shops and their bill history. Customers are linked by outlet ID when bills are accepted. |
| **Connection** | Download the Android receiver and copy its connector key. |

### Sales: print, review, accept

1. Print from CBL Focus to the paired Focus Bridge phone.
2. Open the incoming draft. Check customer, date, bill number, lines, MRP, quantities, discounts and returns against the original print.
3. Confirm stock mappings and choose **Cash**, **Cheque** or **Credit**. Incomplete drafts can be saved; payment type is required to accept.
4. Accept. Stock updates atomically, the review closes and a confirmation appears on the list. Rejection also closes the review. Failed actions keep the bill open for correction.

Draft fields remain editable. Saving keeps the draft open. Accepted bills retain their original receipt and stock allocations; their payment type can be changed later with an audit trail, without changing stock or bill totals.

### Stock in: photos, review, receive

1. Upload or photograph **all pages of one supplier invoice**. Processing shows progress per page and preserves completed work for retries.
2. Check the header and each item beside its photo. Correct any scanned value; confirm product code, quantities, pack size, prices and MRP.
3. Review the summary and receive stock. The app returns to Stock in with confirmation. When receiving from a sales bill's shortage dialog, it returns to that bill instead.

Drafts never change stock. Drafts can be deleted; received invoices remain read-only. A final confirmation can acknowledge identified review warnings. Invalid quantities, missing MRP, incomplete pages and inconsistent totals must be corrected before posting.

## Inventory rules

- **Whole packets:** quantities and pack sizes are whole numbers. Money is calculated in cents. The internal scaled quantity representation does not permit fractional user quantities.
- **Units:** `DZ` means 12 packets. `MC` uses explicit packaging evidence, such as `480GX6EA` for 6 packets per carton. Ambiguous sizes require review. Box counts and converted packet quantities are cross-checked.
- **Separate prices:** purchase cost, MRP and selling price are distinct. Each delivery retains its own cost and MRP batch. Missing MRP must be confirmed from packaging.
- **Stable products:** supplier TIN plus product code identifies an incoming product. Unknown codes create separate products unless deliberately linked to an existing item during review. Names or prices alone never merge supplier products.
- **Conservative sales matching:** a unique product identity or remembered mapping, matching stock unit, and available stock at the printed MRP are required for automatic selection. Different weights, flavours, ambiguous names and different MRPs stay for review. Similar names rank first in manual search; ranking does not automatically select them.
- **MRP then FIFO:** sales and free items consume the oldest available batch at the specified MRP. There is no fallback to a differently priced or unknown-MRP batch. Shortages block acceptance.
- **Returns:** fresh returns restore sellable stock. Market/expiry returns affect bill value without increasing sellable stock. Free items reduce stock without adding a sales charge.
- **Safe retries:** identical print uploads deduplicate. Conflicting reprints require review. Supplier invoice uniqueness and transactional posting prevent duplicate stock receipts. Revision checks protect against stale edits.
- **Corrections:** stock corrections require a reason and keep history. Accepted bills may be deleted within ten days using two confirmation steps. Deletion reverses their recorded stock movements atomically; a fresh-return batch already consumed elsewhere blocks reversal until its dependencies are resolved.

Historical reviewed product choices remain intact. Changing the name, unit or MRP on an automatically mapped draft line clears its selection for another review.

## Finance

Reports use bill dates and Sri Lanka time, with month-to-date, previous month, year-to-date and custom ranges. Totals cover all filtered bills, not just the visible page. Pending bills are a separate preview; rejected and deleted bills are excluded from accepted totals.

Cash, Cheque and Credit show bill counts and net billed amounts. Older unclassified records remain explicit. These are **billed values, not collected payments or profit**.

Chocolate, Candy Bar and Cereal Bars (`CERIAL BARS` on prints) show the printed discount breakdown. They are part of the bill/SKU discount, not an extra deduction. Differences are flagged for review. Line discounts, fresh returns, market returns, reverse GRTS and free quantities remain separately visible.

## Local development

Requires **Bun 1.3+** and **Node 20.9+**.

```sh
cd web-app
bun install
bun run dev:sample
```

Open **http://127.0.0.1:4311**. Sample password: **`focus-sample-2026`**.

Sample mode uses a separate SQLite database in `web-app/data/sample`. It contains synthetic prints, shops, products and stock receipts, including shortage and MRP mismatch examples. Restarting preserves your sample edits. Sample data and connector keys are separate from the real workspace.

For a production-style local sample:

```sh
bun run build
bun run sample
```

Open **http://127.0.0.1:4310**. Stop development before building or starting this runner; they share Next.js build output and default ports.

| Command / setting | Purpose |
| --- | --- |
| `bun run dev:sample` | Isolated sample UI on 4311 and API on 4310 |
| `bun run sample` | Built sample app through public port 4310 |
| `bun run dev` / `bun run start` | Use the configured database, which may be production |
| `FOCUS_LOCAL=1` | Explicitly use local SQLite instead of configured Postgres |
| `DATA_DIR` | SQLite and local file directory; defaults to `web-app/data` |
| `PORT` / `NEXT_PORT` | Public API port / internal Next.js port |
| `SECURE_COOKIES=0` | Local HTTP only; production uses `1` |

For a separate local workspace, copy [web-app/.env.example](web-app/.env.example) to `web-app/.env`, set `FOCUS_LOCAL=1` and `SECURE_COOKIES=0`, then run the app. Initial local password setup is restricted to loopback. Never point exploratory tests or sample seeding at the live database.

## Production configuration

Next.js App Router and Bun run on Vercel in Singapore. Neon Postgres holds business data. A private Cloudflare R2 bucket stores draft photos and versioned Android releases.

Vercel project: `cbl-focus-data-mgmt-sys` · Root: `web-app` · Address: **https://cbf.amsonline.lk**

Use [web-app/.env.example](web-app/.env.example) as the environment contract:

| Variables | Configuration |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_POOLED` | Direct and pooled Postgres connections |
| `APP_URL`, `SECURE_COOKIES` | `https://cbf.amsonline.lk`, `1` |
| `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Private object storage |
| `OCR_ENGINE` | `cloudflare` for the primary cloud reader |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`, `CLOUDFLARE_AI_MODEL` | Primary extraction provider |
| `GEMINI_API_KEY`, `GEMINI_OCR_MODEL` | Optional backup reader |
| `CRON_SECRET` | Authenticates the daily `/api/maintenance` cleanup job |
| `WORKSPACE_PASSWORD`, `CONNECTOR_KEY` | Optional first setup values for an empty installation only |

Credentials stay server-side. Do not put them in `NEXT_PUBLIC_*`, Git or APK source. Remove the initial workspace password environment variable after setup. Passwords are hashed; browser sessions use secure HTTP-only cookies; the receiver key permits ingestion only. Login limits and same-origin mutation checks protect the API. Pages and responses are marked **noindex**; authentication provides access control.

### Photos and extraction

- Upload up to 20 JPEG, PNG or WebP photos, at most 12 MB each and 60 MB combined.
- Cloud uploads use short-lived, checksum-bound URLs to private R2 objects.
- Cloudflare is the primary reader. Gemini is attempted only for primary quota, access, network or service failures. Malformed or unreadable output remains a review error. Provider output is schema-validated; extraction never approves stock.
- Each completed page is cached with its reader. Retry resumes unfinished work.
- Draft photos remain until receipt or draft deletion. Receipt commits stock first and queues photo cleanup. Failed deletions retry through the daily maintenance job; incomplete uploads are cleaned after 24 hours.
- Confirmed fields, page hashes, batch costs, MRP and stock history remain after photos are removed. Android release objects are separate from photo cleanup.

### Data operations

`bun scripts/migrate-postgres.ts` migrates a real local SQLite workspace into an **empty** Postgres destination, preserving workspace credentials and checking counts and stock balances. It creates a local backup, rejects sample folders and refuses populated destinations. Sessions are not migrated.

`bun run backup` creates and verifies a SQLite snapshot. Postgres recovery needs its own Neon backup/restore policy; this SQLite command does not back up Postgres. Keep recovery copies outside the development machine.

## Focus Bridge

Install the [receiver APK](https://cbf.amsonline.lk/downloads/focus-bridge.apk) on a **second Android device**, Android 9 or newer.

1. Copy the connector key from **Connection**. The receiver defaults to the live workspace URL.
2. Start the receiver and allow Bluetooth access. Use **SPP-R310** as its printer name.
3. Pair the CBL tablet with that phone. Re-pair if the old name is cached, then reopen CBL's printer picker.
4. Select the phone's **SPP-R310** entry and slide **3 Inches** fully right.
5. Print and verify that the bridge reports received bytes and **Bill uploaded**. Open the draft in the web app.

The service listens again after disconnect and retries its durable upload queue every 20 seconds while running. Restart it after a device restart. The phone needs internet access; the tablet reaches the phone over Bluetooth. A CBL checkmark alone does not confirm delivery.

A disconnect saves the capture. If CBL keeps a stream open, use **Save bill** after bytes stop increasing, before starting another bill. Do not assume an idle stream marks a complete print. Interrupted captures are retained; the per-file limit is 10 MB. Continued background operation depends on Android permissions, battery settings and the receiver service remaining active.

| Symptom | Check |
| --- | --- |
| No new connection | Receiver running, paired phone named SPP-R310, correct CBL picker entry |
| Connection but no print | Run the bridge's Bluetooth diagnostic; check the device log and print format |
| Upload queued / 401 | Correct server and connector key, then **Retry uploads** |
| Queued while offline | Restore internet; the running service retries automatically |
| Photo processing fails | Provider status/quota and retryable page errors; completed pages remain saved |

The compatibility listener uses standard Bluetooth SPP and answers the inspected Bixolon driver queries. It accepts paired devices; a secure-listener option is also available. This is a specific virtual printer profile, not universal printer emulation.

### Build and publish the APK

Requires JDK 17+ and Android SDK 36. The current private installer is debug-signed; preserve its signing identity for updates.

```sh
cd android-connector
./gradlew assembleDebug lintDebug
cd ../web-app
bun scripts/publish-bridge.ts
```

The publisher checks package, version and signing certificate, uploads a versioned SHA-256-addressed R2 object, verifies it and updates `server/bridge-release.json`. Deploy the updated manifest. Changed bytes require a higher versionCode. APK binaries and signing material stay out of Git.

The permanent `/downloads/focus-bridge.apk` endpoint redirects to a fresh signed download URL without requiring login or a database connection. Release objects survive web deployments and invoice cleanup. Installing an update preserves the phone's key and queued captures.

## Verification and project map

```sh
cd web-app
bun test
bun run typecheck
bun run build
```

Store tests use isolated SQLite databases. To verify Postgres, run `FOCUS_TEST_POSTGRES=1 bun test --timeout 60000`; test stores use disposable named schemas and do not truncate production tables. Browser tests that post stock or approve bills belong in a local test workspace, not live business data.

| Path | Contents |
| --- | --- |
| `web-app/app` | Next.js routes and API entry points |
| `web-app/src` | Screens, review flows and shared UI |
| `web-app/server` | Persistence, parsing, stock ledger, extraction and tests |
| `web-app/scripts` | Runtime, samples, migration, backup and release tools |
| `android-connector` | Bluetooth receiver and upload queue |
| `docs` | Dated verification records and technical notes |

See [workflow and MRP verification](docs/verification-2026-09-28-ux.md), [Next.js and invoice verification](docs/verification-2026-09-27.md) and [earlier device verification](docs/verification.md) for historical evidence. A passing local test, successful build and deployed check are separate evidence; physical-device camera and sustained Bluetooth checks must use the actual devices.
