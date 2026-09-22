package com.focus.connector;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class PrinterProtocolTest {
    private static byte[] bytes(int... values) {
        byte[] result = new byte[values.length];
        for (int i=0;i<values.length;i++) result[i]=(byte)values[i];
        return result;
    }
    private static byte[] join(byte[]... chunks) throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        for(byte[] chunk:chunks)out.write(chunk);
        return out.toByteArray();
    }
    private static byte[] ascii(String value) {return value.getBytes(StandardCharsets.US_ASCII);}
    private static void verify(String name,byte[] input,byte[] expected) throws Exception {
        // Reproduce arbitrary RFCOMM fragmentation, including every possible two-read split.
        for(int split=0;split<=input.length;split++){
            PrinterProtocol parser=new PrinterProtocol();ByteArrayOutputStream out=new ByteArrayOutputStream();
            parser.receive(Arrays.copyOfRange(input,0,split),split,out,s->{});
            parser.receive(Arrays.copyOfRange(input,split,input.length),input.length-split,out,s->{});
            if(!Arrays.equals(out.toByteArray(),expected))throw new AssertionError(name+" split "+split+": "+Arrays.toString(out.toByteArray()));
        }
        PrinterProtocol parser=new PrinterProtocol();ByteArrayOutputStream out=new ByteArrayOutputStream();
        for(byte b:input)parser.receive(new byte[]{b},1,out,s->{});
        if(!Arrays.equals(out.toByteArray(),expected))throw new AssertionError(name+" single bytes");
    }
    public static void main(String[] args) throws Exception {
        byte[] model=bytes(29,73,67),expectedModel=ascii("_SPP-R310\0");
        verify("CBL claim and print completion",bytes(29,97,0,29,73,67,29,73,69,29,97,255,29,73,66),join(expectedModel,ascii("_PC437\0"),bytes(20,0,0,15),ascii("_BIXOLON\0")));
        verify("Real-time information",bytes(16,29,73,67),expectedModel);
        verify("Status",bytes(16,4,1,16,4,2,16,4,3,16,4,4,29,114,1),bytes(18,18,18,18,0));
        verify("IDs",bytes(29,73,1,29,73,2,29,73,3),bytes(65,0,105));
        verify("Text and diagnostic are silent",ascii("Serial No: 73224\nFOCUS-BRIDGE-TEST\n"),bytes());
        verify("Unknown queries are silent",bytes(29,73,127,16,4,9),bytes());
        verify("QR payload ignored",join(bytes(29,40,107,3,0),model,model),expectedModel);
        verify("Large graphics payload ignored",join(bytes(29,56,76,3,0,0,0),model,model),expectedModel);
        verify("Raster payload ignored",join(bytes(29,118,48,0,3,0,1,0),model,model),expectedModel);
        verify("Column image ignored",join(bytes(27,42,0,3,0),model,model),expectedModel);
        verify("Length barcode ignored",join(bytes(29,107,73,3),model,model),expectedModel);
        verify("Terminated barcode ignored",join(bytes(29,107,4),model,bytes(0),model),expectedModel);
        verify("Formatting parameter not interpreted",join(bytes(27,33,29),ascii("IC"),model),expectedModel);
        System.out.println("Printer protocol: 13 scenarios passed at every split and with one-byte reads.");
    }
}
