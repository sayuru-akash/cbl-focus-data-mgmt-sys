# Cloud verification, 27 September 2026

## Configuration

- Vercel project: `cbl-focus-data-mgmt-sys`, root `web-app`, Bun runtime, Singapore function region.
- Public address: `https://cbf.amsonline.lk`.
- Neon: existing real SQLite workspace migrated, existing password and connector key preserved. One captured bill, no sample inventory imported. Source backup retained locally.
- New private R2 bucket: `cbf-invoice-drafts`. Existing buckets unchanged. Access token scoped to object reads/writes on this bucket only. Public access disabled.
- Draft photos upload directly to R2 using checksum-bound signed URLs. Approval queues removal of originals/previews in the stock transaction. A daily authenticated maintenance route retries deletion and removes abandoned upload objects.
- Production environment variables configured through Vercel; `.env.example` contains names and placeholders only.
- Cloud OCR uses Sharp, Tesseract orientation detection and Cloudflare Qwen 3.8 vision. No Workers subscription upgrade was made. Provider quotas still apply.

## Evidence

| Check | Result |
| --- | --- |
| Unit/integration suite | 51 tests, 265 assertions passed |
| Neon ledger suites | 44 baseline tests and 3 additional concurrency/retention tests passed in disposable schemas |
| Next.js production build | Passed |
| Android 0.5.0 build/lint | Passed, minimum Android 9 |
| Bluetooth protocol tests | Passed, including 13 printer scenarios at every split boundary |
| R2 write/read/delete, checksum upload and CORS | Passed |
| Vercel API health and authenticated reads | Passed on candidate and public domain |
| Duplicate print through Vercel | HTTP 200, same bill ID, duplicate true |
| Real supplier photos through Vercel to R2 | Two pages persisted as one draft; browser re-upload on the public domain reopened the same draft |
| Cloud OCR using real photos | 17 rows, consistent invoice number, totals reconciled to Rs 579,352.52; all review flags remain false and MRP unset |
| OCR inside deployed Vercel function | Passed on the public production deployment |
| Public-domain promotion and checks | Passed on the public production deployment |
| Physical Android print to cloud | Pending installation and one print on the user's devices |

OCR is assisted entry. Small codes and characters can still need correction. Approval requires review, valid units, pack sizes, MRP, complete invoice pages and reconciled amounts. Draft creation and extraction do not change stock.

Deployment `dpl_PcccQV8oHCg4ggDuAkSmKCHjAXAG` was promoted to the public domain. Live health returns 200; anonymous intakes and maintenance return 401; setup is disabled. The public Android APK SHA-256 matches the local verified build (`253d6a676d9b4bdc16e17f1a556d9e6882ac76695ea2ffaf3cc3623969e4470e`).

Browser checks on the public domain confirmed the 17-item review, source previews, empty required MRP, and 3 MC × 6 = 18 packets for the final item. The confirmation control is disabled until required input is supplied. No browser console errors were observed. Stock remains empty and every extracted item remains unreviewed.
