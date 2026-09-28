package app.ritim.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.URI;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "RitimUpdate")
public class RitimUpdatePlugin extends Plugin {
    private static final String PREFERENCES = "ritim_update_v1";
    private static final String DOWNLOAD_ID = "download_id";
    private static final String TARGET_VERSION = "target_version";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;
    private static final Pattern SAFE_FILE = Pattern.compile("^[A-Za-z0-9._-]{1,120}\\.apk$");
    private static final Pattern SAFE_VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?$");
    private final Object downloadLock = new Object();

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private DownloadManager manager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private File targetFile(String version) {
        File directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        return new File(directory == null ? getContext().getCacheDir() : directory, "Ritim-" + version + ".apk");
    }

    private File privateTargetFile(String version) {
        return new File(new File(getContext().getCacheDir(), "updates"), "Ritim-" + version + ".apk");
    }

    private void deleteTargetFile(String version) {
        if (!SAFE_VERSION.matcher(version).matches()) return;
        File file = targetFile(version);
        if (file.exists()) file.delete();
        File privateFile = privateTargetFile(version);
        if (privateFile.exists()) privateFile.delete();
    }

    private long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private Set<String> signerDigests(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            signatures = info.signingInfo.hasMultipleSigners()
                ? info.signingInfo.getApkContentsSigners()
                : info.signingInfo.getSigningCertificateHistory();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) throw new SecurityException("APK imzası bulunamadı.");
        Set<String> result = new HashSet<>();
        for (Signature signature : signatures) {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray());
            StringBuilder value = new StringBuilder();
            for (byte item : digest) value.append(String.format(Locale.ROOT, "%02x", item));
            result.add(value.toString());
        }
        return result;
    }

    private void verifyDownloadedApk(File apk, String version) throws Exception {
        if (!apk.isFile() || apk.length() <= 0) throw new SecurityException("İndirilen APK dosyası bulunamadı.");
        PackageManager packageManager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo archive = packageManager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = packageManager.getPackageInfo(getContext().getPackageName(), flags);
        if (archive == null
            || !getContext().getPackageName().equals(archive.packageName)
            || !version.equals(archive.versionName)
            || versionCode(archive) <= versionCode(installed)
            || !signerDigests(installed).equals(signerDigests(archive))) {
            throw new SecurityException("APK kimliği, sürümü veya imzası mevcut Ritim kurulumu ile eşleşmiyor.");
        }
    }

    private File copyDownloadedApkToPrivateCache(long id, String version) throws Exception {
        Uri source = manager().getUriForDownloadedFile(id);
        if (source == null) throw new SecurityException("İndirilen APK adresi bulunamadı.");
        File destination = privateTargetFile(version);
        File directory = destination.getParentFile();
        if (directory == null || (!directory.isDirectory() && !directory.mkdirs())) {
            throw new SecurityException("Güvenli APK önbelleği oluşturulamadı.");
        }
        File temporary = new File(directory, destination.getName() + ".tmp");
        if (temporary.exists()) temporary.delete();
        long copied = 0;
        try (InputStream input = getContext().getContentResolver().openInputStream(source);
             FileOutputStream output = new FileOutputStream(temporary)) {
            if (input == null) throw new SecurityException("İndirilen APK okunamadı.");
            byte[] buffer = new byte[64 * 1024];
            int length;
            while ((length = input.read(buffer)) != -1) {
                copied += length;
                if (copied > MAX_APK_BYTES) throw new SecurityException("APK güvenli boyut sınırını aşıyor.");
                output.write(buffer, 0, length);
            }
            output.getFD().sync();
        } catch (Exception error) {
            temporary.delete();
            throw error;
        }
        if (copied <= 0) {
            temporary.delete();
            throw new SecurityException("İndirilen APK boş.");
        }
        if (destination.exists() && !destination.delete()) {
            temporary.delete();
            throw new SecurityException("Eski güvenli APK önbelleği temizlenemedi.");
        }
        if (!temporary.renameTo(destination)) {
            temporary.delete();
            throw new SecurityException("APK güvenli önbelleğe taşınamadı.");
        }
        return destination;
    }

    private void clearStoredDownload(long id, String version) {
        if (id > 0) manager().remove(id);
        deleteTargetFile(version);
        preferences().edit().remove(DOWNLOAD_ID).remove(TARGET_VERSION).commit();
    }

    private boolean safeDownloadUrl(String value) {
        try {
            URI uri = new URI(value);
            String path = uri.getPath() == null ? "" : uri.getPath().toLowerCase(Locale.ROOT);
            return "https".equalsIgnoreCase(uri.getScheme())
                && "github.com".equalsIgnoreCase(uri.getHost())
                && uri.getPort() == -1
                && uri.getUserInfo() == null
                && uri.getQuery() == null
                && uri.getFragment() == null
                && path.startsWith("/eddizege/ritim/releases/download/")
                && path.endsWith(".apk");
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean urlMatchesVersion(String value, String version) {
        try {
            String path = new URI(value).getPath();
            String marker = "/releases/download/";
            int markerIndex = path == null ? -1 : path.toLowerCase(Locale.ROOT).indexOf(marker);
            if (markerIndex < 0) return false;
            String remainder = path.substring(markerIndex + marker.length());
            String tag = remainder.split("/", 2)[0];
            if (tag.startsWith("v") || tag.startsWith("V")) tag = tag.substring(1);
            return tag.equalsIgnoreCase(version);
        } catch (Exception ignored) {
            return false;
        }
    }

    private JSObject idleStatus() {
        JSObject result = new JSObject();
        result.put("status", "idle");
        result.put("downloadedBytes", 0);
        result.put("totalBytes", 0);
        result.put("percent", 0);
        result.put("version", "");
        return result;
    }

    private JSObject query(long id) {
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (Cursor cursor = manager().query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                String version = preferences().getString(TARGET_VERSION, "");
                deleteTargetFile(version);
                preferences().edit().remove(DOWNLOAD_ID).remove(TARGET_VERSION).apply();
                return idleStatus();
            }
            int androidStatus = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long downloaded = Math.max(0, cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
            long total = Math.max(0, cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            String status = androidStatus == DownloadManager.STATUS_SUCCESSFUL ? "downloaded"
                : androidStatus == DownloadManager.STATUS_RUNNING ? "downloading"
                : androidStatus == DownloadManager.STATUS_PENDING ? "pending"
                : androidStatus == DownloadManager.STATUS_PAUSED ? "paused"
                : androidStatus == DownloadManager.STATUS_FAILED ? "error" : "idle";
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("downloadedBytes", downloaded);
            result.put("totalBytes", total);
            result.put("percent", total > 0 ? Math.min(100, Math.round(downloaded * 100.0 / total)) : 0);
            result.put("reason", reason);
            result.put("version", preferences().getString(TARGET_VERSION, ""));
            return result;
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "Ritim-update.apk");
        String version = call.getString("version", "");
        if (!safeDownloadUrl(url) || !SAFE_FILE.matcher(fileName).matches() || !SAFE_VERSION.matcher(version).matches()
            || !fileName.equals("Ritim-" + version + ".apk")
            || !urlMatchesVersion(url, version)) {
            call.reject("Güvenli Ritim APK adresi geçersiz.");
            return;
        }
        synchronized (downloadLock) {
            long previous = preferences().getLong(DOWNLOAD_ID, -1);
            String previousVersion = preferences().getString(TARGET_VERSION, "");
            if (previous > 0) {
                JSObject current = query(previous);
                String currentStatus = current.getString("status", "idle");
                if (version.equals(previousVersion) && !"idle".equals(currentStatus) && !"error".equals(currentStatus)) {
                    call.resolve(current);
                    return;
                }
                clearStoredDownload(previous, previousVersion);
            }
            try {
                deleteTargetFile(version);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                    .setTitle("Ritim güncellemesi")
                    .setDescription(fileName)
                    .setMimeType(APK_MIME)
                    .setAllowedOverRoaming(false)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);
                long id = manager().enqueue(request);
                preferences().edit().putLong(DOWNLOAD_ID, id).putString(TARGET_VERSION, version).commit();
                call.resolve(query(id));
            } catch (Exception error) {
                call.reject("Ritim APK indirmesi başlatılamadı.", error);
            }
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        synchronized (downloadLock) {
            long id = preferences().getLong(DOWNLOAD_ID, -1);
            call.resolve(id > 0 ? query(id) : idleStatus());
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        synchronized (downloadLock) {
            long id = preferences().getLong(DOWNLOAD_ID, -1);
            String version = preferences().getString(TARGET_VERSION, "");
            clearStoredDownload(id, version);
            call.resolve();
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        synchronized (downloadLock) {
            long id = preferences().getLong(DOWNLOAD_ID, -1);
            String version = preferences().getString(TARGET_VERSION, "");
            if (id <= 0 || !SAFE_VERSION.matcher(version).matches() || !"downloaded".equals(query(id).getString("status", "idle"))) {
                call.reject("Kuruluma hazır Ritim APK dosyası bulunamadı.");
                return;
            }
            File privateApk;
            try {
                privateApk = copyDownloadedApkToPrivateCache(id, version);
                verifyDownloadedApk(privateApk, version);
            } catch (Exception integrityError) {
                clearStoredDownload(id, version);
                call.reject("Ritim APK güvenlik doğrulamasından geçemedi; dosya temizlendi.", "UPDATE_APK_INVALID", integrityError);
                return;
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                    settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(settingsIntent);
                    JSObject result = new JSObject();
                    result.put("openedInstaller", false);
                    result.put("openedSettings", true);
                    call.resolve(result);
                    return;
                }
                Uri apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    privateApk
                );
                Intent installIntent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(apkUri, APK_MIME)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(installIntent);
                JSObject result = new JSObject();
                result.put("openedInstaller", true);
                result.put("openedSettings", false);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Android kurulum ekranı açılamadı: " + error.getMessage(), error);
            }
        }
    }
}
