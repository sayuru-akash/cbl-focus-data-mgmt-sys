# Stock-in review verification

Verified on 21 October 2026.

## Change

Invoice totals are assembled field by field in printed page order, retaining photo-to-row links even when uploads are out of order. A final page with invoice identity, page numbering and a final total can be valid without an order value printed on that same page. Missing order value is not inferred from the final total; invoice validation still requires complete reconciled totals before receipt.

Printed partial boxes on DZ lines are allowed only with explicit carton packaging that reconciles exactly to a whole-packet quantity. MC and individual-unit sold quantities remain whole numbers. The Boxes field is a decimal text field without stock steppers. Unsupported fractions and inconsistent quantities remain blocked on save and receipt.

The reader prompt explicitly preserves fractional box evidence and distinguishes fields absent from a page. Provider models, fallback classification, credentials and stored original OCR evidence are unchanged.

## Evidence

- All 120 tests passed, with 1,356 assertions. Typecheck and production build passed.
- All 22 intake tests passed against an isolated local PostgreSQL 18 server using disposable schemas. The server was stopped afterward. Direct TCP access to the hosted database was unavailable from this workstation; focused production inspection and the authorized correction used its HTTPS SQL interface.
- New regressions cover shuffled uploads with gross on the preceding page, discount/final amount on the last page, cache reuse, absent totals-only gross, partial cartons, invalid fractional evidence, save rollback, whole-stock receipt and repeated receipt idempotency.
- Both provider response validators preserve a totals-only page with null gross and a visible final amount. Missing invoice identity, missing final total and invalid page numbering remain rejected.
- Isolated browser review verified 1.75 boxes converts to 252 packets, 1.74 is rejected, correction saves, and 1.75 persists after reload. Desktop and 390 x 844 mobile layouts had no relevant console errors or page overflow.
- The operator's current five-photo draft was compared visually with all original images. Verified OCR corrections and explicit product links were saved with revision checks and private before/after evidence under ignored operations storage. Item amounts reconcile exactly to the printed order value, and discount reconciles to the printed final amount. Original photos/OCR were preserved. MRPs were not invented, and no stock was received.

No dependency, schema or environment changes were required. Deployment and authenticated live review are verified separately.
