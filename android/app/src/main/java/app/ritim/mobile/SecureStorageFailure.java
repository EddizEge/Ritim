package app.ritim.mobile;

import javax.crypto.AEADBadTagException;

/**
 * Decides what a failed secure storage read means. Only a record that can
 * never be read again may be discarded; anything else (Keystore locked or busy,
 * user not authenticated, provider errors) keeps the record and is reported
 * to JavaScript as a temporary failure.
 *
 * Pure Java on purpose, so it runs in JVM unit tests without Android.
 */
final class SecureStorageFailure {
    enum Kind {
        /** Keystore temporarily unusable: keep the record, report the error. */
        TRANSIENT,
        /** The stored bytes are malformed or fail the GCM tag check. */
        CORRUPT_RECORD,
        /** The Keystore key is permanently invalid; nothing it sealed can be opened. */
        KEY_INVALIDATED
    }

    /** A stored payload that is not a version 1 record. */
    static final class CorruptRecordException extends Exception {
        CorruptRecordException(String message) {
            super(message);
        }

        CorruptRecordException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    static final byte RECORD_VERSION = 1;
    static final int IV_LENGTH = 12;
    // Android's class; matched by name so the JVM tests do not need it.
    private static final String KEY_INVALIDATED_CLASS = "KeyPermanentlyInvalidatedException";
    private static final int MAX_CAUSE_DEPTH = 8;

    private SecureStorageFailure() {
    }

    static Kind classify(Throwable error) {
        Throwable current = error;
        for (int depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (current instanceof CorruptRecordException || current instanceof AEADBadTagException) {
                return Kind.CORRUPT_RECORD;
            }
            if (isNamed(current.getClass(), KEY_INVALIDATED_CLASS)) {
                return Kind.KEY_INVALIDATED;
            }
            if (current.getCause() == current) break;
            current = current.getCause();
        }
        return Kind.TRANSIENT;
    }

    static boolean discardsRecord(Kind kind) {
        return kind != Kind.TRANSIENT;
    }

    private static boolean isNamed(Class<?> type, String simpleName) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            if (simpleName.equals(current.getSimpleName())) return true;
        }
        return false;
    }

    /** Version byte, 12-byte IV, then ciphertext with its 16-byte tag. */
    static final class Record {
        final byte[] iv;
        final byte[] ciphertext;

        private Record(byte[] iv, byte[] ciphertext) {
            this.iv = iv;
            this.ciphertext = ciphertext;
        }
    }

    static Record parse(byte[] payload) throws CorruptRecordException {
        if (payload == null || payload.length <= 1 + IV_LENGTH || payload[0] != RECORD_VERSION) {
            throw new CorruptRecordException("Güvenli depolama kaydının biçimi geçersiz.");
        }
        byte[] iv = new byte[IV_LENGTH];
        byte[] ciphertext = new byte[payload.length - 1 - IV_LENGTH];
        System.arraycopy(payload, 1, iv, 0, IV_LENGTH);
        System.arraycopy(payload, 1 + IV_LENGTH, ciphertext, 0, ciphertext.length);
        return new Record(iv, ciphertext);
    }
}
