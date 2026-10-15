# Stock-in totals-page fix

Verified on 2026-10-15.

## Scope

Supplier invoices may end with a page containing totals and no product rows. Previously the extraction schema, processing guard and receipt validation each rejected that page. The fix records it as a reviewed totals-only page, retains its invoice evidence and does not create a stock line for totals or discounts.

The supplied invoice also includes 0.50 DZ. Its printed quantity and price basis remain intact; conversion produces six whole packets. Fractional cartons, boxes and individual items remain invalid. Missing pages, missing item rows on ordinary pages, inconsistent totals and missing MRP remain blocked.

## Evidence

- The actual final photo was scanned once with the configured primary reader. It returned page 5 of 5 with an empty item array and totals matching the visible document.
- Focused read-only queries of the existing draft showed four completed page caches and the failing fifth page. Its 60 cached item rows and 206 boxes reconcile with the final photo. No live draft, bill or stock was changed for verification.
- Synthetic five-page regression: retry after final-page failure reuses the four completed pages, preserves all 60 item rows, saves fractional dozen evidence, receives only whole packets and cannot post twice.
- Negative cases cover empty non-final pages, missing totals/identity, missing/duplicate pages, a wholly empty invoice, mixed item/totals-only flags and invalid packet conversion.
- Both primary and backup response parsing accept a valid totals-only page and reject missing evidence.
- All 113 local tests passed. Three selected intake regressions passed in disposable Postgres schemas, which were removed afterward.
- Typecheck and production build passed.
- Isolated browser review checked desktop and 390px mobile layout, totals-only page review/save, half-dozen editing/save, rejection of 0.51 DZ and successful correction to 0.50 DZ. No relevant browser errors; no horizontal mobile page overflow.

## Operational follow-up

Reopen the existing five-photo draft and retry processing after deployment. Completed pages are reused. The operator must still review all pages/items and enter packet MRPs from packaging before receiving. A four-photo draft remains incomplete and cannot replace the five-page invoice.

No schema, environment, provider model or dependency changes are required. Deployment status is verified separately from this local evidence.
