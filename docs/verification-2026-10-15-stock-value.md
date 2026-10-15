# Finance stock value, 15 October 2026

## Scope

Finance has a separate Stock value tab at `/finance?view=stock`. It reports remaining active stock, independently of bill dates and payment filters. Direct uses each remaining batch's recorded purchase cost. RD uses the agreed 6.70% gross margin, calculated as cost / 0.933 and rounded half up to cents per sellable unit before multiplying by quantity. MRP is not a substitute for purchase cost or RD price.

Mixed-cost batches contribute separately to each product's value. Missing costs remain unpriced; known subtotals are marked Partial. Search, price filters and sorting apply consistently to cards, rows and full-result CSV. Product links retain the return URL and table position.

No schema, provider, dependency or environment changes were needed. The report does not write stock, bills or intake records.

## Verification

- `bun test`: 118 passed, 0 failed, 1,335 assertions.
- `bun run typecheck` and `bun run build`: passed.
- `FOCUS_TEST_POSTGRES=1 bun test --timeout 60000 server/stock-value.test.ts`: 5 passed, 0 failed in disposable schemas.
- Coverage includes mixed costs/MRPs, zero and missing costs, partial values, balance checks, pagination, search escaping, null sorting, CSV totals/formula protection and invalid filters.
- Isolated lifecycle checks prove draft independence and updated values after acceptance, accepted-bill reversal, stock receipt and batch cost correction.
- HTTP checks cover authentication, no-store responses, CSV and invalid sorting.
- Isolated browser checks cover pagination, search, empty results, filters, sorting, item/history navigation, Back to Finance and Finance tab switching. Filtered CSV returned one matching item and the matching totals.
- Desktop and 390 x 844 layouts were checked. The mobile page width and scroll width both measured 390px; the stock table scrolls within its container. No application console errors were observed.

## Deployment and reconciliation

Implementation commit `17ebc14` was deployed to production. Vercel reported Ready in Singapore with `cbf.amsonline.lk` assigned. The authenticated live Stock value tab and unpriced filter were verified on desktop and mobile.

At verification time, the live report showed 168 available products. Direct was Rs 5,012,754.74 and RD was Rs 5,372,786.94. Independent read-only SQL calculations reconciled both totals exactly, with no lot/product balance discrepancies. Seven batches lacked purchase costs, so the displayed totals were correctly marked Partial. These are a dated snapshot, not fixed expected production values.

No live business records were changed. The supplier draft remains for the operator to enter MRPs and receive. Task-created browser tabs were closed, the viewport override reset and the isolated local server stopped.
