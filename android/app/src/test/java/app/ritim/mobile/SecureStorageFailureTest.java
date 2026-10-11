package app.ritim.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.security.InvalidKeyException;
import java.security.KeyStoreException;
import java.security.ProviderException;
import java.security.UnrecoverableKeyException;

import javax.crypto.AEADBadTagException;

import org.junit.Test;

public class SecureStorageFailureTest {
    // Stand-ins for Android's keystore exceptions (android.jar only has stubs
    // in JVM tests); classification goes by class name, as on a device.
    static class KeyPermanentlyInvalidatedException extends InvalidKeyException {
    }

    static class UserNotAuthenticatedException extends InvalidKeyException {
    }

    @Test
    public void transientKeystoreErrorsKeepTheRecord() {
        Throwable[] transientErrors = {
            new UserNotAuthenticatedException(),
            new KeyStoreException("Keystore locked"),
            new ProviderException("Keystore operation failed", new KeyStoreException("busy")),
            new UnrecoverableKeyException("entry unavailable"),
            new InvalidKeyException("key not yet valid"),
            new IllegalStateException("anything else"),
            new NullPointerException(),
        };
        for (Throwable error : transientErrors) {
            SecureStorageFailure.Kind kind = SecureStorageFailure.classify(error);
            assertEquals(error.toString(), SecureStorageFailure.Kind.TRANSIENT, kind);
            assertFalse(error.toString(), SecureStorageFailure.discardsRecord(kind));
        }
    }

    @Test
    public void badTagAndMalformedRecordAreDiscarded() {
        assertEquals(SecureStorageFailure.Kind.CORRUPT_RECORD, SecureStorageFailure.classify(new AEADBadTagException("tag mismatch")));
        assertEquals(
            SecureStorageFailure.Kind.CORRUPT_RECORD,
            SecureStorageFailure.classify(new ProviderException("wrapped", new AEADBadTagException("tag mismatch")))
        );
        assertEquals(
            SecureStorageFailure.Kind.CORRUPT_RECORD,
            SecureStorageFailure.classify(new SecureStorageFailure.CorruptRecordException("bad base64", new IllegalArgumentException()))
        );
        assertTrue(SecureStorageFailure.discardsRecord(SecureStorageFailure.Kind.CORRUPT_RECORD));
    }

    @Test
    public void permanentlyInvalidatedKeyIsDiscarded() {
        assertEquals(SecureStorageFailure.Kind.KEY_INVALIDATED, SecureStorageFailure.classify(new KeyPermanentlyInvalidatedException()));
        assertEquals(
            SecureStorageFailure.Kind.KEY_INVALIDATED,
            SecureStorageFailure.classify(new IllegalStateException("init", new KeyPermanentlyInvalidatedException()))
        );
        assertTrue(SecureStorageFailure.discardsRecord(SecureStorageFailure.Kind.KEY_INVALIDATED));
    }

    @Test
    public void selfReferencingOrDeepCauseChainsDoNotLoop() {
        Throwable deep = new IllegalStateException("root");
        for (int i = 0; i < 20; i++) deep = new IllegalStateException("level " + i, deep);
        assertEquals(SecureStorageFailure.Kind.TRANSIENT, SecureStorageFailure.classify(deep));
        assertEquals(SecureStorageFailure.Kind.TRANSIENT, SecureStorageFailure.classify(null));
    }

    @Test
    public void parsesVersionOneRecords() throws Exception {
        byte[] payload = new byte[1 + 12 + 20];
        payload[0] = 1;
        for (int i = 1; i < payload.length; i++) payload[i] = (byte) i;
        SecureStorageFailure.Record record = SecureStorageFailure.parse(payload);
        assertEquals(12, record.iv.length);
        assertEquals(20, record.ciphertext.length);
        assertEquals(1, record.iv[0]);
        assertArrayEquals(new byte[] { 13, 14, 15 }, java.util.Arrays.copyOf(record.ciphertext, 3));
    }

    @Test
    public void malformedPayloadsAreCorruptRecords() {
        byte[] wrongVersion = new byte[40];
        wrongVersion[0] = 2;
        byte[][] malformed = { null, new byte[0], new byte[13], wrongVersion };
        for (byte[] payload : malformed) {
            SecureStorageFailure.CorruptRecordException error = assertThrows(
                SecureStorageFailure.CorruptRecordException.class,
                () -> SecureStorageFailure.parse(payload)
            );
            assertEquals(SecureStorageFailure.Kind.CORRUPT_RECORD, SecureStorageFailure.classify(error));
        }
    }
}
