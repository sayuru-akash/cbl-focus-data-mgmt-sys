# Workflow verification, 28 September 2026

Scope: completion feedback, strict MRP auto-selection and operator documentation.

## Changed

- Bill acceptance and rejection close the desktop review or return the full-page review to its validated list URL. Filters remain in that URL. Successful mutations show a dismissible confirmation for six seconds.
- Saving keeps drafts open. Failed acceptance remains in review. Successful decisions do not depend on another GET request succeeding afterward.
- Stock receipt returns to Stock in. Nested receipt returns to its sales bill, refreshes stock and only refreshes automatic mappings when no unsaved bill edits would be lost. Nested photo processing no longer navigates to a different page.
- Bill/draft deletion, item editing, stock corrections and archiving have completion messages. Drawer focus returns to its opener, or the list heading when that row has disappeared.
- Automatic sales mapping requires one product identity, the same unit and positive remaining stock at the printed MRP. Unknown MRP, different MRP, exhausted stock and ambiguous identities do not select a product.
- Mapping provenance distinguishes automatic selections from explicit manual choices, including clearing a selection. Untouched legacy drafts are rechecked; reviewed legacy choices are preserved. Editing an automatic line's name, unit or MRP clears its selection.
- README reorganized around daily operation, inventory rules, configuration, recovery, Bluetooth and release procedures.

## Automated checks

- `bun test`: 97 passed, 1,046 assertions.
- `bun run typecheck`: passed.
- `bun run build`: passed.
- `FOCUS_TEST_POSTGRES=1 bun test --timeout 60000 server/bill-auto-match.test.ts`: 3 passed, 22 assertions in disposable schemas.
- `git diff --check`: passed.

The regression cases cover identity ambiguity, variants, units, remembered aliases, differing/unknown MRPs, exhausted batches, automatic versus manual persistence, and restore-print behavior. Existing tests also cover payment requirements, receipt editing, stock allocation, returns, deletion, supplier intake and finance.

## Browser and ledger checks

Used an isolated SQLite workspace with synthetic bills, one item and a reviewed supplier draft. No production bill approvals or stock receipts were performed.

- Desktop: MRP-20 stock selected for an MRP-20 bill; accepting closed the drawer and removed the row from Pending. The success notification was visible.
- Different MRP: an MRP-25 line remained unselected and acceptance opened Review needed without moving stock.
- Supplier receipt: posting three packets at MRP 25 returned to Stock in and showed the received invoice.
- Mobile at 390px: a draft opened as a full page; Save stayed in review; acceptance returned to Bills with confirmation.
- After receipt, reopening the MRP-25 bill automatically found the new matching batch. Rejecting closed the drawer, left the empty inbox visible and focused its heading.
- Ledger: opening 10, two sales of 2 each, receipt of 3, closing 9. Remaining batches: 6 at MRP 20 and 3 at MRP 25. Receipt linked to exactly one purchase.
- No browser warning/error logs during these checks.

The nested photo-upload completion branch and extra completion messages were reviewed in source; this run did not repeat cloud OCR, physical camera or prolonged Android Bluetooth tests. Production confirmation is read-only after deployment; local mutations are the evidence for completion behavior.
