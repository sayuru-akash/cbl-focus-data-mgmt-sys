package com.focus.connector;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.*;
import android.os.Bundle;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
import org.json.JSONObject;
import org.json.JSONArray;

/** Sends only the user-selected application's installed APK files to the local Mac. */
public class ExportAppActivity extends Activity {
    private TextView status;
    private ListView list;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int)(24 * getResources().getDisplayMetrics().density);
        content.setPadding(padding,padding,padding,padding);
        content.setOnApplyWindowInsetsListener((view,insets)-> {
            content.setPadding(padding,padding+insets.getSystemWindowInsetTop(),padding,padding+insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView heading = new TextView(this);heading.setText("Send CBL app");heading.setTextSize(26);content.addView(heading);
        status = new TextView(this);status.setText("Choose CBL Focus. Its app package will be sent to your Mac over Wi-Fi.");
        status.setPadding(0,padding,0,padding);status.setTextSize(15);status.setTextIsSelectable(true);content.addView(status);
        list = new ListView(this);content.addView(list,new LinearLayout.LayoutParams(-1,0,1));setContentView(content);
        if(BuildConfig.TRANSFER_URL.isEmpty()||BuildConfig.TRANSFER_TOKEN.isEmpty()) {status.setText("Install the transfer-enabled build from your Mac.");return;}
        loadApps();
    }

    private void loadApps() {
        PackageManager pm = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        Map<String,String> labels = new HashMap<>();
        for (ResolveInfo result : pm.queryIntentActivities(launcher,0)) {
            String pkg = result.activityInfo.packageName;
            if (!pkg.equals(getPackageName())) labels.put(pkg,result.loadLabel(pm).toString());
        }
        List<String> packages = new ArrayList<>(labels.keySet());
        packages.sort(Comparator.<String>comparingInt(pkg -> {
            String name=(labels.get(pkg)+" "+pkg).toLowerCase(Locale.ROOT);
            return name.contains("cbl")||name.contains("focus")?0:1;
        }).thenComparing(pkg -> labels.get(pkg),String.CASE_INSENSITIVE_ORDER));
        List<String> rows = new ArrayList<>();for(String pkg:packages)rows.add(labels.get(pkg)+"\n"+pkg);
        list.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_list_item_1,rows));
        list.setOnItemClickListener((parent,view,position,id)-> {
            list.setEnabled(false);status.setText("Preparing app package…");
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            new Thread(()->sendPackage(packages.get(position)),"focus-package-transfer").start();
        });
        if(rows.isEmpty())status.setText("Open this screen on the CBL tablet.");
    }

    private void sendPackage(String pkg) {
        File archive=null,staging=null;boolean confirmed=false;HttpURLConnection connection=null;
        try {
            // Check the receiver before reading or compressing the selected app package.
            URI destination=new URI(BuildConfig.TRANSFER_URL);
            if(!"http".equals(destination.getScheme())||!destination.getHost().matches("10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2[0-9]|3[01])\\.\\d+\\.\\d+"))throw new IOException("This build needs a local Wi-Fi receiver address");
            HttpURLConnection check=(HttpURLConnection)new URL(new URL(BuildConfig.TRANSFER_URL),"/health").openConnection();
            check.setInstanceFollowRedirects(false);check.setConnectTimeout(10000);check.setReadTimeout(10000);
            try{if(check.getResponseCode()!=200)throw new IOException("Mac receiver is not ready");}finally{check.disconnect();}
            archive=new File(getCacheDir(),"focus-package-"+pkg+"-"+getPackageManager().getPackageInfo(pkg,0).getLongVersionCode()+".zip");
            if(!archive.isFile()){staging=File.createTempFile("focus-app-",".partial",getCacheDir());writePackage(pkg,staging);if(!staging.renameTo(archive))throw new IOException("Could not prepare app package");staging=null;}
            if(archive.length()>256L*1024*1024)throw new IOException("App package exceeds 256 MB");
            connection=(HttpURLConnection)new URL(BuildConfig.TRANSFER_URL).openConnection();connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);connection.setReadTimeout(60000);connection.setRequestMethod("POST");connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type","application/zip");connection.setRequestProperty("Authorization","Bearer "+BuildConfig.TRANSFER_TOKEN);connection.setFixedLengthStreamingMode(archive.length());
            progress("Sending app package…");
            try(InputStream input=new BufferedInputStream(new FileInputStream(archive));OutputStream output=connection.getOutputStream()) {
                byte[] buffer=new byte[65536];int count,last=-1;long sent=0,total=archive.length();
                while((count=input.read(buffer))!=-1){output.write(buffer,0,count);sent+=count;int percent=(int)(sent*100/total);if(percent!=last){last=percent;progress("Sending to Mac · "+percent+"%");}}
                output.flush();
            }
            int code=connection.getResponseCode();
            if(code!=200){String reason="Receiver returned "+code;InputStream error=connection.getErrorStream();if(error!=null){byte[] text=new byte[2048];int length=error.read(text);error.close();if(length>0)try{reason=new JSONObject(new String(text,0,length,StandardCharsets.UTF_8)).optString("error",reason);}catch(Exception ignored){}}throw new IOException(reason);}
            try(InputStream input=connection.getInputStream();ByteArrayOutputStream reply=new ByteArrayOutputStream()){byte[] chunk=new byte[1024];int length;while((length=input.read(chunk))!=-1){if(reply.size()+length>4096)throw new IOException("Unexpected receiver response");reply.write(chunk,0,length);}if(!new JSONObject(reply.toString("UTF-8")).optBoolean("received"))throw new IOException("Receiver did not confirm delivery");}
            confirmed=true;
            progress("Received by your Mac. You can return to CBL Focus.");
        } catch(Exception error) {progress("Could not send: "+error.getMessage()+"\nKeep both devices on the same Wi-Fi, then tap CBL Focus to retry.");}
        finally {if(connection!=null)connection.disconnect();if(confirmed&&archive!=null)archive.delete();if(staging!=null)staging.delete();runOnUiThread(()->{list.setEnabled(true);getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);});}
    }

    private void progress(String text){runOnUiThread(()->status.setText(text));}
    private void writePackage(String pkg,File archive)throws Exception {
        PackageManager pm=getPackageManager();ApplicationInfo app=pm.getApplicationInfo(pkg,0);PackageInfo info=pm.getPackageInfo(pkg,0);
        List<String> paths=new ArrayList<>();paths.add(app.sourceDir);if(app.splitSourceDirs!=null)Collections.addAll(paths,app.splitSourceDirs);
        JSONObject metadata=new JSONObject();metadata.put("package",pkg);metadata.put("label",app.loadLabel(pm).toString());metadata.put("version",info.versionName);metadata.put("versionCode",info.getLongVersionCode());JSONArray entries=new JSONArray();
        try(ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(archive)))) {
            byte[] buffer=new byte[65536];
            for(int i=0;i<paths.size();i++) {
                // Read only installed code paths returned by PackageManager. Never inspect dataDir.
                File source=new File(paths.get(i));String name=i==0?"base.apk":"split-"+i+".apk";
                if(!source.isFile()||source.length()==0)throw new IOException("Installed APK is not readable");
                JSONObject entry=new JSONObject();entry.put("entry",name);entry.put("originalName",source.getName());entry.put("bytes",source.length());entries.put(entry);
                zip.putNextEntry(new ZipEntry(name));try(InputStream input=new BufferedInputStream(new FileInputStream(source))){int count;while((count=input.read(buffer))!=-1)zip.write(buffer,0,count);}zip.closeEntry();
            }
            metadata.put("files",entries);zip.putNextEntry(new ZipEntry("app-info.json"));zip.write(metadata.toString(2).getBytes(StandardCharsets.UTF_8));zip.closeEntry();
        }
    }
}
