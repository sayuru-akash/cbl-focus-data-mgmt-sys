# Interface direction

Working concept: `design-concept.png`, generated with the built-in image tool. This is the implementation reference, not a user-approved mockup.

Prompt: Complete desktop distributor bill intake and inventory screen; white background, cool gray 240px rail, teal #137b66 primary actions, ink text, thin rules, system sans typography. Navigation: Bills, Stock, Connection. Main title Bills with Review incoming bills. Import file action. Pending, Accepted, Rejected tabs. Two-pane bill inbox and review surface. Empty states: No bills yet / Print a bill to get started; Select a bill / Review items before accepting. Footer: Stock changes only after acceptance. No business seed records, charts, marketing, or decorative media.

## Tokens and components

- White canvas, #f3f6f8 navigation rail, #122131 text, #748296 muted text, #dce3eb border, #137b66 action color.
- System sans text. Desktop heading 38-42px, navigation 17-18px, controls 14-16px, utility labels 11-13px.
- 240px rail, 32px main gutters, 33% inbox list, 6px component corners. Modal 12px corners.
- Lucide outline icons; thin document outlines for empty states. Native inputs, selectors, tables, dialogs.
- F mark implemented as live text on a solid teal tile. No raster illustration assets are needed in the product.
- Small opacity/position transition for dialogs, disabled under reduced-motion preference.

## Workflow inventory

Bills: import, filter, search, inspect original, enter bill fields, map items, save draft, accept, reject.
Stock: search, add, edit, adjust, audit history, delete with confirmation.
Connection: local address, masked key, copy controls, APK download and short pairing steps.
Login: first local password setup and subsequent sign-in.

Mobile: compact horizontal navigation; inbox switches between list and selected detail. Stock table scrolls within its own container. The separate empty review pane is hidden until a bill is selected.
