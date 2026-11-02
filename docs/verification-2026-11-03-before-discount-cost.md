# Before-discount item costs

Verified 3 November 2026.

## Behavior

Item cost is the reviewed VAT-inclusive line amount divided by its converted sellable quantity, before supplier invoice discount. `invoiceCosts` returns both the before-discount and net unit costs, rounded half up in cents. Exact invoice discount allocation and payable totals are retained independently.

Intake, batch and receipt views show the original cost first and net cost as **After discount**. Batch search and sorting use the displayed costs. Finance Direct and RD values use before-discount costs, including the existing 6.70% RD margin rule and CSV calculation path.

`stock_lot_costs` stores a separate cost basis. Existing net lot costs, historical allocation costs, quantities, MRPs, purchases and bill records are preserved. Historical recovery checks the complete reviewed invoice, posted purchase and original lot order, quantity, MRP, product and net cost. Inconsistent evidence produces an unpriced basis rather than a guessed value. Manual stock costs remain their recorded values. The SQLite-to-Postgres migration includes the new table.

## Verification

- SQLite suite: 126 passed, one PostgreSQL-only session test skipped.
- Dedicated PostgreSQL 18 server with TLS verification: all 127 tests passed, including populated-store upgrade, repeat recovery, ambiguous evidence, discount rounding, full discounts, cost searches, stock acceptance/deletion and ledger-cost preservation.
- Cloud transaction pooler: all three cost-basis regression tests passed in disposable schemas after the connection guard fix. Fixture schemas were removed by the test helper.
- Production build and type check passed sequentially.
- Synthetic browser checks at 1280 x 720 and 390 x 844 covered draft cost preview, discount edits/save, batches, receipt detail and Finance valuation. Main preview cost stayed Rs 33.33 when an increased invoice discount changed the net preview from Rs 30.00 to Rs 26.67. Received stock remained six units; its Direct value was Rs 300.00 and RD value Rs 321.54. Browser console checks were clear. Narrow tables scrolled within their container without page overflow.
- Live historical cost recovery reconciled all targeted invoice lots. A private recovery snapshot was saved before the additive metadata update. Full before/after ledger and bill digests matched, and the update was idempotent. No business record, original net price or quantity was rewritten.

An isolated test exposed stale `search_path` on a pooled server session. The setting was reset. Schema selection now uses `SET LOCAL` inside pinned transactions, including individual database statements. The dedicated local PostgreSQL regression checks stale-session handling; that deliberately invasive session test is opt-in and must not run on a shared/live pooler. TLS certificate expiry on the old local fixture was resolved by issuing a fresh test certificate, retaining certificate verification.

Authenticated live UI verification requires a signed-in browser. Local rendered checks, live data reconciliation and deployment/domain verification are distinct evidence. Screenshots, synthetic runtime data and production recovery material remain outside tracked source. Task-created servers are stopped after verification.
