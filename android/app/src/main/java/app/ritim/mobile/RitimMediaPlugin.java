package app.ritim.mobile;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "RitimMedia",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class RitimMediaPlugin extends Plugin {
    public static final String ACTION_MEDIA_EVENT = "app.ritim.mobile.MEDIA_EVENT";

    private final BroadcastReceiver mediaReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            JSObject payload = new JSObject();
            payload.put("action", intent.getStringExtra("action"));
            notifyListeners("mediaAction", payload, true);
        }
    };

    @Override
    public void load() {
        super.load();
        ContextCompat.registerReceiver(
            getContext(),
            mediaReceiver,
            new IntentFilter(ACTION_MEDIA_EVENT),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(mediaReceiver); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent intent = new Intent(getContext(), RitimMediaService.class);
        intent.setAction(RitimMediaService.ACTION_UPDATE);
        intent.putExtra("title", call.getString("title", "Ritim"));
        intent.putExtra("artist", call.getString("artist", "YouTube Music"));
        intent.putExtra("artwork", call.getString("artwork", ""));
        intent.putExtra("playing", Boolean.TRUE.equals(call.getBoolean("playing", false)));
        intent.putExtra("position", call.getLong("position", 0L));
        intent.putExtra("duration", call.getLong("duration", 0L));
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), RitimMediaService.class);
        intent.setAction(RitimMediaService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve();
            return;
        }
        if (getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        call.resolve();
    }
}
