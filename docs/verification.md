# Verification, 2026-09-22

## Functional evidence

- `bun run build`: TypeScript and Vite production build passed.
- `bun test`: 11 tests, 26 assertions passed. Covers acceptance exactly once, duplicate bytes, all-or-nothing stock deductions, repeated product lines, rejection, immutable closed bills, original binary preservation, decimal quantities, duplicate bill numbers, archived products, adjustments, and metadata edits that cannot overwrite stock.
- HTTP checks against an isolated test database: stock access and ingest authentication, cross-origin write rejection, successful upload, duplicate upload returning the original ID, exact original download, and prevention of unreviewed acceptance all passed.
- Codex in-app browser: created a stock item with 10 units, opened a received test print, mapped 3 units, accepted it, and verified 7 remaining. Mobile review showed the accepted bill's fields disabled.
- Browser console: no errors recorded during the verified path.
- Responsive checks: 1536x1024 desktop and 390x844 mobile. Mobile document width remained 390px with no page overflow.
- Android `assembleDebug lintDebug`: passed. Advisory SDK/internationalization warnings remain. Target and compile SDK deliberately remain 36 for this initial build.
- APK signature verified with Android apksigner. The signed debug APK is downloadable over the current Wi-Fi server URL.
- No synthetic stock or bills were inserted into the user's primary workspace. Browser testing used a separate port and temporary database.

## Visual review

Reference: `design-concept.png`, generated using the built-in image tool. Render: `web-desktop.png`, captured with the in-app browser. Both were inspected with `view_image` in the final review. Mobile evidence: `web-mobile.png`.

The implementation was checked for fidelity against the working concept, not against a user-approved design. The following points were inspected:

| Point | Reference | Implementation/result |
| --- | --- | --- |
| Layout | Left rail, header, tabs, two-pane inbox | Preserved; 240px rail and 33% inbox list |
| Palette | White canvas, cool gray rail, teal action | Shared CSS tokens; no warm background or decorative gradients |
| Type | Large Bills heading, smaller muted helper copy | 38-42px desktop heading and deliberate component type sizes |
| Copy | Bills, Stock, Connection, Import file, empty states | Primary visible copy preserved; no extra marketing copy |
| Containers | Thin rules, one outlined inbox, modest corners | Preserved; no dashboard card grid |
| Icons | Outline stock/link/document symbols | Lucide outline family with consistent sizing |
| Mobile | Required usable small-screen continuation | Horizontal navigation and list/detail switch, no page overflow |

Above-the-fold copy diff: no unplanned additions. Intentional functional extensions: real sign-out control in place of the concept's workspace chevron; populated bill editing/acceptance, inventory CRUD, connection setup and password screens. The F brand tile uses solid color rather than the raster concept's slight shading. Exact pixel identity is not claimed; the structure, palette, wording, density, and component treatments are faithfully implemented.

An IAB full-page screenshot initially included unused canvas because of the browser's retina capture behavior. Final evidence uses the viewport screenshot method. No external Playwright browser fallback was needed.

## Still unverified

- Runtime behavior of the latest APK on the user's second Android device (v0.2.1 diagnostic delivery is confirmed below).
- CBL Focus connecting to the advertised SPP service.
- Complete receipt payload, encoding, framing, printer-specific commands, or image content.
- Automatic parsing of bill fields and products.
- Internet/cloud deployment, production operations, and backups.

A successful build is not a successful physical Bluetooth test. The next evidence is the receiver byte count and a saved real bill.

## First physical test and v0.2 response

The user paired an Android 9 CBL tablet with an Android 16 phone. CBL listed the phone and showed a success checkmark after choosing 3 Inches, but the receiver remained Waiting for CBL tablet, with 0 bytes and 0 queued. No accepted RFCOMM socket was observed. This is not a successful print test. Version 0.2 adds a paired-device compatibility listener, distinct upload status, connection and lifetime byte counters, an event log, and a direct Bluetooth diagnostic sender. Both APK build and lint passed. Physical retest is pending.

## Diagnostic test correction, v0.2.1

The user clarified that the connection at 22:05:34 was created by Focus Bridge's diagnostic sender on the tablet, not CBL Focus. The receiver accepted the tablet connection and saw EOF in the same second, with no data. The old sender immediately closed its socket after writing and reported success without delivery confirmation. That behavior is a weakness in the test; it is not yet proven to be the cause of the missing data.

Version 0.2.1 keeps the sender socket open until the receiver replies with an exact acknowledgment or the existing 15-second deadline closes the socket. The receiver recognizes the diagnostic marker across fragmented reads and acknowledges it once. Diagnostic captures are excluded from the bill inbox. Both devices need v0.2.1 for this acknowledgment test.

The pure-Java protocol check exercises every split boundary, byte-at-a-time reads, mismatched and oversized inputs, and exact acknowledgment recognition. Run `./scripts/test-bridge-protocol.sh`. Physical delivery and CBL compatibility remain pending.

## Confirmed diagnostic delivery; CBL still does not connect

The user's v0.2.1 receiver screenshot shows a tablet connection, 18 received bytes, and Bluetooth test acknowledged / received successfully. A later CBL print attempt did not increment connections or bytes. Standard SPP diagnostic delivery is proven on these devices. CBL Focus's print action has still not been observed opening the receiver's SPP socket. Its selected UUID, driver conditions, or channel remain unknown.

Version 0.2.2 adds an Export CBL app button for the tablet. The user explicitly selects the app and a ZIP destination using the Android document picker. Only ApplicationInfo.sourceDir and splitSourceDirs are copied, along with package/version metadata. The export code does not access dataDir, app databases, runtime preferences, or credentials. No network upload is performed by the export screen. Physical export and analysis of the resulting package remain pending.

## Direct local transfer, v0.3

At the user's request, the tablet can now send the installed CBL package directly to a receiver on the Mac. No manual ZIP save/attachment or connector-key entry is required for this diagnostic transfer. The installer is configured for the local receiver with a separate expiring, upload-only capability. The receiver stores files outside the public web root and accepts one distinct package. Original payload hashes are checked in an isolated test.

Checks passed: invalid credentials rejected, invalid archives rejected, supported app ZIP accepted, saved bytes match the original SHA-256, identical retry acknowledged, second distinct package rejected, received files not publicly served, TypeScript/Vite build, Android build/lint/signature verification. The network upload has not been verified from the user's tablet until its actual package arrives.

## Package received; printer profile v0.4

The tablet successfully uploaded CBL FOCUS V2 version 4.0, package cbl.cblfocusv2, to the temporary local receiver. The original ZIP and inspection output remain in ignored, private application storage. No CBL app modification was made.

Inspection of PrintHelper established that its picker lists all bonded devices, but printing returns early unless BluetoothDevice.getName() contains the case-sensitive WOOSIM or SPP-R substring. A null return still triggers the success animation. The 3 Inches control is a slide-to-complete control. The SPP-R path uses Bixolon JavaPOS and the standard SPP UUID. Its claim step requests model (GS I 67) and code page (GS I 69), requiring underscore-prefixed, NUL-terminated responses. GS I 66 is used for output completion.

The user tried renaming the phone and reported no new connection. Therefore the name filter is a confirmed code condition, but renaming is not yet a verified fix on the physical device.

Version 0.4 adds a button to set and verify the phone's advertised name to exactly SPP-R310, logs its local name when listening, and answers the driver queries with a limited SPP-R310 profile. Ready-status bytes follow the [Bixolon SPP-R310 command manual](https://bixolon.com/_upload/manual/Manual_SPP-R310_Command_english_Rev_1_00.pdf), pages 137-138 and 149-150. Original incoming bytes are still stored unchanged. Length-framed QR, graphics, raster, and barcode payloads are skipped by the reply recognizer so query-like bytes in those payloads do not trigger replies. This is not a full printer interpreter.

Checks passed: diagnostic protocol regressions; 13 printer protocol scenarios at every two-read split and byte-at-a-time; Android assembleDebug and lintDebug; APK signature verification; TypeScript/Vite build; downloaded installer hash matches the built v0.4 artifact and its manifest reports versionCode 6/versionName 0.4.0. The Mac's Wi-Fi IP changed from 10.122.77.123 to 10.122.77.231 during this work, so the receiver's upload address must change too. Physical v0.4 CBL delivery remains pending. A full bill capture is still required before automatic field extraction can be verified.

## First CBL capture confirmed

The user's 22:45 screenshot confirms v0.4 accepted a Galaxy Tab A connection, answered model and character-set queries, reported printer ready and print completion, and saved 1,575 bytes after disconnect. One capture remains queued. This proves the CBL Bluetooth path reached the receiver; the payload has not yet been inspected for invoice completeness.

Upload reached http://10.122.77.231:4310 but returned 401. The ingest route rejects an incorrect connector key before storing data. The actual port-4310 workspace still shows the initial Create workspace screen. The next step is to complete workspace setup on the Mac, copy its connector key to the phone, tap Start receiver to save the changed settings, and retry the retained upload. Do not clear the phone's app data or repeat the print to resolve authentication.
