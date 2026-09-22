package com.focus.connector;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/** SPP-R310 replies required by CBL's Bixolon JavaPOS driver. Raw input is saved separately. */
public final class PrinterProtocol {
    public static final String NAME = "SPP-R310";
    private int prefix, command, count, needed;
    private final int[] parameters = new int[6];
    private long skip;
    private boolean terminatedBarcode;

    public void receive(byte[] data, int length, OutputStream output, Consumer<String> log) throws IOException {
        for (int i = 0; i < length; i++) accept(data[i] & 255, output, log);
    }

    private void accept(int b, OutputStream output, Consumer<String> log) throws IOException {
        if (barcodeLengthPending) { barcodeLengthPending = false; skip = b; return; }
        if (skip > 0) { skip--; return; }
        if (terminatedBarcode) { if (b == 0) terminatedBarcode = false; return; }
        if (needed > 0) {
            parameters[count++] = b;
            if (count == needed) {
                finish(output, log);
                prefix = command = count = needed = 0;
            }
            return;
        }
        if (prefix == 0) {
            if (b == 0x1d || b == 0x1b || b == 0x10) prefix = b;
            return;
        }
        command = b;
        if (prefix == 0x1d) {
            if (b == 0x28) needed = 3; // function, pL, pH, then opaque QR/graphics payload
            else if (b == 0x38) needed = 5; // function and four-byte payload length
            else if (b == 0x76) needed = 6; // raster: 0, mode, width, height
            else if (b == 0x6b) needed = 1; // barcode mode, then length or NUL-terminated data
            else if (b == 0x4c || b == 0x57 || b == 0x50 || b == 0x24 || b == 0x5c) needed = 2;
            else if (b == 0x49 || b == 0x61 || b == 0x72 || b == 0x21 || b == 0x42 || b == 0x48 || b == 0x66 || b == 0x68 || b == 0x77) needed = 1;
        } else if (prefix == 0x1b) {
            if (b == 0x2a) needed = 3; // column image: mode, width
            else if (b == 0x24 || b == 0x5c) needed = 2;
            else if (b == 0x57) needed = 6; // remaining two bytes skipped below
            else if (b == 0x21 || b == 0x2d || b == 0x33 || b == 0x45 || b == 0x47 || b == 0x4a || b == 0x4d || b == 0x52 || b == 0x54 || b == 0x61 || b == 0x64 || b == 0x74 || b == 0x7b || b == 0x20) needed = 1;
        } else if (prefix == 0x10 && b == 0x04) needed = 1;
        else if (prefix == 0x10 && b == 0x1d) { prefix = 0x1d; command = 0; return; }
        if (needed == 0) prefix = command = 0;
    }

    private void finish(OutputStream out, Consumer<String> log) throws IOException {
        int n = parameters[0];
        if (prefix == 0x1d && command == 0x49) {
            switch (n) {
                case 1: case 49: reply(out, new byte[]{0x41}); break;
                case 2: case 50: reply(out, new byte[]{0}); break;
                case 3: case 51: reply(out, new byte[]{0x69}); break;
                case 65: info(out, "FocusBridge"); break;
                case 66: info(out, "BIXOLON"); log.accept("Print completion acknowledged"); break;
                case 67: info(out, NAME); log.accept("Printer model confirmed"); break;
                case 69: info(out, "PC437"); log.accept("Character set confirmed"); break;
                default: log.accept("Printer query: " + n);
            }
        } else if (prefix == 0x1d && command == 0x61 && n != 0) {
            reply(out, new byte[]{0x14, 0, 0, 0x0f});
            log.accept("Printer ready");
        } else if (prefix == 0x10 && command == 0x04 && n >= 1 && n <= 4) {
            reply(out, new byte[]{0x12});
        } else if (prefix == 0x1d && command == 0x72 && (n == 1 || n == 49)) {
            reply(out, new byte[]{0});
        } else if (prefix == 0x1d && command == 0x28) {
            skip = parameters[1] + 256L * parameters[2];
        } else if (prefix == 0x1d && command == 0x38) {
            skip = parameters[1] + 256L * parameters[2] + 65536L * parameters[3] + 16777216L * parameters[4];
        } else if (prefix == 0x1d && command == 0x76) {
            skip = (parameters[2] + 256L * parameters[3]) * (parameters[4] + 256L * parameters[5]);
        } else if (prefix == 0x1b && command == 0x2a) {
            skip = (parameters[1] + 256L * parameters[2]) * (n >= 32 ? 3 : 1);
        } else if (prefix == 0x1b && command == 0x57) {
            skip = 2;
        } else if (prefix == 0x1d && command == 0x6b) {
            if (n <= 6) terminatedBarcode = true;
            else { prefix = 0; command = 0; barcodeLengthPending = true; }
        }
    }

    private boolean barcodeLengthPending;

    private static void info(OutputStream out, String value) throws IOException {
        reply(out, ("_" + value + "\0").getBytes(StandardCharsets.US_ASCII));
    }

    private static void reply(OutputStream out, byte[] bytes) throws IOException {
        out.write(bytes);
        out.flush();
    }
}
