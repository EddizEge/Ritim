package app.ritim.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class RitimMediaService extends Service {
    public static final String ACTION_UPDATE = "app.ritim.mobile.media.UPDATE";
    public static final String ACTION_STOP = "app.ritim.mobile.media.STOP";
    private static final String ACTION_PREVIOUS = "app.ritim.mobile.media.PREVIOUS";
    private static final String ACTION_PLAY_PAUSE = "app.ritim.mobile.media.PLAY_PAUSE";
    private static final String ACTION_NEXT = "app.ritim.mobile.media.NEXT";
    private static final String CHANNEL_ID = "ritim_playback";
    private static final int NOTIFICATION_ID = 4821;

    private MediaSessionCompat mediaSession;
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    private String title = "Ritim";
    private String artist = "YouTube Music";
    private String artworkUrl = "";
    private Bitmap artwork;
    private boolean playing;
    private long position;
    private long duration;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Ritim oynatma", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Ritim PC üzerindeki YouTube Music oynatıcısı");
        manager.createNotificationChannel(channel);

        mediaSession = new MediaSessionCompat(this, "RitimMediaSession");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { sendMediaAction("playPause"); }
            @Override public void onPause() { sendMediaAction("playPause"); }
            @Override public void onSkipToNext() { sendMediaAction("next"); }
            @Override public void onSkipToPrevious() { sendMediaAction("previous"); }
        });
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_UPDATE : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PREVIOUS.equals(action)) sendMediaAction("previous");
        else if (ACTION_PLAY_PAUSE.equals(action)) sendMediaAction("playPause");
        else if (ACTION_NEXT.equals(action)) sendMediaAction("next");
        else if (ACTION_UPDATE.equals(action)) {
            title = intent.getStringExtra("title");
            artist = intent.getStringExtra("artist");
            playing = intent.getBooleanExtra("playing", false);
            position = intent.getLongExtra("position", 0L);
            duration = intent.getLongExtra("duration", 0L);
            String nextArtworkUrl = intent.getStringExtra("artwork");
            if (nextArtworkUrl == null) nextArtworkUrl = "";
            if (!nextArtworkUrl.equals(artworkUrl)) {
                artworkUrl = nextArtworkUrl;
                artwork = null;
                loadArtwork(nextArtworkUrl);
            }
        }
        updateSession();
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_NOT_STICKY;
    }

    private void sendMediaAction(String action) {
        Intent event = new Intent(RitimMediaPlugin.ACTION_MEDIA_EVENT);
        event.setPackage(getPackageName());
        event.putExtra("action", action);
        sendBroadcast(event);
    }

    private void updateSession() {
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration);
        if (artwork != null) metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        mediaSession.setMetadata(metadata.build());
        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, position, playing ? 1f : 0f)
            .build());
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int playIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String playLabel = playing ? "Duraklat" : "Oynat";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ritim_notification)
            .setContentTitle(title == null || title.isEmpty() ? "Ritim" : title)
            .setContentText(artist == null || artist.isEmpty() ? "YouTube Music • Ritim PC" : artist + " • Ritim PC")
            .setLargeIcon(artwork)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(android.R.drawable.ic_media_previous, "Önceki", serviceAction(ACTION_PREVIOUS, 1))
            .addAction(playIcon, playLabel, serviceAction(ACTION_PLAY_PAUSE, 2))
            .addAction(android.R.drawable.ic_media_next, "Sonraki", serviceAction(ACTION_NEXT, 3))
            .setStyle(new MediaStyle().setMediaSession(mediaSession.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
            .build();
    }

    private PendingIntent serviceAction(String action, int requestCode) {
        Intent intent = new Intent(this, RitimMediaService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void loadArtwork(String value) {
        if (value == null || value.isEmpty()) return;
        final String requestedUrl = value;
        artworkExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(requestedUrl).openConnection();
                connection.setConnectTimeout(4000);
                connection.setReadTimeout(4000);
                Bitmap bitmap = BitmapFactory.decodeStream(connection.getInputStream());
                if (requestedUrl.equals(artworkUrl) && bitmap != null) {
                    artwork = bitmap;
                    updateSession();
                    getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification());
                }
            } catch (Exception ignored) {
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    @Override
    public void onDestroy() {
        artworkExecutor.shutdownNow();
        mediaSession.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
