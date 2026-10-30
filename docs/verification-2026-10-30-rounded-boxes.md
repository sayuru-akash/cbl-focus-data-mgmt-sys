# Supplier rounded box evidence

Verified on 30 October 2026.

Supplier documents can print partial cartons to two decimal places, such as 0.67 for four dozen out of a six-dozen carton. Review now accepts that evidence only when the explicit carton size and exact sold DZ quantity produce the same rounded box count. Packet quantities still come from sold quantity multiplied by 12. Fractional stock, unsupported carton fractions, missing pack evidence and inconsistent counts remain blocked.

The pack reader also recognises explicit `100G.NETX12DZ` packaging. It does not infer a retail MRP or substitute purchase cost for MRP.

## Checks

- All 121 tests passed, with 1,375 assertions. Typecheck and production build passed.
- The intake regression covers 0.67, 0.33, 0.17 and 0.08, exact thirds/sixths/twelfths, invalid adjacent rounding, excessive decimal precision, missing packaging and MC/individual-unit restrictions. Saved source values survive reload; receiving uses whole packets and remains idempotent.
- All three supplied invoices were visually transcribed and reconciled privately against the original images. The isolated full-photo preparation run preserved all pages, repeated rows and source prices, allocated discounts exactly, left MRPs empty, and verified unchanged products, lots, purchases, movements and stock. Re-uploading each photo set returned its existing draft.
- Original business images, transcription plans and operation evidence remain in ignored private operations storage. They are not public fixtures.

Live draft creation, deployment verification and PostgreSQL results are recorded separately from this local implementation evidence. No schema, environment, provider model or dependency changes were needed.
