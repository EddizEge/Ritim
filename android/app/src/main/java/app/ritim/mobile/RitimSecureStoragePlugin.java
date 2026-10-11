package app.ritim.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "RitimSecureStorage")
public class RitimSecureStoragePlugin extends Plugin {
    private static final String TAG = "RitimSecureStorage";
    // JavaScript retries or reports this; the record is kept.
    static final String UNAVAILABLE_CODE = "SECURE_STORAGE_UNAVAILABLE";
    private static final String KEY_ALIAS = "app.ritim.mobile.social.session.v1";
    private static final String PREFERENCES = "ritim_secure_storage_v1";
    private static final Pattern SAFE_KEY = Pattern.compile("^[A-Za-z0-9._-]{1,80}$");
    private static final int IV_LENGTH = SecureStorageFailure.IV_LENGTH;
    private static final int MAX_VALUE_BYTES = 32 * 1024;
    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore"
            );
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    // A permanently invalidated key can neither open old records nor seal new
    // ones; the next secretKey() call creates a fresh one.
    private void deleteSecretKey() {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            keyStore.deleteEntry(KEY_ALIAS);
        } catch (Exception error) {
            Log.w(TAG, "Geçersiz Keystore anahtarı silinemedi (" + error.getClass().getSimpleName() + ").");
        }
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_LENGTH) {
            throw new IllegalStateException("Android Keystore geçersiz bir IV üretti.");
        }
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] payload = ByteBuffer.allocate(1 + iv.length + ciphertext.length)
            .put(SecureStorageFailure.RECORD_VERSION)
            .put(iv)
            .put(ciphertext)
            .array();
        return Base64.encodeToString(payload, Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        byte[] payload;
        try {
            payload = Base64.decode(encoded, Base64.NO_WRAP);
        } catch (IllegalArgumentException error) {
            throw new SecureStorageFailure.CorruptRecordException("Güvenli depolama kaydı çözülemedi.", error);
        }
        SecureStorageFailure.Record record = SecureStorageFailure.parse(payload);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, record.iv));
        return new String(cipher.doFinal(record.ciphertext), StandardCharsets.UTF_8);
    }

    private String requiredKey(PluginCall call) {
        String key = call.getString("key", "");
        if (!SAFE_KEY.matcher(key).matches()) {
            call.reject("Güvenli depolama anahtarı geçersiz.");
            return null;
        }
        return key;
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = requiredKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > MAX_VALUE_BYTES) {
            call.reject("Güvenli depolama değeri geçersiz.");
            return;
        }
        try {
            String encoded;
            try {
                encoded = encrypt(value);
            } catch (Exception error) {
                if (SecureStorageFailure.classify(error) != SecureStorageFailure.Kind.KEY_INVALIDATED) throw error;
                Log.w(TAG, "Keystore anahtarı kalıcı geçersiz; yeni anahtarla yazılıyor.");
                deleteSecretKey();
                encoded = encrypt(value);
            }
            preferences().edit().putString(key, encoded).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Android güvenli depolama yazma hatası.", UNAVAILABLE_CODE, error);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = requiredKey(call);
        if (key == null) return;
        String encoded = preferences().getString(key, null);
        JSObject result = new JSObject();
        if (encoded == null) {
            result.put("value", null);
            call.resolve(result);
            return;
        }
        try {
            result.put("value", decrypt(encoded));
            call.resolve(result);
        } catch (Exception error) {
            SecureStorageFailure.Kind kind = SecureStorageFailure.classify(error);
            // Only the error class is logged: never the key's value or token.
            if (!SecureStorageFailure.discardsRecord(kind)) {
                Log.w(TAG, "Güvenli depolama geçici olarak okunamadı (" + error.getClass().getSimpleName() + "); kayıt korunuyor: " + key);
                call.reject("Android güvenli depolama şu an okunamadı.", UNAVAILABLE_CODE, error);
                return;
            }
            Log.w(TAG, "Güvenli depolama kaydı kalıcı bozuk (" + kind + ", " + error.getClass().getSimpleName() + "); kayıt silindi: " + key);
            preferences().edit().remove(key).apply();
            if (kind == SecureStorageFailure.Kind.KEY_INVALIDATED) deleteSecretKey();
            // The record is gone for good: "no record" is now the truth.
            result.put("value", null);
            result.put("discarded", true);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = requiredKey(call);
        if (key == null) return;
        preferences().edit().remove(key).apply();
        call.resolve();
    }
}
