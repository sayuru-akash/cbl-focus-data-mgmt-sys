# Focus

A local-first distributor workspace with a Bluetooth print bridge. The first milestone is capturing a real CBL Focus bill without changing the original tablet app.

## Run

```sh
cd web-app
bun install
bun run build
bun run start
```

Open http://localhost:4310 on the server computer and create the workspace password. The initial password can only be set from loopback. Then open **Connection** for the Wi-Fi address and ingest-only connector key.

## First device test

1. Keep the Mac and second Android device on the same trusted Wi-Fi.
2. Download `/downloads/focus-bridge.apk` from the web app's address. Install it on the **second device**, not the CBL tablet. Android 9 or newer is required.
3. Enter the server address and connector key from **Connection**.
4. Tap **Start receiver**. Allow Bluetooth access. If a permission or Bluetooth enable prompt appears, tap **Start receiver** again afterward.
5. Tap **Use printer name SPP-R310** on the receiver phone. Pair it from the tablet's Bluetooth settings, removing the old phone pairing first if its name was cached. Reopen CBL's printer picker and slide **3 Inches** fully right on the phone's SPP-R310 entry. Turn off the physical printer during this test to avoid choosing it by mistake.
6. Print just one bill. Wait until the receiver's byte count stops increasing, then tap **Save bill**. A disconnected stream is also saved automatically.
7. The original appears under **Bills**. Review its contents before mapping inventory items and accepting it.

The photo supplied by the user shows SPP-R310 with a Bluetooth MAC address and 3/4-inch print options. The user confirmed other paired phones appear in the same picker. This supports testing a standard Bluetooth Serial Port Profile receiver. It does **not** prove the app's printer SDK will accept the bridge; that needs the physical-device test.

The APK listens on the standard SPP UUID `00001101-0000-1000-8000-00805f9b34fb`. Its compatibility listener accepts only paired devices and retains a secure-listener option. Version 0.4 provides the SPP-R310 model, PC437 character set, manufacturer/completion, and ready-status replies required by the inspected Bixolon driver. The phone's advertised name can be set with one button; its Bluetooth hardware address is unchanged. This is a limited virtual printer profile, with physical CBL print delivery still awaiting verification.

### Capture boundaries

Manual **Save bill** is intentional for the first test. A byte-stream connection can contain multiple prints, status requests, or image commands. Until real captures establish job boundaries, print and save one bill at a time. Do not assume an inactivity timeout reliably marks the end of a bill. Captures are queued in app-private storage and retried while the receiver service is running. Restart the receiver to resume queued uploads after a device restart. Interrupted captures are marked in their filenames. The current per-file limit is 10 MB.

## Bluetooth troubleshooting

The first user test on an Android 9 CBL tablet and Android 16 receiver phone showed the phone in the CBL printer picker, but the receiver stayed at Waiting for CBL tablet with 0 bytes. CBL showed a checkmark. This proves pairing/listing, not an SPP connection or print delivery.

Version 0.2 adds connection counters and a short event log. Version 0.2.1 fixes the diagnostic sender to wait for a receiver acknowledgment before reporting success; update both devices for that test. Start the phone receiver with Compatibility mode on and retry once. If it still waits, install the same APK on the CBL tablet, leave upload fields blank, and use Test Bluetooth to another device. Choose the receiver phone while its receiver remains running. This sends a fixed diagnostic marker; the bridge discards that marker rather than creating a bill. If this test succeeds but CBL does not, investigate CBL's SDK/channel/UUID with actual evidence instead of assuming ordinary SPP behavior.

The test workspace uses port 4311. Real user setup is port 4310. Keys are different.

## Inspecting the CBL printer implementation

If the direct Bluetooth test passes but CBL printing does not open a receiver connection, install the prepared bridge v0.3 on the tablet. Tap Send CBL app to Mac and select CBL Focus. The installed APK code, split APKs, and package metadata are uploaded directly to the Mac. No private app data is read.

The temporary receiver runs with `bun web-app/server/package-receiver.ts` on port 4312. Its session is stored in the ignored `web-app/data/package-transfer` folder. It accepts one package up to 256 MB, validates the container without extracting or executing it, preserves the original bytes, and acknowledges identical retries. The upload-only transfer capability expires after two hours and cannot read business records. `android-connector/local-transfer.properties` supplies the current local URL and scoped capability for this private installer; it is excluded from Git. The app caches an unsuccessful transfer so retry sends the same bytes.

Use `bun scripts/test-package-receiver.ts` to check the receiver in isolation. Do not distribute a transfer-enabled diagnostic installer outside the intended local test devices.

## Implemented

- Authenticated bill inbox with original downloads and readable text previews.
- PDF import and preview, plus arbitrary raw printer capture storage.
- Manual bill number, shop, SKU mapping, quantities, and note.
- Accept/reject, immutable closed bills, exact-byte upload deduplication, unique active bill numbers.
- Atomic stock deductions on acceptance, including combined repeated product lines.
- Item creation, viewing, editing, soft deletion, adjustments, and movement history.
- Integer thousandths for quantities, avoiding floating-point inventory drift.
- Password hashing, expiring HTTP-only sessions, ingest-only token, same-origin browser mutation checks.
- Local persistence in `web-app/data/focus.sqlite`, with SQLite WAL enabled.
- Responsive React interface, with no seeded business data.

## Pending real data

No real CBL print stream has been verified yet. Automatic extraction of products, prices, discounts, returns, free issues, units, totals, shop details, and invoice identifiers is deliberately not guessed. Raw graphics may require decoding or OCR. A saved capture is the next input for that work. Similar reprints whose bytes differ are additionally caught by bill number during review.

The application currently runs locally. It is not deployed to a cloud provider. Before internet deployment, choose the hosting/account context, configure HTTPS and `SECURE_COOKIES=1`, protect setup behind loopback, provide a persistent volume, and configure database backups. This is currently one shared workspace, not a multi-tenant or role-based system. The unauthenticated APK route serves only the installer; business data requires authentication. Local HTTP is intended only for the requested trusted-Wi-Fi test.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | HTTP port |
| `HOST` | `0.0.0.0` | Bind interface |
| `DATA_DIR` | `web-app/data` | Persistent SQLite directory |
| `SECURE_COOKIES` | unset | Set `1` when served through HTTPS |

For development, run `bun run dev` and `bun run ui` in separate terminals in `web-app`. Vite proxies API calls to port 4310.

## Android build

Use JDK 17+ and Android SDK 36. The current APK is debug-signed for this private device test.

```sh
cd android-connector
./gradlew assembleDebug lintDebug
```

Run `./scripts/package-bridge.sh` at the repository root to copy the built APK into the web app's download folder. Build the web app again to include it in `dist`. APKs, database files, and build output are excluded from Git.

## Verification

```sh
cd web-app
bun test
bun run build
```

See [verification](docs/verification.md) for the browser checks, visual comparison, Android checks, and unresolved hardware test.

Protocol references: [Android Bluetooth connection model](https://developer.android.com/develop/connectivity/bluetooth/connect-bluetooth-devices), [Android print services](https://developer.android.com/reference/android/printservice/PrintService).
