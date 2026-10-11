package app.ritim.mobile;

/**
 * The confirmed "Yeniden eşle" reset (RitimSecureStoragePlugin.reset): wipes
 * every stored record and deletes the Keystore key, so a key that keeps
 * failing (UnrecoverableKeyException, KeyStoreException, ProviderException)
 * cannot block the next pairing. Both steps always run; one failing does not
 * skip the other.
 *
 * Only the user's explicit confirmation may lead here. A temporary Keystore
 * failure must never reset on its own: that would destroy every record.
 *
 * Pure Java on purpose, so it runs in JVM unit tests without Android.
 */
final class SecureStorageReset {
    interface Step {
        void run() throws Exception;
    }

    static final class Result {
        final boolean recordsCleared;
        final boolean keyDeleted;
        /** Error classes only: never a key, value or token. */
        final String failure;

        private Result(boolean recordsCleared, boolean keyDeleted, String failure) {
            this.recordsCleared = recordsCleared;
            this.keyDeleted = keyDeleted;
            this.failure = failure;
        }

        boolean complete() {
            return recordsCleared && keyDeleted;
        }
    }

    private SecureStorageReset() {
    }

    static Result run(Step clearRecords, Step deleteKey) {
        StringBuilder failure = new StringBuilder();
        boolean recordsCleared = attempt(clearRecords, "kayıtlar", failure);
        boolean keyDeleted = attempt(deleteKey, "anahtar", failure);
        return new Result(recordsCleared, keyDeleted, failure.toString());
    }

    private static boolean attempt(Step step, String label, StringBuilder failure) {
        try {
            step.run();
            return true;
        } catch (Exception error) {
            if (failure.length() > 0) failure.append(", ");
            failure.append(label).append(": ").append(error.getClass().getSimpleName());
            return false;
        }
    }
}
