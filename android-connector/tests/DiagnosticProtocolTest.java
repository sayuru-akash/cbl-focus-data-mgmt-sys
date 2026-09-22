package com.focus.connector;

import java.util.Arrays;

public final class DiagnosticProtocolTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        byte[] request=DiagnosticProtocol.REQUEST;
        DiagnosticProtocol whole=new DiagnosticProtocol();
        check(whole.receive(request,request.length),"Whole request recognized");
        check(!whole.receive(request,request.length),"Acknowledge only once");
        for(int split=1;split<request.length;split++) {
            DiagnosticProtocol fragmented=new DiagnosticProtocol();
            check(!fragmented.receive(Arrays.copyOfRange(request,0,split),split),"Partial request does not acknowledge");
            check(fragmented.receive(Arrays.copyOfRange(request,split,request.length),request.length-split),"Fragmented request recognizes final byte");
        }
        DiagnosticProtocol single=new DiagnosticProtocol();
        for(int i=0;i<request.length;i++)check(single.receive(new byte[]{request[i]},1)==(i==request.length-1),"One-byte reads");
        byte[] changed=request.clone();changed[4]=0;
        check(!new DiagnosticProtocol().receive(changed,changed.length),"Mismatched data is not a test");
        byte[] extra=Arrays.copyOf(request,request.length+1);
        check(!new DiagnosticProtocol().receive(extra,extra.length),"Extra data is not discarded as a test");
        check(!DiagnosticProtocol.isRequest(extra),"Only exact diagnostic captures are discarded");
        check(DiagnosticProtocol.isRequest(request),"Recognize saved test capture");
        check(DiagnosticProtocol.isAcknowledgment(DiagnosticProtocol.ACK),"Recognize receiver acknowledgment");
        check(!DiagnosticProtocol.isAcknowledgment(request),"Request is not an acknowledgment");
        System.out.println("Diagnostic protocol tests passed (all split boundaries, one-byte reads, mismatches, acknowledgment).");
    }
}
