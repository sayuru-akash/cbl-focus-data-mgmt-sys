package com.focus.connector;

import android.app.*;
import android.bluetooth.*;
import android.content.*;
import android.os.IBinder;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;

public class BridgeService extends Service {
 public static volatile String status="Stopped",uploadStatus="";
 public static volatile long received=0,totalReceived=0,connections=0;
 public static volatile BridgeService active;
 private static final Deque<String> events=new ArrayDeque<>();
 private volatile boolean running;
 private BluetoothServerSocket server;private BluetoothSocket client;
 private final Object captureLock=new Object();private File current;private FileOutputStream capture;
 private final ScheduledExecutorService uploader=Executors.newSingleThreadScheduledExecutor();
 private static final UUID SPP=UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
 static synchronized void log(String message){events.addLast(new SimpleDateFormat("HH:mm:ss",Locale.US).format(new Date())+"  "+message);while(events.size()>10)events.removeFirst();}
 public static synchronized String diagnostics(){return String.join("\n",events);}
 public static int pendingCount(File dir){File[] files=dir.listFiles((d,n)->n.endsWith(".bin"));return files==null?0:files.length;}
 @Override public IBinder onBind(Intent intent){return null;}
 @Override public void onCreate(){super.onCreate();active=this;received=0;
  NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel("bridge","Print receiver",NotificationManager.IMPORTANCE_LOW));Intent open=new Intent(this,MainActivity.class);PendingIntent pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_IMMUTABLE);
  startForeground(1,new Notification.Builder(this,"bridge").setContentTitle("Focus Bridge").setContentText("Bluetooth print receiver is running").setSmallIcon(android.R.drawable.stat_sys_upload).setContentIntent(pending).setOngoing(true).build());
  File[] partial=getFilesDir().listFiles((d,n)->n.endsWith(".partial"));if(partial!=null)for(File file:partial){if(file.length()>0){if(file.renameTo(new File(getFilesDir(),file.getName().replace(".partial","-interrupted.bin"))))log("Recovered interrupted capture");}else file.delete();}
  uploader.scheduleWithFixedDelay(this::uploadQueue,2,20,TimeUnit.SECONDS);
 }
 @Override public int onStartCommand(Intent intent,int flags,int id){if(!running){running=true;new Thread(this::listen,"focus-bluetooth").start();}return START_NOT_STICKY;}
 @SuppressWarnings("MissingPermission") private void listen(){try{
  BluetoothAdapter adapter=getSystemService(BluetoothManager.class).getAdapter();boolean compatibility=getSharedPreferences("bridge",MODE_PRIVATE).getBoolean("compatibility",true);
  server=compatibility?adapter.listenUsingInsecureRfcommWithServiceRecord("Focus Bridge",SPP):adapter.listenUsingRfcommWithServiceRecord("Focus Bridge",SPP);
  log("Name: "+adapter.getName());log("Listening: "+(compatibility?"compatibility SPP":"secure SPP"));status="Waiting for CBL tablet";
  while(running){client=server.accept();
   if(client.getRemoteDevice().getBondState()!=BluetoothDevice.BOND_BONDED){log("Rejected unpaired device");client.close();client=null;continue;}
   connections++;String name=client.getRemoteDevice().getName();status="Connected: "+name;log("Connected: "+name);
   InputStream input=client.getInputStream();OutputStream output=client.getOutputStream();byte[] buffer=new byte[4096];boolean first=true;DiagnosticProtocol diagnostic=new DiagnosticProtocol();PrinterProtocol printer=new PrinterProtocol();
   try{int count;while(running&&(count=input.read(buffer))!=-1){
    synchronized(captureLock){if(capture==null){current=new File(getFilesDir(),"bill-"+UUID.randomUUID()+".partial");capture=new FileOutputStream(current);received=0;}
     if(received+count>10*1024*1024){log("10 MB limit reached; incomplete capture");break;}
     capture.write(buffer,0,count);capture.flush();received+=count;totalReceived+=count;
    }
    if(first){log("First data: "+count+" bytes");first=false;}
    if(diagnostic.receive(buffer,count)){output.write(DiagnosticProtocol.ACK);output.flush();log("Bluetooth test acknowledged");}
    printer.receive(buffer,count,output,BridgeService::log);
    status="Receiving · tap Save bill after printing";
   }}catch(IOException e){if(running)log("Connection ended: "+e.getMessage());}
   finally{saveCapture();try{client.close();}catch(Exception ignored){}client=null;log("Disconnected");}
   if(running)status="Waiting for CBL tablet";
  }
 }catch(Exception e){status="Bluetooth: "+e.getMessage();log(status);running=false;try{if(server!=null)server.close();}catch(Exception ignored){}}
 }
 public void saveCapture(){synchronized(captureLock){if(capture==null||received==0)return;try{
  capture.getFD().sync();capture.close();capture=null;
  if(current.length()==DiagnosticProtocol.REQUEST.length&&DiagnosticProtocol.isRequest(Files.readAllBytes(current.toPath()))){current.delete();current=null;received=0;log("Bluetooth test received successfully");return;}
  long bytes=received;File ready=new File(getFilesDir(),current.getName().replace(".partial",".bin"));if(!current.renameTo(ready))throw new IOException("Could not queue capture");current=null;received=0;log("Saved "+bytes+" bytes");uploadStatus="Bill saved. Uploading…";retryUploads();
 }catch(Exception e){uploadStatus="Save failed: "+e.getMessage();log(uploadStatus);}}}
 public void retryUploads(){if(!uploader.isShutdown())uploader.execute(this::uploadQueue);}
 private void uploadQueue(){SharedPreferences prefs=getSharedPreferences("bridge",MODE_PRIVATE);String base=prefs.getString("url","");if(base.isEmpty()){uploadStatus="Uploads not configured";return;}
  File[] jobs=getFilesDir().listFiles((d,n)->n.endsWith(".bin"));if(jobs==null)return;
  for(File job:jobs){HttpURLConnection conn=null;try{
   conn=(HttpURLConnection)new URL(base+"/api/ingest").openConnection();conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(10000);conn.setReadTimeout(20000);conn.setRequestMethod("POST");conn.setDoOutput(true);
   conn.setRequestProperty("Authorization","Bearer "+prefs.getString("key",""));conn.setRequestProperty("Content-Type","application/octet-stream");conn.setRequestProperty("X-Filename",job.getName());conn.setRequestProperty("X-Device-Name","Focus Bridge");conn.setFixedLengthStreamingMode(job.length());
   try(OutputStream out=conn.getOutputStream();InputStream in=new FileInputStream(job)){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);}
   int code=conn.getResponseCode();if(code<200||code>=300)throw new IOException("Server returned "+code);if(!job.delete())throw new IOException("Uploaded; local cleanup pending");uploadStatus="Bill uploaded";log("Upload complete");
  }catch(Exception e){uploadStatus="Upload queued: "+e.getMessage();return;}finally{if(conn!=null)conn.disconnect();}}
 }
 @Override public void onDestroy(){running=false;try{if(client!=null)client.close();}catch(Exception ignored){}try{if(server!=null)server.close();}catch(Exception ignored){}saveCapture();uploader.shutdown();active=null;status="Stopped";log("Receiver stopped");super.onDestroy();}
}
