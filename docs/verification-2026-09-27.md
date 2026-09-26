# Focus verification, 27 September 2026

## Delivered locally

Next.js App Router replaces the Vite page switcher. Bills, products, customers, supplier invoices and individual records have direct URLs. TanStack Table and Query provide shared server-side search, sorting, pagination, date and status filters. Product selection uses cmdk with Radix Popover; dialogs use Radix Dialog. Zod validates table parameters. The existing Bun/SQLite transaction engine and Android ingest endpoint remain in place.

Production build runs at http://127.0.0.1:4310 with a separate sample database. Initial seed: 80 bills, 24 products, 16 customers and 15 stock receipts. One sample bill was accepted during verification, leaving 49 accepted, 8 rejected and 23 pending. The real workspace database and its WAL/SHM hashes remained unchanged.

## Functional evidence

- `bun test`: 38 passed, 174 assertions across six files. Includes atomic receiving, exact MRP FIFO, shortages, repeat lines, duplicate uploads, reprints, supplier code identity, page completeness, missing MRP, invalid totals, stale revisions, rollback, authentication and origin checks.
- `bun run typecheck` and `bun run build`: pass.
- Uploaded the supplied `9337.jpg` and `9338.jpg` through the browser. Local OCR produced a 17-line draft. Corrected three uncertain readings against the original photos. Both source images and the draft survived refresh and restart. Invoice gross 584,319.24, discount 4,966.72, net 579,352.52.
- MC sizes are inferred only from explicit pack descriptions. Verified `480GX6EA`, 3 MC = 18 packets. DZ remains 12 packets. The original draft has no invented MRP and has not added stock.
- Copied the real photo draft into a disposable in-memory database, provided synthetic review MRP only there, and posted it. Verified 17 products, 6,060 packets, matching invoice total, and idempotent reposting. This test did not post the user's invoice into either persistent workspace.
- Accepted sample bill 900057 in the rendered browser. Stock decreased by exactly 1, 3, 6 and 12 packets across its four products. Batch totals and item stock reconciled afterward.
- Verified stock search, sort and pagination; combined customer/date/status filters; direct product and customer links; refresh/back preserving table filters; searchable product mapping; batch MRP/cost differences; stock history; invoice review validation; production and development authentication.
- Verified a SQLite backup with `integrity_check`. Backup output was placed outside the repository under `/tmp/focus-verified-backups`.
- Verified the final in-app unsaved-draft dialog: Keep editing retains the form; Leave without saving navigates without posting changes. Native browser confirmations were replaced for application links and the Back action. Browser unload protection remains for closing or reloading the tab.
- Final browser console check returned no errors. The existing APK download returned HTTP 200 with 2,647,097 bytes.

## Visual fidelity ledger

Reference: `/Users/sayuru/.codex/generated_images/01a0c9dd-f1db-7cb2-b007-ddf61ecd7e9d/exec-4c76c3e1-89c8-4985-917c-1802a9174dde.png`.

Final screenshots use the Codex in-app browser's native tab screenshot API. Desktop viewport: 1536 x 1024. Mobile viewport: 390 x 844.

Proof files:

- `/Users/sayuru/.codex/visualizations/2026/09/22/01a0c9dd-f1db-7cb2-b007-ddf61ecd7e9d/focus-desktop.png`
- `/Users/sayuru/.codex/visualizations/2026/09/22/01a0c9dd-f1db-7cb2-b007-ddf61ecd7e9d/focus-mobile.png`

| Area | Implementation and comparison |
| --- | --- |
| Copy | Short functional labels and actual database values. Illustrative catalogue data in the reference was intentionally replaced with clearly marked DEMO SKUs. |
| Layout | Sidebar, single page heading, primary action, tabs, filters and full-width data table follow the reference. Mobile moves navigation above the page. |
| Typography | Clear heading hierarchy with compact, readable table text. Data density is intentionally higher than the illustrative reference. |
| Palette | White surfaces, blue actions and selection, slate text and subtle borders. No green primary theme. |
| Spacing | Ten real rows and pagination fit the desktop view. Fixed the status/action overlap and search icon alignment observed during QA. |
| Controls | Consistent Lucide icons, accessible dialogs and searchable popovers. Dynamic Previous/Next pagination replaces decorative page numbers. |
| Responsive | Mobile navigation and primary action remain visible at 390 px. Wide tables scroll inside their container; document width remains 390 px with no page overflow. |

## Remaining environment limits

This is a verified local build, not a cloud deployment or a promise of error-free operation. The actual supplier draft still requires MRP and item confirmation. OCR currently depends on local macOS Apple Vision, Swift and Tesseract; a non-Mac host needs an OCR worker. Android camera capture, prolonged physical-device Bluetooth operation, HTTPS hosting and scheduled external backups require verification in their target environments. Existing Android code was not changed in this rebuild.
