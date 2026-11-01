package com.hikichi.bizkessan;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 美図決算 β
 * 画面はアプリ内のHTML。数字はGitHubに置いた公開データを画面側で読む。
 * ここでは画像の保存と共有だけを受け持つ。
 */
public class MainActivity extends Activity {

    private static final String START = "https://appassets.androidplatform.net/assets/index.html";
    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String u = req.getUrl().toString();
                if (u.startsWith("https://appassets.androidplatform.net/")) return false;
                // noteなど外のページは、スマホのブラウザで開く
                if (u.startsWith("https://")) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception e) { /* 開けなくても続ける */ }
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(START);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private void toast(final String msg) {
        runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_LONG).show());
    }

    // 共有用の一時ファイル（保存に失敗したときの逃げ道にも使う）
    private Uri tempFile(byte[] png, String name) throws Exception {
        File dir = new File(getCacheDir(), "share");
        dir.mkdirs();
        File f = new File(dir, name);
        try (FileOutputStream os = new FileOutputStream(f)) { os.write(png); }
        return FileProvider.getUriForFile(MainActivity.this, "com.hikichi.bizkessan.files", f);
    }

    private void openShare(Uri uri, String title) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("image/png");
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        runOnUiThread(() -> startActivity(Intent.createChooser(send, title)));
    }

    private class Bridge {
        @JavascriptInterface
        public String saveImage(String b64, String name) {
            byte[] png;
            try {
                png = Base64.decode(b64, Base64.DEFAULT);
                if (png.length < 100) throw new Exception("画像が空でした");
            } catch (Exception e) {
                String m = "画像を作れませんでした（" + e.getMessage() + "）";
                toast(m); return m;
            }
            Uri uri = null;
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/BizKessan");
                v.put(MediaStore.Images.Media.IS_PENDING, 1);
                uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("保存先を作れませんでした");
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) throw new Exception("保存先を開けませんでした");
                    os.write(png);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                String m = "保存しました：写真アプリの「BizKessan」フォルダ（" + name + "）";
                toast(m); return m;
            } catch (Exception e) {
                if (uri != null) { try { getContentResolver().delete(uri, null, null); } catch (Exception ignore) { } }
                // 端末の都合で保存できないときは、共有の画面から「ファイルに保存」などを選べるようにする
                try {
                    openShare(tempFile(png, name), "保存先を選ぶ");
                    String m = "直接保存できなかったため、保存先を選ぶ画面を開きました（" + e.getMessage() + "）";
                    toast(m); return m;
                } catch (Exception e2) {
                    String m = "画像を保存できませんでした（" + e.getMessage() + "）";
                    toast(m); return m;
                }
            }
        }

        @JavascriptInterface
        public String shareImage(String b64, String name) {
            try {
                byte[] png = Base64.decode(b64, Base64.DEFAULT);
                if (png.length < 100) throw new Exception("画像が空でした");
                openShare(tempFile(png, name), "共有する");
                return "";
            } catch (Exception e) {
                String m = "共有できませんでした（" + e.getMessage() + "）";
                toast(m); return m;
            }
        }
    }
}
