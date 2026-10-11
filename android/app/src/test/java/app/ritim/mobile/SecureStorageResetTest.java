package app.ritim.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.security.KeyStoreException;
import java.security.ProviderException;
import java.security.UnrecoverableKeyException;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class SecureStorageResetTest {
    @Test
    public void clearsRecordsThenDeletesKey() {
        List<String> calls = new ArrayList<>();
        SecureStorageReset.Result result = SecureStorageReset.run(
            () -> calls.add("records"),
            () -> calls.add("key")
        );
        assertEquals(List.of("records", "key"), calls);
        assertTrue(result.complete());
        assertEquals("", result.failure);
    }

    @Test
    public void aFailingStepDoesNotSkipTheOther() {
        List<String> calls = new ArrayList<>();
        SecureStorageReset.Result recordsFailed = SecureStorageReset.run(
            () -> { throw new IllegalStateException("commit failed"); },
            () -> calls.add("key")
        );
        assertEquals(List.of("key"), calls);
        assertFalse(recordsFailed.recordsCleared);
        assertTrue(recordsFailed.keyDeleted);
        assertFalse(recordsFailed.complete());

        SecureStorageReset.Result keyFailed = SecureStorageReset.run(
            () -> calls.add("records"),
            () -> { throw new ProviderException("Keystore operation failed", new KeyStoreException("busy")); }
        );
        assertTrue(keyFailed.recordsCleared);
        assertFalse(keyFailed.keyDeleted);
        assertEquals("anahtar: ProviderException", keyFailed.failure);
    }

    @Test
    public void failureNamesOnlyErrorClassesNeverMessages() {
        String secret = "token-abc123";
        SecureStorageReset.Result result = SecureStorageReset.run(
            () -> { throw new UnrecoverableKeyException(secret); },
            () -> { throw new KeyStoreException(secret); }
        );
        assertEquals("kayıtlar: UnrecoverableKeyException, anahtar: KeyStoreException", result.failure);
        assertFalse(result.failure.contains(secret));
    }
}
