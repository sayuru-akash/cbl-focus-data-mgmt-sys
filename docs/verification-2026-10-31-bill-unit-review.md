# Bill stock-picker unit review

Verified 31 October 2026.

## Problem and change

A sales print can label an individual item BTL while a supplier receipt records the same physical item as PKT. Strict unit filtering hid that stock from manual search.

Bill pickers now offer individual-item stock units (PKT, BTL, BOX, UNIT and UNITS) for deliberate review. Results show total stock, stock at the bill MRP and a short unit warning. Choosing an incompatible label opens a quantity/unit confirmation. Confirming updates the reviewed receipt unit and manual product choice, preserving quantity, MRP and monetary values. Cancel or Escape leaves the line unchanged and returns focus to its picker.

Automatic identity matching, acceptance unit checks and MRP allocation are unchanged. DZ, MC, weights and unknown labels do not use this shortcut. Supplier intake remains packet-specific. No live bill or inventory record was edited during verification.

## Evidence

- `bun test`: 122 passed, 0 failed.
- `bun run build`: passed.
- `bun run typecheck`: passed after build. An earlier concurrent run overlapped generated Next type regeneration; the sequential run passed.
- Disposable PostgreSQL schemas: all 9 tests in `server/bill-edit.test.ts` and `server/sales-units.test.ts` passed. Fixture schemas were removed by the existing test helper.
- HTTP regression: explicit units remain filtered by default; manual unit review exposes packet stock to a bottle-labelled search, retaining zero matching stock for an unavailable MRP. DZ and MC remain excluded.
- Synthetic browser workflow at `127.0.0.1:4350`, 1280 x 720 and 390 x 844: search, alternate-unit warning, confirmation, cancel, Escape, focus restoration, save/reload and MRP shortage recovery passed. Successful acceptance returned to the list.
- The synthetic ledger deducted exactly 48 of 96 packet units once. The original capture still said BTL; the reviewed receipt said PKT. Wrong-MRP stock and the empty bottle product were unchanged. Automated tests also covered idempotent acceptance and deletion reversal.
- Browser console: no application errors or warnings in the tested flow. Screenshots and the temporary fixture database remain outside tracked source. Task-started servers were stopped.

Live data was inspected read-only to identify the mismatch. The authenticated live browser session requires sign-in; local rendered checks and PostgreSQL tests do not substitute for that check. Deployment readiness and domain alias are verified separately during release.
