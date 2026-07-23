package app.ritim.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "RitimSecureStorage")
public class RitimSecureStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "app.ritim.mobile.social.session.v1";
    private static final String PREFERENCES = "ritim_secure_storage_v1";
    private static final Pattern SAFE_KEY = Pattern.compile("^[A-Za-z0-9._-]{1,80}$");
    private static final int IV_LENGTH = 12;
    private static final int MAX_VALUE_BYTES = 32 * 1024;
    private final SecureRandom secureRandom = new SecureRandom();

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
            byte[] iv = new byte[IV_LENGTH];
            secureRandom.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] payload = ByteBuffer.allocate(1 + iv.length + ciphertext.length)
                .put((byte) 1)
                .put(iv)
                .put(ciphertext)
                .array();
            preferences().edit().putString(key, Base64.encodeToString(payload, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Android güvenli depolama yazma hatası.", error);
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
            byte[] payload = Base64.decode(encoded, Base64.NO_WRAP);
            if (payload.length <= 1 + IV_LENGTH || payload[0] != 1) {
                throw new IllegalStateException("Güvenli depolama sürümü geçersiz.");
            }
            byte[] iv = new byte[IV_LENGTH];
            byte[] ciphertext = new byte[payload.length - 1 - IV_LENGTH];
            System.arraycopy(payload, 1, iv, 0, IV_LENGTH);
            System.arraycopy(payload, 1 + IV_LENGTH, ciphertext, 0, ciphertext.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
            result.put("value", new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            preferences().edit().remove(key).apply();
            call.reject("Android güvenli depolama okuma hatası.", error);
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
