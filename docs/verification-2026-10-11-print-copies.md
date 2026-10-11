# Repeated print copies, 2026-10-11

## Change

Complete CBL distributor/customer copies within one capture are compared through the final summary. Matching copies contribute one item list, return calculation and discount-category breakdown. Copy labels and footer print metadata do not affect comparison. Different complete copies extract the first copy and require explicit review. Incomplete continuation pages and repeated item rows retain their existing review behavior and are not deduplicated by product identity.

Raw captures remain unchanged. Byte-identical uploads still deduplicate, while separately captured reprints retain evidence and cannot accept an original invoice twice.

## Evidence

- Local suite: 107 tests passed. The final smaller ledger fixture also passed all five repeated-copy tests.
- TypeScript check and Next production build passed.
- Disposable Postgres: all five Finance tests and all five repeated-copy tests passed. An initial full-catalogue ledger fixture exceeded the 60-second test budget; the ledger fixture was reduced to representative sale/free rows, retaining full-copy parsing coverage separately.
- Read-only comparison with the three affected real captures proved two identical complete copies in each. The new parser produced one category breakdown with no reconciliation difference.
- Vercel deployment `dpl_7H5paXtbzQCzvuEAEw3C7rXQz8k2` reached Ready and was assigned to `cbf.amsonline.lk` (application commit `26c93bd`).

## Authorized data correction

The reviewed category breakdowns on accepted bills 73517, 73695 and 73704 were corrected atomically, with a prior-state audit entry and incremented revision. Original receipts, raw captures, reviewed item lists, deductions and net amounts were preserved.

October accepted Finance category issues changed from 3 to 0; category difference changed from Rs -3,176.28 to zero. Hash comparisons inside the correction transaction proved other bills and the stock, allocations, returns, customers and intake tables unchanged. All other Finance summary fields were unchanged.

Recovery evidence and the operation script remain private under ignored `web-app/data/operations/repeated-copy-category-repair-2026-10-11/`, with restricted file permissions. No initialization or broad reparse was run against production.

Live Finance was read in the browser after correction: the warning was absent, category totals reconciled, and no browser errors were recorded. The task-created verification tab was closed. No local servers were started.
