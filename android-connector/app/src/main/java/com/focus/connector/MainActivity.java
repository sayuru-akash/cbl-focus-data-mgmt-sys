package com.focus.connector;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import android.view.View;
import android.widget.*;
import android.graphics.Color;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class MainActivity extends Activity {
 private EditText address,key;
 private TextView status,feedback;
 private Switch compatibility;
 private boolean pendingStart=false,pendingPrinterSetup=false;
 private final Handler handler=new Handler(Looper.getMainLooper());
 private final Runnable update=new Runnable(){public void run(){
  status.setText(getString(R.string.bridge_status,BridgeService.status,BridgeService.received,BridgeService.pendingCount(getFilesDir()))+"\n"+BridgeService.connections+" connections · "+BridgeService.totalReceived+" total bytes\n"+BridgeService.uploadStatus+"\n\n"+BridgeService.diagnostics());
  handler.postDelayed(this,1000);
 }};
 @Override public void onCreate(Bundle state){super.onCreate(state);
  LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setBackgroundColor(Color.WHITE);ScrollView scroll=new ScrollView(this);scroll.addView(content);setContentView(scroll);
  int pad=(int)(24*getResources().getDisplayMetrics().density);content.setPadding(pad,pad,pad,pad);
  scroll.setOnApplyWindowInsetsListener((v,insets)->{content.setPadding(pad,pad+insets.getSystemWindowInsetTop(),pad,pad+insets.getSystemWindowInsetBottom());return insets;});
  TextView title=text(content,getString(R.string.app_name),30);title.setTextColor(Color.rgb(18,33,49));
  text(content,"v"+BuildConfig.VERSION_NAME+" · Bluetooth receiver",14);
  SharedPreferences prefs=getSharedPreferences("bridge",MODE_PRIVATE);
  if(!prefs.getBoolean("cloudDefaultApplied",false)){
   String previous=prefs.getString("url","");
   SharedPreferences.Editor edit=prefs.edit().putBoolean("cloudDefaultApplied",true);
   if(previous.isEmpty()||previous.startsWith("http://10.")||previous.startsWith("http://192.168.")||previous.matches("http://172\\.(1[6-9]|2[0-9]|3[01])\\..*"))edit.putString("url",BuildConfig.DEFAULT_SERVER_URL);
   edit.apply();
  }
  address=field(content,"Server address",prefs.getString("url",BuildConfig.DEFAULT_SERVER_URL));address.setInputType(17);
  key=field(content,"Connector key",prefs.getString("key",""));key.setInputType(129);
  compatibility=new Switch(this);compatibility.setText("Compatibility mode");compatibility.setChecked(prefs.getBoolean("compatibility",true));content.addView(compatibility);
  text(content,"Change mode while the receiver is stopped. Leave server fields blank to test Bluetooth only.",13);
  feedback=text(content,"",14);
  button(content,"Use printer name SPP-R310",v->{pendingPrinterSetup=true;preparePrinter();});
  button(content,"Start receiver",v->{pendingStart=true;start();});
  button(content,"Make discoverable",v->{if(!permissions())return;try{Intent intent=new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);intent.putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION,300);startActivity(intent);}catch(SecurityException e){message("Allow Bluetooth access first.");}catch(Exception e){message(e.getMessage());}});
  button(content,"Save bill",v->{if(BridgeService.active==null){message("Start the receiver first.");return;}BridgeService.active.saveCapture();});
  button(content,"Retry uploads",v->{if(BridgeService.active!=null)BridgeService.active.retryUploads();else message("Start the receiver first.");});
  button(content,"Stop receiver",v->{stopService(new Intent(this,BridgeService.class));});
  status=text(content,"Stopped",15);
  button(content,"Test Bluetooth to another device",v->testBluetooth());
  text(content,"For a connection test, install this APK on the CBL tablet too. Keep the receiver running on the phone, then use Test Bluetooth on the tablet.",13);
 }
 private TextView text(LinearLayout box,String s,int size){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextIsSelectable(true);t.setPadding(0,14,0,12);t.setTextColor(Color.rgb(85,101,112));box.addView(t);return t;}
 private EditText field(LinearLayout box,String label,String value){text(box,label,14);EditText e=new EditText(this);e.setSingleLine();e.setText(value);e.setTextSize(16);box.addView(e,new LinearLayout.LayoutParams(-1,-2));return e;}
 private void button(LinearLayout box,String label,View.OnClickListener action){Button b=new Button(this);b.setText(label);b.setAllCaps(false);b.setOnClickListener(action);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=10;box.addView(b,p);}
 private boolean permissions(){if(Build.VERSION.SDK_INT>=31&&(checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)!=PackageManager.PERMISSION_GRANTED||checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE)!=PackageManager.PERMISSION_GRANTED)){requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT,Manifest.permission.BLUETOOTH_ADVERTISE},10);return false;}return true;}
 @Override public void onRequestPermissionsResult(int request,String[] names,int[] grants){super.onRequestPermissionsResult(request,names,grants);if(request==10){boolean allowed=grants.length>0&&Arrays.stream(grants).allMatch(v->v==PackageManager.PERMISSION_GRANTED);boolean setup=pendingPrinterSetup,startReceiver=pendingStart;pendingPrinterSetup=pendingStart=false;if(!allowed){message("Bluetooth access is required to receive prints.");return;}if(setup)preparePrinter();else if(startReceiver)start();}}
 private void preparePrinter(){if(!permissions())return;pendingPrinterSetup=false;try{
  BluetoothAdapter bt=getSystemService(BluetoothManager.class).getAdapter();if(bt==null)throw new Exception("Bluetooth is not available.");if(!bt.isEnabled()){startActivity(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE));message("Enable Bluetooth, then tap Use printer name.");return;}
  String oldName=bt.getName();if(!PrinterProtocol.NAME.equals(oldName)){
   if(!bt.setName(PrinterProtocol.NAME))throw new Exception("Rename this phone to SPP-R310 in Bluetooth settings.");
   SharedPreferences prefs=getSharedPreferences("bridge",MODE_PRIVATE);if(!prefs.contains("originalBluetoothName"))prefs.edit().putString("originalBluetoothName",oldName).apply();
  }
  handler.postDelayed(()->{try{String actual=bt.getName();message(PrinterProtocol.NAME.equals(actual)?"Name: SPP-R310. Pair this phone again on the tablet, then start the receiver.":"Name is still "+actual+". Rename it in Bluetooth settings.");}catch(SecurityException e){message("Allow Bluetooth access first.");}},800);
  Intent discoverable=new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);discoverable.putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION,300);startActivity(discoverable);
 }catch(SecurityException e){message("Allow Bluetooth access first.");}catch(Exception e){message(e.getMessage());}}
 private void start(){if(!permissions())return;pendingStart=false;try{
  String base=address.getText().toString().trim().replaceAll("/+$","");String secret=key.getText().toString().trim();
  if(!base.isEmpty()||!secret.isEmpty()){
   URI uri=new URI(base);String host=uri.getHost();if(host==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!(uri.getPath()==null||uri.getPath().isEmpty()))throw new Exception("Enter the server address without a path.");
   boolean local=host.matches("10\\.\\d+\\.\\d+\\.\\d+")||host.matches("192\\.168\\.\\d+\\.\\d+")||host.matches("172\\.(1[6-9]|2[0-9]|3[01])\\.\\d+\\.\\d+");if(!"https".equals(uri.getScheme())&&!("http".equals(uri.getScheme())&&local))throw new Exception("Use HTTPS or the local Wi-Fi IP address.");
   if(secret.length()<20)throw new Exception("Enter the connector key from Connection in the web app.");
  }
  if(BridgeService.active!=null&&compatibility.isChecked()!=getSharedPreferences("bridge",MODE_PRIVATE).getBoolean("compatibility",true))throw new Exception("Stop the receiver before changing mode.");
  getSharedPreferences("bridge",MODE_PRIVATE).edit().putString("url",base).putString("key",secret).putBoolean("compatibility",compatibility.isChecked()).apply();
  BluetoothAdapter bt=getSystemService(BluetoothManager.class).getAdapter();if(bt==null)throw new Exception("Bluetooth is not available.");if(!bt.isEnabled()){startActivity(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE));message("Enable Bluetooth, then tap Start receiver.");return;}
  startForegroundService(new Intent(this,BridgeService.class));message(base.isEmpty()?"Bluetooth-only test. Captures stay on this device.":"Receiver starting.");
  if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},11);
 }catch(SecurityException e){message("Allow Bluetooth access first.");}catch(Exception e){message(e.getMessage());}}
 private void testBluetooth(){if(!permissions())return;try{
  BluetoothAdapter bt=getSystemService(BluetoothManager.class).getAdapter();List<BluetoothDevice> devices=new ArrayList<>(bt.getBondedDevices());if(devices.isEmpty()){message("Pair the receiver phone in Android Bluetooth settings first.");return;}
  String[] names=new String[devices.size()];for(int i=0;i<devices.size();i++)names[i]=devices.get(i).getName();
  new AlertDialog.Builder(this).setTitle("Choose the receiver phone").setItems(names,(dialog,index)->sendTest(devices.get(index),compatibility.isChecked())).setNegativeButton("Cancel",null).show();
 }catch(SecurityException e){message("Allow Bluetooth access first.");}}
 private void sendTest(BluetoothDevice device,boolean insecure){message("Connecting…");new Thread(()->{BluetoothSocket socket=null;try{
  UUID uuid=UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");socket=insecure?device.createInsecureRfcommSocketToServiceRecord(uuid):device.createRfcommSocketToServiceRecord(uuid);BluetoothSocket pending=socket;Runnable timeout=()->{try{pending.close();}catch(Exception ignored){}};handler.postDelayed(timeout,15000);
  try{socket.connect();socket.getOutputStream().write(DiagnosticProtocol.REQUEST);socket.getOutputStream().flush();message("Connected. Waiting for receiver confirmation…");
   byte[] reply=new byte[DiagnosticProtocol.ACK.length];new java.io.DataInputStream(socket.getInputStream()).readFully(reply);
   if(!DiagnosticProtocol.isAcknowledgment(reply))throw new java.io.IOException("Unexpected reply from receiver");
   message("Bluetooth test passed. Receiver confirmed delivery.");}finally{handler.removeCallbacks(timeout);}
 }catch(SecurityException e){message("Allow Bluetooth access first.");}catch(Exception e){message("Test failed: "+e.getMessage());}finally{try{if(socket!=null)socket.close();}catch(Exception ignored){}}},"focus-test").start();}
 private void message(String s){runOnUiThread(()->{feedback.setText(s);Toast.makeText(this,s,Toast.LENGTH_LONG).show();});}
 @Override public void onResume(){super.onResume();handler.post(update);}
 @Override public void onPause(){super.onPause();handler.removeCallbacks(update);}
}
