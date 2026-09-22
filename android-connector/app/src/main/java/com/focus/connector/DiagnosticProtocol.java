package com.focus.connector;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Small, deterministic delivery check used only by Focus Bridge's test button. */
public final class DiagnosticProtocol {
    public static final byte[] REQUEST = "FOCUS-BRIDGE-TEST\n".getBytes(StandardCharsets.US_ASCII);
    public static final byte[] ACK = "FOCUS-BRIDGE-ACK\n".getBytes(StandardCharsets.US_ASCII);
    private int matched;
    private boolean finished;

    /** Recognizes a whole test request across arbitrary Bluetooth read boundaries, once. */
    public boolean receive(byte[] bytes, int count) {
        if (finished) return false;
        if (count < 0 || count > bytes.length || matched + count > REQUEST.length) {
            finished = true;
            return false;
        }
        for (int i = 0; i < count; i++) {
            if (bytes[i] != REQUEST[matched++]) {
                finished = true;
                return false;
            }
        }
        if (matched == REQUEST.length) {
            finished = true;
            return true;
        }
        return false;
    }

    public static boolean isRequest(byte[] bytes) { return Arrays.equals(bytes, REQUEST); }
    public static boolean isAcknowledgment(byte[] bytes) { return Arrays.equals(bytes, ACK); }
}
